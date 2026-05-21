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
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg
                      bg-brand-surface border border-brand-border">
        <span className="w-2 h-2 rounded-full bg-brand-green animate-pulse" />
        <span className="text-sm font-mono text-brand-white">{shortenAddress(address)}</span>
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
          className="px-4 py-2 rounded-lg text-sm font-mono bg-brand-green text-brand-black
                     hover:bg-brand-green/90 transition-colors disabled:opacity-50"
        >
          {isPending ? "Connecting..." : "Connect Wallet"}
        </button>
      )}
      {wc && (
        <button
          onClick={() => connect({ connector: wc })}
          disabled={isPending}
          className="px-3 py-2 rounded-lg text-sm font-mono border border-brand-border
                     text-brand-muted hover:text-brand-white hover:border-brand-white/20
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
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full
                      bg-brand-surface border border-brand-border">
        <span className="w-1.5 h-1.5 rounded-full bg-brand-green" />
        <span className="text-xs font-mono">{shortenAddress(address, 3)}</span>
      </div>
    );
  }

  const connector = connectors[0];

  return (
    <button
      onClick={() => connector && connect({ connector })}
      disabled={isPending}
      className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-green text-brand-black
                 w-full hover:bg-brand-green/90 transition-colors disabled:opacity-50"
    >
      {isPending ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}
