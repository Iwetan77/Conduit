"use client";

import { usePayerIdentity } from "@/lib/use-payer-identity";

/**
 * What to show a Solana wallet on a surface that can only work on Arc.
 *
 * Three of these surfaces — Create, Links, History — gated on wagmi's
 * `isConnected`, which knows only about EVM. So a connected Solana wallet read
 * as "not connected" and got "Connect your wallet" printed directly above its
 * own connected address: a loop with no exit, where doing the one thing the
 * page asked for changed nothing.
 *
 * The limitation is real rather than an oversight, and differs per surface, so
 * each says its own reason. What they share is refusing to pretend the wallet
 * is absent when it is plainly connected, and always offering the way forward.
 */
export function ArcOnlyNotice({ title, body }: { title: string; body: React.ReactNode }) {
  const { disconnect } = usePayerIdentity();
  return (
    <div className="text-center py-16 space-y-4 max-w-sm mx-auto">
      <p className="text-ink font-medium">{title}</p>
      <div className="text-ink-dim text-sm leading-relaxed space-y-3">{body}</div>
      <button
        type="button"
        onClick={() => void disconnect()}
        className="text-scale-1 font-mono text-ink-dim hover:text-ink transition-colors"
      >
        Disconnect this wallet →
      </button>
    </div>
  );
}
