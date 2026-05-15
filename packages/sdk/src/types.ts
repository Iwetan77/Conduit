// ── Core Types ────────────────────────────────────────────────────────────────
// All on-chain amounts use bigint (never number).
// USDC and EURC: always 6-decimal ERC-20 values. Never 18-decimal native.

export type Address = `0x${string}`;
export type Bytes32 = `0x${string}`;
export type Currency = "USDC" | "EURC";

// ── Payment Declaration ───────────────────────────────────────────────────────

export interface PaymentDeclaration {
  declarationId: Bytes32;
  recipient: Address;
  recipientToken: Address;
  currency: Currency;
  amount: bigint;       // 0n = open amount
  registeredAt: number; // unix timestamp
  active: boolean;
  paymentUrl: string;   // https://app.conduit.xyz/pay/<declarationId>
}

// ── Payment Instruction ───────────────────────────────────────────────────────

export interface PaymentInstruction {
  payer: Address;
  recipient: Address;
  payerToken: Address;
  recipientToken: Address;
  amount: bigint;        // in recipientToken units (6 decimals)
  deadline: number;      // unix timestamp
  declarationId: Bytes32;
}

// ── Quote ─────────────────────────────────────────────────────────────────────

export interface Quote {
  payerToken: Address;
  recipientToken: Address;
  payerAmount: bigint;   // what payer sends (6 decimals)
  recipientAmount: bigint; // what recipient gets (6 decimals)
  rate: number;          // exchange rate (display only)
  expiresAt: number;     // unix timestamp
}


// ── Receipt ───────────────────────────────────────────────────────────────────

export interface PaymentReceipt {
  receiptId: Bytes32;
  payer: Address;
  recipient: Address;
  payerToken: Address;
  recipientToken: Address;
  payerAmount: bigint;
  recipientAmount: bigint;
  declarationId: Bytes32;
  settledAt: number;
  txHash: `0x${string}`;
  explorerUrl: string;
}

// ── Client Config ─────────────────────────────────────────────────────────────

export interface ConduitClientConfig {
  /** ethers Signer or viem WalletClient */
  signer: SignerLike;
  /** "arc-testnet" in v1 */
  network?: "arc-testnet";
  /** Override app URL for link generation */
  appUrl?: string;
  /** Circle App Kit Key — required for cross-currency (USDC↔EURC) payments.
   *  Get one at console.circle.com → Keys → Kit Key. */
  kitKey?: string;
}

// Minimal signer abstraction — works with ethers v6 Signer and viem WalletClient
export interface SignerLike {
  getAddress(): Promise<string>;
  sendTransaction(tx: TransactionRequest): Promise<TransactionResponse>;
  signTypedData?: (domain: unknown, types: unknown, value: unknown) => Promise<string>;
}

export interface TransactionRequest {
  to: string;
  data: string;
  value?: bigint;
  gasLimit?: bigint;
}

export interface TransactionResponse {
  hash: string;
  wait(): Promise<{ status: number; blockNumber: number }>;
}

// ── Pay Options ───────────────────────────────────────────────────────────────

export interface PayOptions {
  recipient: Address;
  amount: bigint;        // in recipientToken units (6 decimals)
  currency: Currency;    // recipient's desired currency
  payerToken?: Currency; // payer's currency (defaults to USDC)
}

export interface CreateLinkOptions {
  amount: bigint;        // 0n for open amount
  currency: Currency;
  recipient?: Address;   // defaults to signer address
  label?: string;
}

export interface FulfillOptions {
  payerToken?: Currency;
}

export interface GetHistoryOptions {
  limit?: number;
  offset?: number;
}
