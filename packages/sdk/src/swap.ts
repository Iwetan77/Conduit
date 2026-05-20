// Cross-currency swap via Circle StableFX stablecoinKits API + on-chain execution.
//
// Architecture:
//   1. Call Circle's stablecoinKits API to get swap calldata (server-side or via proxy)
//   2. Approve tokenIn to the Adapter Contract returned by the API
//   3. Submit the calldata on-chain via ethers.js (browser wallet or private key)
//
// The FxEscrow contract (0x867650F5eAe8df91445971f14d89fd84F0C9a9f8) settles the swap
// atomically. Circle's Adapter Contract is the on-chain entry point — it pulls tokenIn
// via permit/approve, calls FxEscrow, and delivers tokenOut to the recipient.
//
// No @circle-fin/app-kit or @circle-fin/adapter-viem-v2 required.

import { ethers } from "ethers";
import type { Currency } from "./types.js";

const CIRCLE_API = "https://api.circle.com";
const ARC_CHAIN = "Arc_Testnet";
const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = 5042002;
const ARC_EXPLORER = "https://testnet.arcscan.app";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// ── Public types ──────────────────────────────────────────────────────────────

export interface SwapResult {
  tokenIn: Currency;
  tokenOut: Currency;
  amountIn: string;
  amountOutRaw?: string;
  txHash: string;
  explorerUrl: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface SwapInstruction {
  target: string;
  data: string;
  value: string;
  tokenIn: string;
  amountToApprove: string;
}

interface CreateSwapResponse {
  transaction: {
    instructions: SwapInstruction[];
  };
  tokenInAddress: string;
  amount: string;
  amountOut?: string;
}

// ── API call ──────────────────────────────────────────────────────────────────

async function callStablecoinKits(
  body: Record<string, unknown>,
  kitKey: string,
  proxyBase?: string
): Promise<CreateSwapResponse> {
  // Browser: route through Next.js proxy to avoid CORS.
  // Server: call Circle directly with the Kit Key as Bearer token.
  const url = proxyBase
    ? `${proxyBase}?path=${encodeURIComponent("v1/stablecoinKits/swap")}`
    : `${CIRCLE_API}/v1/stablecoinKits/swap`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!proxyBase) {
    // Server-side: attach auth directly. Proxy injects its own auth.
    headers["Authorization"] = `Bearer ${kitKey}`;
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`StablecoinKits API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<CreateSwapResponse>;
}

// ── On-chain execution ────────────────────────────────────────────────────────

async function executeInstructions(
  response: CreateSwapResponse,
  signer: ethers.Signer,
  tokenIn: Currency,
  tokenOut: Currency,
  amountIn: string
): Promise<SwapResult> {
  const instructions = response.transaction?.instructions;
  if (!instructions?.length) {
    throw new Error("No swap instructions returned by Circle API");
  }

  let txHash = "";

  for (const instr of instructions) {
    const approveAmount = instr.amountToApprove ? BigInt(instr.amountToApprove) : 0n;

    if (instr.tokenIn && approveAmount > 0n) {
      const token = new ethers.Contract(instr.tokenIn, ERC20_ABI, signer);
      const current: bigint = await token.allowance(await signer.getAddress(), instr.target);
      if (current < approveAmount) {
        const approveTx = await token.approve(instr.target, approveAmount);
        await approveTx.wait();
      }
    }

    const tx = await signer.sendTransaction({
      to: instr.target,
      data: instr.data,
      value: instr.value && instr.value !== "0x" ? BigInt(instr.value) : 0n,
    });

    const receipt = await tx.wait();
    if (receipt?.status === 0) {
      throw new Error("Swap transaction reverted on-chain");
    }
    txHash = tx.hash;
  }

  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOutRaw: response.amountOut,
    txHash,
    explorerUrl: `${ARC_EXPLORER}/tx/${txHash}`,
  };
}

// ── Server-side swap (private key) ───────────────────────────────────────────

export async function swap(
  privateKey: string,
  tokenIn: Currency,
  tokenOut: Currency,
  amountIn: string,
  kitKey: string
): Promise<SwapResult> {
  const provider = new ethers.JsonRpcProvider(ARC_RPC, {
    chainId: ARC_CHAIN_ID,
    name: "arc-testnet",
  });
  const wallet = new ethers.Wallet(privateKey, provider);
  const fromAddress = await wallet.getAddress();

  const response = await callStablecoinKits(
    {
      tokenInAddress: currencyToAddress(tokenIn),
      tokenOutAddress: currencyToAddress(tokenOut),
      tokenInChain: ARC_CHAIN,
      fromAddress,
      toAddress: fromAddress,
      amount: toBaseUnits(amountIn),
    },
    kitKey
  );

  return executeInstructions(response, wallet, tokenIn, tokenOut, amountIn);
}

// ── Browser-side swap (EIP-1193 provider) ────────────────────────────────────
// proxyBase: URL of your server proxy (e.g. "/api/circle-proxy").
// The proxy forwards to api.circle.com server-side, avoiding CORS.

export async function swapWithBrowserWallet(
  eip1193Provider: unknown,
  tokenIn: Currency,
  tokenOut: Currency,
  amountIn: string,
  kitKey: string,
  proxyBase = "/api/circle-proxy"
): Promise<SwapResult> {
  const provider = new ethers.BrowserProvider(eip1193Provider as ethers.Eip1193Provider);
  const signer = await provider.getSigner();
  const fromAddress = await signer.getAddress();

  const response = await callStablecoinKits(
    {
      tokenInAddress: currencyToAddress(tokenIn),
      tokenOutAddress: currencyToAddress(tokenOut),
      tokenInChain: ARC_CHAIN,
      fromAddress,
      toAddress: fromAddress,
      amount: toBaseUnits(amountIn),
    },
    kitKey,
    proxyBase
  );

  return executeInstructions(response, signer, tokenIn, tokenOut, amountIn);
}

// ── Amount helpers ────────────────────────────────────────────────────────────

export function toHumanAmount(amount: bigint): string {
  const divisor = 1_000_000n;
  const whole = amount / divisor;
  const frac = (amount % divisor).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}.00`;
}

export function fromHumanAmount(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const paddedFrac = frac.slice(0, 6).padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(paddedFrac || "0");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currencyToAddress(currency: Currency): string {
  return currency === "USDC" ? USDC : EURC;
}

function toBaseUnits(humanAmount: string): string {
  const [whole = "0", frac = ""] = humanAmount.split(".");
  const paddedFrac = frac.slice(0, 6).padEnd(6, "0");
  return (BigInt(whole) * 1_000_000n + BigInt(paddedFrac || "0")).toString();
}
