import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Conduit Relay",
};

export default function RelayPage() {
  return (
    <article className="prose-conduit">
      {/* Eyebrow */}
      <h3>Autonomous payments</h3>

      <h1>Conduit Relay</h1>

      <p>
        Conduit Relay lets AI agents and automated services discover and fulfill payment
        requirements without any human input. A service advertises what it wants via a
        single HTTP header. An agent checks for that header, reads the declaration,
        and pays — in any currency it holds.
      </p>

      <hr />

      {/* Part A — Accept payments */}
      <h2>Part A — Accept agent payments</h2>

      <p>
        Add two things to your service: a payment declaration on-chain, and one HTTP
        header on your API responses. That&apos;s it.
      </p>

      <h3>Step 1 — Create a payment declaration</h3>

      <p>
        A declaration is an on-chain record of what your service wants to receive:
        which currency, how much, and where to send it.
      </p>

      <ul>
        <li>
          Go to{" "}
          <a href="https://app.conduit.xyz/create" target="_blank" rel="noopener noreferrer">
            app.conduit.xyz/create
          </a>{" "}
          to create one in the UI
        </li>
        <li>Or register one programmatically using the SDK (see below)</li>
        <li>You&apos;ll receive a declaration ID and a payment URL</li>
      </ul>

      <pre><code>{`import { ConduitClient } from "@conduit/sdk";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const conduit = new ConduitClient({ signer });

const { declarationId, paymentUrl } = await conduit.createLink({
  amount: 5_000_000n, // $5 USDC per request
  currency: "USDC",
});

console.log(declarationId); // 0xABC...
console.log(paymentUrl);    // https://app.conduit.xyz/pay/0xABC...`}</code></pre>

      <h3>Step 2 — Add the Conduit-Payment header</h3>

      <p>
        Any HTTP response from your service can carry the <code>Conduit-Payment</code> header.
        Conduit agents check for it before every request.
      </p>

      <pre><code>{`// Express.js
app.use((req, res, next) => {
  res.setHeader(
    "Conduit-Payment",
    "https://app.conduit.xyz/pay/YOUR_DECLARATION_ID"
  );
  next();
});

// Next.js API route
export async function GET() {
  return NextResponse.json(data, {
    headers: {
      "Conduit-Payment": "https://app.conduit.xyz/pay/YOUR_DECLARATION_ID",
    },
  });
}

// Fastify
fastify.addHook("onSend", async (request, reply) => {
  reply.header("Conduit-Payment", "https://app.conduit.xyz/pay/YOUR_ID");
});`}</code></pre>

      <p>
        Alternatively, serve a static JSON file at <code>/.well-known/conduit</code>.
        Conduit checks this path as a fallback if no header is present.
      </p>

      <pre><code>{`// /.well-known/conduit
{
  "paymentUrl": "https://app.conduit.xyz/pay/YOUR_DECLARATION_ID",
  "version": "1"
}`}</code></pre>

      <hr />

      {/* Part B — Build an agent */}
      <h2>Part B — Build an agent that pays</h2>

      <p>
        Use <code>conduit.discover()</code> before calling any paid service. It performs
        a HEAD request and checks the <code>Conduit-Payment</code> header, then falls
        back to <code>/.well-known/conduit</code>. If a declaration is found, fulfill it.
      </p>

      <h3>Server / autonomous agent</h3>

      <pre><code>{`import { ConduitClient } from "@conduit/sdk";

const conduit = new ConduitClient({
  privateKey: process.env.PRIVATE_KEY,  // required for server-side
  kitKey: process.env.KIT_KEY,          // required for cross-currency
  network: "arc-testnet",
  // Optional: enforce spending limits
  agentConfig: {
    maxPerTransactionUSDC: 100_000_000n, // $100 max per tx
    dailyLimitUSDC: 1_000_000_000n,      // $1,000 daily limit
    allowedTokens: ["USDC", "EURC"],
  },
});

// Discover and pay in one pattern
const result = await conduit.discover("https://dataservice.xyz/api");

if (result.found) {
  console.log("Declaration found via:", result.source); // "header" | "well-known"
  const receipt = await conduit.fulfill(result.declaration!);
  console.log("Paid:", receipt.txHash);
  // ✓ Service received payment. Agent continues.
}

// Then call the service normally
const data = await fetch("https://dataservice.xyz/api");`}</code></pre>

      <h3>Browser / frontend agent</h3>

      <pre><code>{`import { ConduitClient } from "@conduit/sdk";

// Connect wallet via wagmi, then:
const conduit = ConduitClient.fromBrowserProvider(
  window.ethereum,
  process.env.NEXT_PUBLIC_KIT_KEY
);

const result = await conduit.discover("https://service.xyz/api");
if (result.found) {
  const receipt = await conduit.fulfill(result.declaration!);
  console.log("Paid:", receipt.txHash);
}`}</code></pre>

      <hr />

      {/* AgentConfig */}
      <h2>AgentConfig — spending constraints</h2>

      <p>
        Pass <code>agentConfig</code> to enforce client-side spending limits. Useful for
        autonomous agents that should not exceed a budget without human approval.
        On-chain enforcement is a v2 feature.
      </p>

      <pre><code>{`const conduit = new ConduitClient({
  privateKey: process.env.PRIVATE_KEY,
  kitKey: process.env.KIT_KEY,
  agentConfig: {
    // Maximum spend per single payment (6-decimal USDC equivalent)
    maxPerTransactionUSDC: 100_000_000n, // $100

    // Maximum spend per day (not yet enforced in v1 — coming in v2)
    dailyLimitUSDC: 1_000_000_000n, // $1,000

    // Restrict which tokens the agent may send
    allowedTokens: ["USDC"], // only USDC, not EURC

    // Restrict which recipients are allowed
    allowedRecipients: [
      "0xTRUSTED_SERVICE_1",
      "0xTRUSTED_SERVICE_2",
    ],
  },
});

// This will throw if amount > maxPerTransactionUSDC
await conduit.pay({
  recipient: "0xSERVICE",
  amount: 200_000_000n, // $200 — exceeds $100 limit → throws
  currency: "USDC",
});`}</code></pre>

      <hr />

      <h2>How discovery works</h2>

      <ul>
        <li>
          <code>conduit.discover(url)</code> performs a HEAD request to the URL (5s timeout)
        </li>
        <li>
          Checks the <code>Conduit-Payment</code> response header
        </li>
        <li>
          If no header, fetches <code>origin/.well-known/conduit</code> as fallback
        </li>
        <li>
          If a payment URL is found, resolves the declaration from the Arc Testnet chain
        </li>
        <li>
          Returns <code>&#123; found: true, declaration, source &#125;</code> or <code>&#123; found: false &#125;</code>
        </li>
      </ul>

      <hr />

      <h2>Next steps</h2>

      <ul>
        <li>
          <a href="/reference">SDK Reference</a> — full API surface for <code>discover()</code>,
          {" "}<code>fulfill()</code>, and <code>AgentConfig</code>
        </li>
        <li>
          <a href="/">Quickstart</a> — direct send and payment links
        </li>
        <li>
          <a href="https://app.conduit.xyz/agent" target="_blank" rel="noopener noreferrer">
            Relay dashboard
          </a>{" "}
          — interactive code snippets and network reference
        </li>
      </ul>
    </article>
  );
}
