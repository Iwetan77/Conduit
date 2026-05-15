"use client";

import { useState } from "react";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { ARC_TESTNET } from "@conduit/sdk";

export default function AgentPage() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const config = {
    chainId: ARC_TESTNET.chainId,
    rpc: ARC_TESTNET.rpc,
    ws: ARC_TESTNET.ws,
    usdcAddress: ARC_TESTNET.tokens.USDC,
    eurcAddress: ARC_TESTNET.tokens.EURC,
    routerAddress: process.env["NEXT_PUBLIC_CONDUIT_ROUTER"] ?? "(deploy first)",
    registryAddress: process.env["NEXT_PUBLIC_DECLARATION_REGISTRY"] ?? "(deploy first)",
  };

  return (
    <div className="min-h-screen bg-brand-black">
      <Nav />
      <main className="max-w-2xl mx-auto px-4 pt-24 pb-24 space-y-8">
        <div>
          <h1 className="text-3xl font-display font-black text-brand-white">Agent Config</h1>
          <p className="text-brand-muted text-sm mt-1">
            Network parameters for autonomous agents integrating with Conduit
          </p>
        </div>

        {/* SDK snippet */}
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-6 space-y-4">
          <h2 className="text-sm font-mono text-brand-muted uppercase tracking-wider">
            SDK Quick Start
          </h2>
          <pre className="bg-black rounded-xl p-4 text-xs font-mono text-brand-white overflow-x-auto">
{`import { ConduitClient } from "@conduit/sdk";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("${ARC_TESTNET.rpc}");
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const conduit = new ConduitClient({ signer });

// Direct send
await conduit.pay({
  recipient: "0xRECIPIENT",
  amount: 10_000_000n, // $10 USDC (6 decimals)
  currency: "USDC",
});

// Create payment link
const { paymentUrl } = await conduit.createLink({
  amount: 0n,    // 0 = open amount
  currency: "USDC",
});`}
          </pre>
        </div>

        {/* Network config */}
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-6 space-y-3">
          <h2 className="text-sm font-mono text-brand-muted uppercase tracking-wider">
            Network Parameters
          </h2>
          {Object.entries(config).map(([key, value]) => (
            <div
              key={key}
              className="flex items-center justify-between py-2 border-b border-brand-border last:border-0"
            >
              <span className="text-sm font-mono text-brand-muted">{key}</span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-brand-white truncate max-w-[200px]">
                  {String(value)}
                </span>
                <button
                  onClick={() => copy(key, String(value))}
                  className="text-xs text-brand-muted hover:text-brand-green transition-colors px-2 py-1 rounded"
                >
                  {copied === key ? "✓" : "copy"}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* CCTP info */}
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-6 space-y-3">
          <h2 className="text-sm font-mono text-brand-muted uppercase tracking-wider">
            CCTP v2 (Cross-Chain)
          </h2>
          <div className="text-xs font-mono text-brand-muted space-y-1">
            <p>Arc Domain: <span className="text-brand-white">26</span></p>
            <p>TokenMessengerV2: <span className="text-brand-white">{ARC_TESTNET.contracts.cctpTokenMessenger}</span></p>
            <p>MessageTransmitterV2: <span className="text-brand-white">{ARC_TESTNET.contracts.cctpMessageTransmitter}</span></p>
            <p>Permit2: <span className="text-brand-white">{ARC_TESTNET.contracts.permit2}</span></p>
          </div>
        </div>
      </main>
      <MobileNav />
    </div>
  );
}
