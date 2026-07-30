"use client";

import { useState, useEffect } from "react";
import { useAccount, useConnect } from "wagmi";
import { shortenAddress } from "@/lib/format";

export function WalletConnect() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();

  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2 px-3 py-2
                      bg-surface border border-border">
        <span className="w-2 h-2 bg-signal animate-pulse" />
        <span className="text-scale-2 font-mono text-ink">{shortenAddress(address)}</span>
      </div>
    );
  }

  const injected = connectors.find((c) => c.id === "injected");
  const wc = connectors.find((c) => c.id === "walletConnect");

  return (
    <div className="flex items-center gap-2">
      {injected && (
        <button
          onClick={() => connect({ connector: injected })}
          disabled={isPending}
          className="px-4 py-2 text-scale-2 font-mono bg-signal text-signal-ink
                     hover:bg-signal/90 transition-colors disabled:opacity-50"
        >
          {isPending ? "Connecting..." : "Connect Wallet"}
        </button>
      )}
      {wc && (
        <button
          onClick={() => connect({ connector: wc })}
          disabled={isPending}
          className="px-3 py-2 text-scale-2 font-mono border border-border
                     text-ink-dim hover:text-ink hover:border-ink-dim
                     transition-colors disabled:opacity-50"
        >
          WalletConnect
        </button>
      )}
    </div>
  );
}

export function WalletConnectCompact() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();

  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5
                      bg-surface border border-border">
        <span className="w-1.5 h-1.5 bg-signal" />
        <span className="text-scale-1 font-mono text-ink">{shortenAddress(address, 3)}</span>
      </div>
    );
  }

  const connector = connectors[0];

  return (
    <button
      onClick={() => connector && connect({ connector })}
      disabled={isPending}
      className="px-4 py-2 text-scale-2 font-medium font-mono bg-signal text-signal-ink
                 w-full hover:bg-signal/90 transition-colors disabled:opacity-50"
    >
      {isPending ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}
