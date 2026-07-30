import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SDK Reference",
};

export default function ReferencePage() {
  return (
    <article className="prose-conduit">
      <h3>API surface</h3>
      <h1>SDK Reference</h1>

      <p>
        Full reference for <code>@conduit/sdk</code>. Every method, every parameter,
        every return type. Types are derived directly from{" "}
        <code>packages/sdk/src/types.ts</code>.
      </p>

      <hr />

      {/* ── ConduitClient ──────────────────────────────────────────────────── */}
      <h2>ConduitClient</h2>

      <p>Main entry point. All payment operations go through this class.</p>

      <h3>Constructor</h3>

      <pre><code>{`new ConduitClient(config: ConduitClientConfig)`}</code></pre>

      <pre><code>{`interface ConduitClientConfig {
  // Browser wallet signer (ethers Signer or viem WalletClient).
  // Required for browser flows. Mutually exclusive with privateKey.
  signer?: SignerLike;

  // Server private key. Mutually exclusive with signer.
  // Required for server-side flows.
  privateKey?: string;

  // Circle App Kit Key — required for cross-currency payments.
  // Get one at console.circle.com → Keys → Kit Key
  kitKey?: string;

  // "arc-testnet" in v1
  network?: "arc-testnet";

  // Override the app URL for link generation
  appUrl?: string;
}`}</code></pre>

      <h3>Static factory: fromBrowserProvider()</h3>

      <pre><code>{`ConduitClient.fromBrowserProvider(
  provider: ethers.BrowserProvider,
  kitKey: string,
  appUrl?: string
): ConduitClient`}</code></pre>

      <p>
        Create a client from an EIP-1193 browser wallet (wagmi, MetaMask, etc.).
        Wraps the provider so wallet popups work correctly.
      </p>

      <hr />

      {/* ── pay() ─────────────────────────────────────────────────────────── */}
      <h2>pay()</h2>

      <pre><code>{`conduit.pay(options: PayOptions): Promise<PaymentReceipt>`}</code></pre>

      <pre><code>{`interface PayOptions {
  // Recipient wallet address
  recipient: Address;           // "0x..."

  // Amount to deliver to recipient (6-decimal bigint)
  amount: bigint;

  // Currency the recipient should receive
  currency: Currency;           // "USDC" | "EURC"

  // Currency the payer holds (defaults to recipient currency)
  // Set to trigger a cross-currency swap
  payerToken?: Currency;
}`}</code></pre>

      <p>
        <strong>Same-currency</strong> (e.g. USDC → USDC): single on-chain transaction via{" "}
        <code>ConduitRouter.execute()</code>.
      </p>
      <p>
        <strong>Cross-currency</strong> (e.g. USDC → EURC): Circle StableFX swap → then{" "}
        <code>ConduitRouter.execute()</code>. Requires <code>kitKey</code>.
      </p>

      <hr />

      {/* ── createLink() ──────────────────────────────────────────────────── */}
      <h2>createLink()</h2>

      <pre><code>{`conduit.createLink(options: CreateLinkOptions): Promise<{
  declarationId: Bytes32;
  paymentUrl: string;
  txHash: string;
}>`}</code></pre>

      <pre><code>{`interface CreateLinkOptions {
  // Amount to request (0n = open amount, payer chooses)
  amount: bigint;

  // Currency you want to receive
  currency: Currency;

  // Recipient address (defaults to signer address)
  recipient?: Address;

  // Human-readable label (not stored on-chain in v1)
  label?: string;
}`}</code></pre>

      <p>
        Registers a payment declaration on the DeclarationRegistry contract and returns
        a shareable URL. The declaration is live immediately after the transaction confirms.
      </p>

      <hr />

      {/* ── fulfill() ─────────────────────────────────────────────────────── */}
      <h2>fulfill()</h2>

      <pre><code>{`conduit.fulfill(
  declaration: PaymentDeclaration,
  options?: FulfillOptions
): Promise<PaymentReceipt>`}</code></pre>

      <pre><code>{`interface FulfillOptions {
  // Currency the payer holds — must match the declaration's currency.
  payerToken?: Currency;
}`}</code></pre>

      <p>
        Executes a payment for a resolved declaration. Same-currency only — the payer's
        currency must match what the declaration asks for, or this throws. For a
        cross-currency payment against a declaration, resolve it with{" "}
        <code>parse()</code>/<code>resolveDeclaration()</code> and call{" "}
        <code>pay()</code> instead.
      </p>

      <hr />

      {/* ── parse() ───────────────────────────────────────────────────────── */}
      <h2>parse()</h2>

      <pre><code>{`conduit.parse(url: string): Promise<PaymentDeclaration>`}</code></pre>

      <p>
        Resolve a <code>PaymentDeclaration</code> from a Conduit payment URL.
        Extracts the declaration ID and fetches on-chain data.
      </p>

      <hr />

      {/* ── quote() ───────────────────────────────────────────────────────── */}
      <h2>quote()</h2>

      <pre><code>{`conduit.quote(options: {
  payerToken: Currency;
  recipientToken: Currency;
  amount: bigint;
}): Promise<Quote>`}</code></pre>

      <pre><code>{`interface Quote {
  payerToken: Address;
  recipientToken: Address;
  payerAmount: bigint;    // what payer sends (6 decimals)
  recipientAmount: bigint; // what recipient gets (6 decimals)
  rate: number;           // exchange rate (display only)
  expiresAt: number;      // unix timestamp
}`}</code></pre>

      <p>
        Same-currency quotes return the exact on-chain amount including the protocol fee.
        Cross-currency quotes return <code>0n</code> for <code>payerAmount</code> — the live
        rate is determined by Circle StableFX at execution time.
      </p>

      <hr />

      {/* ── deactivateLink() ──────────────────────────────────────────────── */}
      <h2>deactivateLink()</h2>

      <pre><code>{`conduit.deactivateLink(declarationId: Bytes32): Promise<string> // txHash`}</code></pre>

      <p>
        Cancels a payment declaration. Only callable by the address that created it.
        A deactivated declaration can no longer be fulfilled.
      </p>

      <hr />

      {/* ── getBalance() ──────────────────────────────────────────────────── */}
      <h2>getBalance()</h2>

      <pre><code>{`conduit.getBalance(wallet: Address, currency: Currency): Promise<bigint>`}</code></pre>

      <p>Returns the token balance of a wallet in 6-decimal units.</p>

      <hr />

      {/* ── getHistory() ──────────────────────────────────────────────────── */}
      <h2>getHistory()</h2>

      <pre><code>{`conduit.getHistory(
  wallet: Address,
  options?: GetHistoryOptions
): Promise<PaymentReceipt[]>`}</code></pre>

      <pre><code>{`interface GetHistoryOptions {
  limit?: number;   // default: 50
  offset?: number;  // default: 0
}`}</code></pre>

      <p>
        Returns all settled payments where <code>wallet</code> was the payer or recipient,
        sorted by block number descending.
      </p>

      <hr />

      {/* ── getReceipt() ──────────────────────────────────────────────────── */}
      <h2>getReceipt()</h2>

      <pre><code>{`conduit.getReceipt(receiptId: Bytes32): Promise<PaymentReceipt | null>`}</code></pre>

      <p>Look up a single settled payment by its on-chain receipt ID.</p>

      <hr />

      {/* ── getDeclarations() ─────────────────────────────────────────────── */}
      <h2>getDeclarations()</h2>

      <pre><code>{`conduit.getDeclarations(wallet: Address): Promise<PaymentDeclaration[]>`}</code></pre>

      <p>Returns all payment declarations registered by a wallet address.</p>

      <hr />

      {/* ── Types ─────────────────────────────────────────────────────────── */}
      <h2>Core types</h2>

      <pre><code>{`type Address  = \`0x\${string}\`;
type Bytes32  = \`0x\${string}\`;
type Currency = "USDC" | "EURC";

interface PaymentDeclaration {
  declarationId: Bytes32;
  recipient: Address;
  recipientToken: Address;   // ERC-20 address
  currency: Currency;
  amount: bigint;            // 0n = open amount
  registeredAt: number;      // unix timestamp
  active: boolean;
  paymentUrl: string;        // https://app.conduit.xyz/pay/<id>
}

interface PaymentReceipt {
  receiptId: Bytes32;
  payer: Address;
  recipient: Address;
  payerToken: Address;
  recipientToken: Address;
  payerAmount: bigint;       // what payer sent (6 decimals)
  recipientAmount: bigint;   // what recipient received (6 decimals)
  declarationId: Bytes32;    // zero if ad-hoc payment
  settledAt: number;         // unix timestamp
  txHash: \`0x\${string}\`;
  explorerUrl: string;       // https://testnet.arcscan.app/tx/...
}`}</code></pre>

      <hr />

      {/* ── Constants ─────────────────────────────────────────────────────── */}
      <h2>Constants</h2>

      <pre><code>{`import {
  ARC_TESTNET,
  CONDUIT_PAYMENT_HEADER,  // "conduit-payment"
  CONDUIT_WELL_KNOWN_PATH, // "/.well-known/conduit"
} from "@conduit/sdk";

// ARC_TESTNET shape:
{
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.network",
  ws: "wss://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  tokens: { USDC: "0x...", EURC: "0x..." },
  contracts: {
    conduitRouter: "0x...",
    declarationRegistry: "0x...",
    stableFXAdapter: "0x...",
    atomicSettler: "0x...",
    cctpAdapter: "0x...",
    cctpTokenMessenger: "0x...",
    cctpMessageTransmitter: "0x...",
    permit2: "0x...",
  },
}`}</code></pre>

      <hr />

      <h2>Next steps</h2>

      <ul>
        <li>
          <a href="/">Quickstart</a> — first payment in 5 minutes
        </li>
        <li>
          <a href="/guides">Guides</a> — the B2B settlement API: errors, webhooks,
          currencies, FX timing
        </li>
      </ul>
    </article>
  );
}
