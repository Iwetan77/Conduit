// Circle StableFX API client
// API base: https://api.circle.com/v1/exchange/stablefx/
// Auth: Bearer token — get your API key at https://console.circle.com
//
// Full taker flow (implemented here):
//   1. POST /quotes         → quoteId + EIP-712 typedData (trade creation)
//   2. Sign trade typedData with wallet
//   3. POST /trades         → contractTradeId
//   4. POST /signatures/funding/presign → funding typedData (SingleTradeWitness)
//   5. Sign funding typedData with wallet
//   6. POST /fund (OR submit Permit2 directly onchain)
//   7. GET /trades/{id}     → verify status = "taker_funded"

import type { Address, Currency } from "./types.js";
import { ARC_TESTNET } from "./constants.js";

const STABLEFX_BASE = "https://api.circle.com/v1/exchange/stablefx";

// ── API Types ─────────────────────────────────────────────────────────────────

export interface StableFXQuoteRequest {
  fromCurrency: Currency;
  toCurrency: Currency;
  fromAmount?: string;   // exactly one of fromAmount or toAmount
  toAmount?: string;
  tenor: "instant";
  type: "tradable";      // "tradable" returns EIP-712 data needed for trade creation
  recipientAddress: Address;
}

export interface StableFXQuote {
  quoteId: string;
  fromCurrency: Currency;
  toCurrency: Currency;
  fromAmount: string;    // 6-decimal string, e.g. "10.000000"
  toAmount: string;
  rate: string;
  fee: string;
  expiresAt: string;     // ISO timestamp
  typedData: EIP712TypedData; // for trade creation (phase 1)
}

export interface StableFXTrade {
  tradeId: string;
  contractTradeId: number;
  status: string;
  fromCurrency: Currency;
  toCurrency: Currency;
  fromAmount: string;
  toAmount: string;
}

export interface FundingPresignResponse {
  typedData: EIP712TypedData; // SingleTradeWitness { id: contractTradeId }
  deliverables: Array<{ currency: Currency; amount: string }>;
  receivables: Array<{ currency: Currency; amount: string }>;
}

// Permit2 funding calldata — what goes to the ConduitRouter.executeWithFX()
export interface Permit2FundingData {
  permit: {
    permitted: { token: Address; amount: bigint };
    nonce: bigint;
    deadline: bigint;
  };
  transferDetails: {
    to: Address;           // FxEscrow address
    requestedAmount: bigint;
  };
  witness: `0x${string}`; // keccak256(SingleTradeWitness)
  witnessTypeString: string;
  signature: `0x${string}`; // taker's funding signature
}

interface EIP712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
  primaryType: string;
}

// ── StableFXClient ────────────────────────────────────────────────────────────

export class StableFXClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = STABLEFX_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  // ── Step 1: Get a tradable quote ──────────────────────────────────────────

  async getQuote(request: StableFXQuoteRequest): Promise<StableFXQuote> {
    const body: Record<string, unknown> = {
      fromCurrency: request.fromCurrency,
      toCurrency: request.toCurrency,
      tenor: "instant",
      type: "tradable",
      recipientAddress: request.recipientAddress,
    };

    if (request.toAmount) {
      body["toAmount"] = request.toAmount;
    } else if (request.fromAmount) {
      body["fromAmount"] = request.fromAmount;
    }

    const res = await this.post("/quotes", body);
    return res as StableFXQuote;
  }

  // ── Step 2+3: Sign and create trade ──────────────────────────────────────

  async createTrade(
    quoteId: string,
    takerAddress: Address,
    typedDataMessage: Record<string, unknown>,
    signature: string
  ): Promise<StableFXTrade> {
    const res = await this.post("/trades", {
      quoteId,
      walletAddress: takerAddress,
      message: typedDataMessage,
      signature,
    });
    return res as StableFXTrade;
  }

  // ── Step 4: Get funding presign data ─────────────────────────────────────

  async getFundingPresign(contractTradeId: number): Promise<FundingPresignResponse> {
    const res = await this.post("/signatures/funding/presign", {
      contractTradeIds: [contractTradeId],
      type: "taker",
    });
    return res as FundingPresignResponse;
  }

  // ── Step 6 (optional): Submit funding via API ─────────────────────────────

  async submitFunding(
    contractTradeId: number,
    permit2Object: Record<string, unknown>,
    signature: string
  ): Promise<void> {
    await this.post("/fund", {
      type: "taker",
      contractTradeId,
      permit2: permit2Object,
      signature,
    });
  }

  // ── Step 7: Check trade status ────────────────────────────────────────────

  async getTrade(tradeId: string): Promise<StableFXTrade> {
    const res = await this.get(`/trades/${tradeId}`);
    return res as StableFXTrade;
  }

  // ── Full taker flow ───────────────────────────────────────────────────────
  // Orchestrates steps 1–5 off-chain and returns Permit2 calldata for step 6.
  // The caller then passes this to ConduitRouter.executeWithFX() or submits
  // directly to Permit2.

  async prepareFXPayment(
    fromCurrency: Currency,
    toCurrency: Currency,
    toAmount: string,          // human-readable, e.g. "10.00"
    recipientAddress: Address,
    takerAddress: Address,
    signTypedData: (typedData: EIP712TypedData) => Promise<string>
  ): Promise<{ fundingData: Permit2FundingData; trade: StableFXTrade }> {
    // 1. Quote
    const quote = await this.getQuote({
      fromCurrency,
      toCurrency,
      toAmount,
      tenor: "instant",
      type: "tradable",
      recipientAddress,
    });

    // 2. Sign trade typed data
    const tradeSignature = await signTypedData(quote.typedData);

    // 3. Create trade → get contractTradeId
    const trade = await this.createTrade(
      quote.quoteId,
      takerAddress,
      quote.typedData.message,
      tradeSignature
    );

    // 4. Get funding presign data
    const presign = await this.getFundingPresign(trade.contractTradeId);

    // 5. Sign funding typed data
    const fundingSignature = await signTypedData(presign.typedData);

    // Build Permit2 calldata for ConduitRouter.executeWithFX()
    const msg = presign.typedData.message as Record<string, unknown>;
    const permitted = msg["permitted"] as { token: string; amount: string };
    const witness = this.computeWitness(trade.contractTradeId);

    const fundingData: Permit2FundingData = {
      permit: {
        permitted: {
          token: permitted["token"] as Address,
          amount: BigInt(permitted["amount"]),
        },
        nonce: BigInt((msg["nonce"] as string) ?? "0"),
        deadline: BigInt((msg["deadline"] as string) ?? "0"),
      },
      transferDetails: {
        to: ARC_TESTNET.contracts.stableFXEscrow,
        requestedAmount: BigInt(permitted["amount"]),
      },
      witness,
      witnessTypeString: this.buildWitnessTypeString(),
      signature: fundingSignature as `0x${string}`,
    };

    return { fundingData, trade };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private computeWitness(contractTradeId: number): `0x${string}` {
    // keccak256(abi.encode(SingleTradeWitness { id: contractTradeId }))
    // In production, use ethers.AbiCoder or viem encodeAbiParameters
    const { ethers } = require("ethers");
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256"],
      [contractTradeId]
    );
    return ethers.keccak256(encoded) as `0x${string}`;
  }

  private buildWitnessTypeString(): string {
    // EIP-712 type string for SingleTradeWitness
    return "SingleTradeWitness witness)SingleTradeWitness(uint256 id)";
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`StableFX API error ${res.status}: ${text}`);
    }

    return res.json();
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`StableFX API error ${res.status}: ${text}`);
    }

    return res.json();
  }
}
