import { ethers } from "ethers";
import { ARC_TESTNET, ROUTER_ABI, ERC20_ABI } from "./constants.js";
import { currencyToAddress as resolveCurrencyToAddress } from "./currency.js";
import type {
  Address,
  Bytes32,
  Currency,
  PaymentInstruction,
  PaymentReceipt,
} from "./types.js";

export class RouterClient {
  private contract: ethers.Contract;
  private provider: ethers.Provider;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    const routerAddress = ARC_TESTNET.contracts.conduitRouter;
    if (!routerAddress) {
      throw new Error(
        "ConduitRouter address not set. Deploy contracts first and set NEXT_PUBLIC_CONDUIT_ROUTER."
      );
    }
    this.contract = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  }

  // ── Quote (read-only) ─────────────────────────────────────────────────────

  async quote(instruction: PaymentInstruction): Promise<bigint> {
    try {
      const result = await this.contract.quote(this.encodeInstruction(instruction));
      return BigInt(result);
    } catch {
      return 0n; // Cross-currency quotes require off-chain StableFX API
    }
  }

  // ── Execute (same-currency) ────────────────────────────────────────────────

  async execute(
    instruction: PaymentInstruction,
    signerProvider: ethers.BrowserProvider | ethers.JsonRpcProvider
  ): Promise<PaymentReceipt> {
    const signer = await signerProvider.getSigner();

    // Ensure allowance for same-currency path
    await this.ensureAllowance(
      instruction.payerToken,
      instruction.payer,
      ARC_TESTNET.contracts.conduitRouter,
      instruction.amount,
      signerProvider
    );

    const contractWithSigner = this.contract.connect(signer) as ethers.Contract;
    const tx = await contractWithSigner.execute(this.encodeInstruction(instruction));
    const receipt = await tx.wait();

    return this.parseReceipt(receipt, instruction);
  }

  // ── Allowance management ───────────────────────────────────────────────────

  async ensureAllowance(
    tokenAddress: Address,
    owner: Address,
    spender: Address,
    amount: bigint,
    signerProvider: ethers.BrowserProvider | ethers.JsonRpcProvider
  ): Promise<void> {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const currentAllowance: bigint = await tokenContract.allowance(owner, spender);

    if (currentAllowance >= amount) return;

    const signer = await signerProvider.getSigner();
    const tokenWithSigner = tokenContract.connect(signer) as ethers.Contract;

    // Approve max to avoid repeated approvals
    const tx = await tokenWithSigner.approve(spender, ethers.MaxUint256);
    await tx.wait();
  }

  // ── Receipt parsing ───────────────────────────────────────────────────────

  private parseReceipt(
    txReceipt: ethers.TransactionReceipt,
    instruction: PaymentInstruction
  ): PaymentReceipt {
    const iface = new ethers.Interface(ROUTER_ABI);
    let receiptId: Bytes32 = "0x0" as Bytes32;
    let payerAmount = 0n;
    let recipientAmount = 0n;
    let settledAt = Math.floor(Date.now() / 1000);

    for (const log of txReceipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "PaymentSettled") {
          receiptId = parsed.args["receiptId"] as Bytes32;
          payerAmount = BigInt(parsed.args["payerAmount"]);
          recipientAmount = BigInt(parsed.args["recipientAmount"]);
          settledAt = Number(parsed.args["settledAt"]);
          break;
        }
      } catch { /* skip */ }
    }

    return {
      receiptId,
      payer: instruction.payer,
      recipient: instruction.recipient,
      payerToken: instruction.payerToken,
      recipientToken: instruction.recipientToken,
      payerAmount,
      recipientAmount,
      declarationId: instruction.declarationId,
      settledAt,
      txHash: txReceipt.hash as `0x${string}`,
      explorerUrl: `${ARC_TESTNET.explorer}/tx/${txReceipt.hash}`,
    };
  }

  // ── Encoding ───────────────────────────────────────────────────────────────

  private encodeInstruction(instruction: PaymentInstruction) {
    return [
      instruction.payer,
      instruction.recipient,
      instruction.payerToken,
      instruction.recipientToken,
      instruction.amount,
      instruction.deadline,
      instruction.declarationId,
    ];
  }

  // ── Token helpers ─────────────────────────────────────────────────────────

  currencyToAddress(currency: Currency): Address {
    return resolveCurrencyToAddress(currency);
  }
}
