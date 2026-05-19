"use client";

import { useState } from "react";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { ARC_TESTNET } from "@conduit/sdk";

// ── Copy button helper ────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="text-xs font-mono text-brand-muted hover:text-brand-green transition-colors px-2 py-1 rounded border border-brand-border"
    >
      {copied ? "✓ copied" : "copy"}
    </button>
  );
}

// ── Code block with copy ──────────────────────────────────────────────────────
function CodeBlock({ code, language = "typescript" }: { code: string; language?: string }) {
  return (
    <div className="relative rounded-xl border border-brand-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-brand-border bg-black/40">
        <span className="text-[10px] font-mono text-brand-muted uppercase tracking-widest">{language}</span>
        <CopyButton text={code} />
      </div>
      <pre className="bg-black p-4 text-xs font-mono text-brand-white overflow-x-auto leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── Tab toggle ────────────────────────────────────────────────────────────────
function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: string[];
  active: string;
  onChange: (t: string) => void;
}) {
  return (
    <div className="flex gap-1 border border-brand-border rounded-lg p-1 w-fit">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={`px-4 py-1.5 rounded-md text-xs font-mono transition-all ${
            active === tab
              ? "bg-brand-green text-brand-black font-anton"
              : "text-brand-muted hover:text-brand-white"
          }`}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

// ── Code snippets ─────────────────────────────────────────────────────────────
const BROWSER_CODE = `import { ConduitClient } from "@conduit/sdk";

// Browser — connect wallet via wagmi first
const conduit = ConduitClient.fromBrowserProvider(
  window.ethereum,
  process.env.NEXT_PUBLIC_KIT_KEY
);

// Discover and pay automatically
const result = await conduit.discover("https://service.xyz/api");
if (result.found) {
  const receipt = await conduit.fulfill(result.declaration!);
  console.log("Paid:", receipt.txHash);
}`;

const SERVER_CODE = `import { ConduitClient } from "@conduit/sdk";

// Server / autonomous agent — uses private key directly
const conduit = new ConduitClient({
  privateKey: process.env.PRIVATE_KEY,
  kitKey: process.env.KIT_KEY,
  network: "arc-testnet",
  // Optional: enforce spending limits
  agentConfig: {
    maxPerTransactionUSDC: 100_000_000n, // $100 max per tx
    dailyLimitUSDC: 1_000_000_000n,      // $1000 daily limit
    allowedTokens: ["USDC", "EURC"],
  }
});

// Discover and pay automatically
const result = await conduit.discover("https://service.xyz/api");
if (result.found) {
  const receipt = await conduit.fulfill(result.declaration!);
}`;

const EXPRESS_CODE = `// Express.js
app.use((req, res, next) => {
  res.setHeader(
    "Conduit-Payment",
    "https://app.conduit.xyz/pay/YOUR_DECLARATION_ID"
  );
  next();
});

// Next.js API Route
export async function GET() {
  return NextResponse.json(data, {
    headers: {
      "Conduit-Payment": "https://app.conduit.xyz/pay/YOUR_DECLARATION_ID",
    },
  });
}

// Or serve a static file at /.well-known/conduit
// { "paymentUrl": "https://app.conduit.xyz/pay/YOUR_DECLARATION_ID" }`;

// ── Network params ────────────────────────────────────────────────────────────
const NETWORK_PARAMS = [
  { key: "Chain ID",           value: String(ARC_TESTNET.chainId) },
  { key: "RPC",                value: ARC_TESTNET.rpc },
  { key: "WebSocket",          value: ARC_TESTNET.ws },
  { key: "Explorer",           value: ARC_TESTNET.explorer },
  { key: "USDC",               value: ARC_TESTNET.tokens.USDC },
  { key: "EURC",               value: ARC_TESTNET.tokens.EURC },
  { key: "CCTP Domain",        value: "26" },
  { key: "TokenMessengerV2",   value: ARC_TESTNET.contracts.cctpTokenMessenger },
  { key: "MessageTransmitterV2", value: ARC_TESTNET.contracts.cctpMessageTransmitter },
  { key: "Permit2",            value: ARC_TESTNET.contracts.permit2 },
  { key: "ConduitRouter",      value: process.env["NEXT_PUBLIC_CONDUIT_ROUTER"] ?? "(deploy first)" },
  { key: "DeclarationRegistry", value: process.env["NEXT_PUBLIC_DECLARATION_REGISTRY"] ?? "(deploy first)" },
];

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AgentPage() {
  const [payerTab, setPayerTab] = useState("Server / Agent");
  const [copiedParam, setCopiedParam] = useState<string | null>(null);

  const copyParam = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedParam(key);
    setTimeout(() => setCopiedParam(null), 2000);
  };

  return (
    <div className="min-h-screen bg-brand-black">
      <Nav />
      <main className="max-w-3xl mx-auto px-4 pt-24 pb-32 space-y-16">

        {/* ── Section 1: What is Conduit Relay ──────────────────────────── */}
        <div className="space-y-3">
          <p className="text-[10px] font-mono text-brand-green uppercase tracking-[0.18em]">
            Item 6 of 8
          </p>
          <h1 className="text-3xl font-anton text-brand-white">
            Conduit Relay
          </h1>
          <p className="text-brand-muted text-sm leading-relaxed max-w-lg">
            Autonomous payment execution for AI agents and services.
            Add one header to your endpoint — any agent with the Conduit SDK
            discovers your payment requirement and fulfills it automatically,
            in any currency, without human input.
          </p>
        </div>

        {/* ── Section 2: SDK Integration (for payers / agents) ──────────── */}
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-anton text-brand-white">
              SDK Integration
            </h2>
            <p className="text-brand-muted text-xs mt-1">
              For agents and services that need to discover and pay automatically.
            </p>
          </div>

          <Tabs
            tabs={["Server / Agent", "Browser / Frontend"]}
            active={payerTab}
            onChange={setPayerTab}
          />

          {payerTab === "Browser / Frontend" ? (
            <CodeBlock code={BROWSER_CODE} />
          ) : (
            <CodeBlock code={SERVER_CODE} />
          )}
        </div>

        {/* ── Section 3: Accept Agent Payments ──────────────────────────── */}
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-anton text-brand-white">
              Accept Agent Payments
            </h2>
            <p className="text-brand-muted text-xs mt-1">
              For services that want to be discovered and paid by autonomous agents.
            </p>
          </div>

          {/* Step 1 */}
          <div className="bg-brand-surface border border-brand-border rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-brand-green text-brand-black text-xs font-anton flex items-center justify-center flex-shrink-0">
                1
              </span>
              <h3 className="font-mono text-sm text-brand-white">
                Create a payment declaration
              </h3>
            </div>
            <p className="text-brand-muted text-xs leading-relaxed pl-9">
              A declaration says what your service wants to receive — currency, amount,
              recipient address. Agents read this and fulfill it automatically.
            </p>
            <div className="pl-9">
              <a
                href="/create"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-green text-brand-black text-sm font-mono hover:opacity-90 transition-opacity"
              >
                Create your payment declaration →
              </a>
            </div>
          </div>

          {/* Step 2 */}
          <div className="bg-brand-surface border border-brand-border rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-brand-green text-brand-black text-xs font-anton flex items-center justify-center flex-shrink-0">
                2
              </span>
              <h3 className="font-mono text-sm text-brand-white">
                Add the Conduit-Payment header to your service
              </h3>
            </div>
            <p className="text-brand-muted text-xs leading-relaxed pl-9">
              Any agent hitting your endpoint will automatically detect the declaration
              and can pay without human input.
            </p>
            <div className="pl-9">
              <CodeBlock code={EXPRESS_CODE} language="javascript" />
            </div>
          </div>
        </div>

        {/* ── Section 4: Network Reference (collapsible) ─────────────────── */}
        <details className="bg-brand-surface border border-brand-border rounded-2xl group">
          <summary className="p-5 text-sm font-mono text-brand-muted cursor-pointer
                               hover:text-brand-white transition-colors list-none flex items-center justify-between">
            <span>Network Parameters &amp; Contract Addresses</span>
            <span className="text-brand-muted group-open:rotate-180 transition-transform">▾</span>
          </summary>
          <div className="px-5 pb-5 space-y-1 border-t border-brand-border">
            {NETWORK_PARAMS.map(({ key, value }) => (
              <div
                key={key}
                className="flex items-center justify-between py-2.5 border-b border-brand-border/50 last:border-0"
              >
                <span className="text-xs font-mono text-brand-muted">{key}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-brand-white truncate max-w-[220px]">
                    {value}
                  </span>
                  <button
                    onClick={() => copyParam(key, value)}
                    className="text-[10px] font-mono text-brand-muted hover:text-brand-green transition-colors px-1.5 py-0.5 rounded"
                  >
                    {copiedParam === key ? "✓" : "copy"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>

      </main>
      <MobileNav />
    </div>
  );
}
