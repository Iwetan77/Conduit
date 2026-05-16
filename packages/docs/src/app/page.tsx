import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quickstart",
};

export default function QuickstartPage() {
  return (
    <article className="prose-conduit">
      {/* Eyebrow */}
      <h3>Getting started</h3>

      <h1>Quickstart</h1>

      <p>
        From zero to a working payment in under 5 minutes. You&apos;ll install the SDK,
        configure a signer, and send your first payment on Arc Testnet.
      </p>

      <hr />

      {/* Step 1 */}
      <h2>1. Install</h2>

      <pre><code>{`npm install @conduit/sdk ethers`}</code></pre>

      <p>
        The SDK ships as ESM with full TypeScript types. It targets Arc Testnet in v1.
        No bundler configuration needed.
      </p>

      {/* Step 2 */}
      <h2>2. Get testnet USDC</h2>

      <p>
        Arc Testnet uses USDC as its gas token. You need it before making any payments.
      </p>

      <ul>
        <li>
          Visit{" "}
          <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer">
            faucet.circle.com
          </a>{" "}
          → select <strong>Arc Testnet</strong> → request <strong>USDC</strong>
        </li>
        <li>
          Get EURC from the same faucet if you want to test cross-currency flows
        </li>
      </ul>

      {/* Step 3 */}
      <h2>3. Send your first payment</h2>

      <pre><code>{`import { ConduitClient } from "@conduit/sdk";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(
  "https://rpc.testnet.arc.network"
);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const conduit = new ConduitClient({
  signer,
  network: "arc-testnet",
});

// Send $10 USDC to any address
const receipt = await conduit.pay({
  recipient: "0xRECIPIENT_ADDRESS",
  amount: 10_000_000n,  // $10 in 6-decimal units
  currency: "USDC",
});

console.log("Settled:", receipt.txHash);
console.log("Explorer:", receipt.explorerUrl);`}</code></pre>

      <p>
        Amounts are always <strong>6-decimal bigints</strong>. 1 USDC = <code>1_000_000n</code>.
        Never use floating-point for token amounts.
      </p>

      {/* Step 4 */}
      <h2>4. Cross-currency payment</h2>

      <p>
        Send USDC when the recipient wants EURC (or vice versa). Conduit handles the
        swap via Circle StableFX — you need a Kit Key from{" "}
        <a href="https://console.circle.com" target="_blank" rel="noopener noreferrer">
          console.circle.com
        </a>.
      </p>

      <pre><code>{`const conduit = new ConduitClient({
  signer,
  kitKey: process.env.KIT_KEY,
  network: "arc-testnet",
});

// You hold USDC, recipient wants EURC
const receipt = await conduit.pay({
  recipient: "0xRECIPIENT_ADDRESS",
  amount: 10_000_000n,   // $10 EURC they receive
  currency: "EURC",      // recipient's currency
  payerToken: "USDC",    // your currency
});`}</code></pre>

      {/* Step 5 */}
      <h2>5. Create a payment link</h2>

      <p>
        Generate a shareable URL. Anyone with that URL can pay you in any supported
        stablecoin — Conduit routes and converts automatically.
      </p>

      <pre><code>{`// Register a declaration on-chain and get a payment URL
const { paymentUrl, declarationId, txHash } = await conduit.createLink({
  amount: 5_000_000n,   // $5 USDC
  currency: "USDC",
  // recipient defaults to signer address
});

console.log(paymentUrl);
// → https://app.conduit.xyz/pay/0xABC...

// Open amount (payer chooses how much)
const openLink = await conduit.createLink({
  amount: 0n,
  currency: "USDC",
});`}</code></pre>

      {/* Network reference */}
      <h2>Network reference</h2>

      <pre><code>{`Chain ID:     5042002
RPC:          https://rpc.testnet.arc.network
WebSocket:    wss://rpc.testnet.arc.network
Explorer:     https://testnet.arcscan.app
USDC:         0x3600...  (6 decimals)
EURC:         0x89B5...  (6 decimals)
CCTP Domain:  26`}</code></pre>

      <hr />

      <h2>Next steps</h2>

      <ul>
        <li>
          <a href="/relay">Conduit Relay</a> — autonomous payments for AI agents and services
        </li>
        <li>
          <a href="/reference">SDK Reference</a> — full API surface, every method and parameter
        </li>
        <li>
          <a href="https://app.conduit.xyz" target="_blank" rel="noopener noreferrer">
            Open the app
          </a>{" "}
          — create payment links, QR codes, and view history
        </li>
      </ul>
    </article>
  );
}
