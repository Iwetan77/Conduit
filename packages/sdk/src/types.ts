// ── Core Types ────────────────────────────────────────────────────────────────
// All on-chain amounts use bigint (never number). Decimals vary by currency —
// USDC/EURC/AUDF/MXNB/QCAD are 6dp, BRLA/KRW1 are 18dp. Never assume 6; resolve
// via CurrencyDescriptor (see currency.ts). See audit/DECIMAL-AUDIT.md.

export type Address = `0x${string}`;
export type Bytes32 = `0x${string}`;

/// An on-chain token symbol (e.g. "USDC", "EURC", "BRLA") — was a closed
/// "USDC" | "EURC" union, now any symbol registered in currency.ts / eventually
/// GET /v1/currencies. NOT the same as CurrencyRegistry.sol's 3-letter fiat ISO
/// code (bytes3 "USD"/"EUR"/"BRL") — see currency.ts's header comment for why
/// those are deliberately kept distinct.
export type Currency = string;

/// A currency fully resolved against the on-chain CurrencyRegistry: which token,
/// how many decimals. `toHumanAmount`/`fromHumanAmount` require `decimals` from
/// here — never hardcode it.
export interface CurrencyDescriptor {
  iso: Currency;
  token: Address;
  decimals: number;
}

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
  amount: bigint;        // in recipientToken's own minor units (see CurrencyDescriptor.decimals)
  deadline: number;      // unix timestamp
  declarationId: Bytes32;
}

// ── Quote ─────────────────────────────────────────────────────────────────────

export interface Quote {
  payerToken: Address;
  recipientToken: Address;
  payerAmount: bigint;   // what payer sends, in payerToken's own minor units
  recipientAmount: bigint; // what recipient gets, in recipientToken's own minor units
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

// Server/agent usage example:
// const conduit = new ConduitClient({
//   privateKey: process.env.PRIVATE_KEY,
//   kitKey: process.env.KIT_KEY,
//   network: "arc-testnet"
// })
// const result = await conduit.discover("https://service.xyz/api")
// if (result.found) await conduit.fulfill(result.declaration!)

export interface ConduitClientConfig {
  /** Browser wallet signer (ethers Signer or viem WalletClient).
   *  Mutually exclusive with privateKey. Required for browser flows. */
  signer?: SignerLike;
  /** Server/agent private key for non-browser environments.
   *  Mutually exclusive with signer. Required for server-side
   *  cross-currency payments via conduit.discover() + fulfill(). */
  privateKey?: string;
  /** Circle App Kit Key — required for cross-currency (USDC↔EURC).
   *  Get one at console.circle.com → Keys → Kit Key */
  kitKey?: string;
  /** "arc-testnet" in v1 */
  network?: "arc-testnet";
  /** Override app URL for link generation */
  appUrl?: string;
  /** Optional spending constraints for autonomous agent operation.
   *  In v1 these are enforced client-side. On-chain AgentRegistry is a v2 feature. */
  agentConfig?: AgentConfig;
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
  amount: bigint;        // in recipientToken's own minor units (see CurrencyDescriptor.decimals)
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

// ── Agent Config (v1: client-side only, v2: on-chain) ──────────────────────
// In v1, spending constraints are enforced client-side by the SDK.
// On-chain AgentRegistry is a v2 feature.

export interface AgentConfig {
  /** Maximum spend per transaction, in USDC's minor units (6dp). 0 = unlimited. */
  maxPerTransactionUSDC?: bigint;
  /** Maximum spend per day, in USDC's minor units (6dp). 0 = unlimited. */
  dailyLimitUSDC?: bigint;
  /** Allowed tokens to send. Empty = all supported tokens. */
  allowedTokens?: Currency[];
  /** Whitelisted recipient addresses. Empty = any recipient. */
  allowedRecipients?: string[];
}
