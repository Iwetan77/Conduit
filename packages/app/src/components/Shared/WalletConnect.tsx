"use client";

import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/wagmi";
import { shortenAddress } from "@/lib/format";
import { motion } from "framer-motion";

export function WalletConnect() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;

  if (isWrongNetwork) {
    return (
      <button
        onClick={() => switchChain({ chainId: arcTestnet.id })}
        className="px-4 py-2 rounded-lg text-sm font-mono font-medium
                   bg-yellow-500/10 text-yellow-400 border border-yellow-500/30
                   hover:bg-yellow-500/20 transition-colors"
      >
        Switch to Arc Testnet
      </button>
    );
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center justify-center gap-2">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg
                        bg-brand-surface border border-brand-border">
          <span className="w-2 h-2 rounded-full bg-brand-green animate-pulse" />
          <span className="text-sm font-mono text-brand-white">
            {shortenAddress(address)}
          </span>
        </div>
        <button
          onClick={() => disconnect()}
          className="px-3 py-2 rounded-lg text-sm text-brand-muted
                     hover:text-brand-white border border-brand-border
                     hover:border-brand-white/20 transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  // Show injected connector first, then WalletConnect
  const injectedConnector = connectors.find((c) => c.id === "injected");
  const wcConnector = connectors.find((c) => c.id === "walletConnect");

  return (
    <div className="flex items-center justify-center gap-2">
      {injectedConnector && (
        <button
          onClick={() => connect({ connector: injectedConnector })}
          disabled={isPending}
          className="px-4 py-2 rounded-lg text-sm font-medium
                     bg-brand-green text-brand-black
                     hover:bg-brand-green/90 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? "Connecting..." : "Connect Wallet"}
        </button>
      )}
      {wcConnector && (
        <button
          onClick={() => connect({ connector: wcConnector })}
          disabled={isPending}
          className="px-4 py-2 rounded-lg text-sm font-medium
                     border border-brand-border text-brand-white
                     hover:border-brand-green/50 transition-colors
                     disabled:opacity-50"
        >
          WalletConnect
        </button>
      )}
    </div>
  );
}

// Compact version for mobile
export function WalletConnectCompact() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();

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
      className="px-4 py-2 rounded-lg text-sm font-medium
                 bg-brand-green text-brand-black w-full
                 hover:bg-brand-green/90 transition-colors
                 disabled:opacity-50"
    >
      {isPending ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}
