"use client";

import { useState, useEffect } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import { usePrivyGate, requestGoogleLogin } from "@/lib/privy-gate";
import { shortenAddress } from "@/lib/format";

const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

// Payers get two ways in: a real wallet (injected/WalletConnect) or a Google
// sign-in that provisions a Privy embedded wallet. No business onboarding on
// this path — that's the dashboard's AccountGate, not this component.
// The button doesn't touch Privy hooks itself: it flags intent and lets
// providers.tsx lazily mount the Privy stack (see lib/privy-gate.tsx), so
// payer pages don't ship @privy-io/* until someone actually wants it.
function GoogleSignIn({ fullWidth = false }: { fullWidth?: boolean }) {
  const [starting, setStarting] = useState(false);

  return (
    <button
      onClick={() => {
        setStarting(true);
        requestGoogleLogin();
      }}
      disabled={starting}
      className={`${fullWidth ? "w-full " : ""}px-4 py-2 text-scale-2 font-mono
                 border border-border text-ink-dim hover:text-ink hover:border-ink-dim
                 transition-colors disabled:opacity-50`}
    >
      {starting ? "Opening Google…" : "Sign in with Google"}
    </button>
  );
}

// Rendered only when the Privy stack is mounted (usePrivy throws otherwise).
function PrivySignOut() {
  const { authenticated, logout } = usePrivy();
  if (!authenticated) return null;
  return (
    <button
      onClick={() => logout()}
      className="ml-1 text-scale-2 font-mono text-ink-dim hover:text-danger transition-colors leading-none"
      title="Sign out"
      aria-label="Sign out"
    >
      ×
    </button>
  );
}

function DisconnectX() {
  const { disconnect } = useDisconnect();
  return (
    <button
      onClick={() => disconnect()}
      className="ml-1 text-scale-2 font-mono text-ink-dim hover:text-danger transition-colors leading-none"
      title="Disconnect"
      aria-label="Disconnect"
    >
      ×
    </button>
  );
}

function ConnectedChip({ address, compact = false }: { address: string; compact?: boolean }) {
  const { mounted } = usePrivyGate();

  return (
    <div
      className={`inline-flex items-center ${compact ? "gap-1.5 px-3 py-1.5" : "gap-2 px-3 py-2"}
                  bg-surface border border-border`}
    >
      <span className={`${compact ? "w-1.5 h-1.5" : "w-2 h-2 animate-pulse"} bg-signal`} />
      <span className={`${compact ? "text-scale-1" : "text-scale-2"} font-mono text-ink`}>
        {shortenAddress(address, compact ? 3 : 4)}
      </span>
      {mounted ? <PrivySignOut /> : <DisconnectX />}
    </div>
  );
}

export function WalletConnect() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();

  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  if (isConnected && address) {
    return <ConnectedChip address={address} />;
  }

  const injected = connectors.find((c) => c.id === "injected");
  const wc = connectors.find((c) => c.id === "walletConnect");

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
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
      {PRIVY_ENABLED && <GoogleSignIn />}
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
    return <ConnectedChip address={address} compact />;
  }

  const connector = connectors[0];

  return (
    <div className="flex flex-col gap-2 w-full">
      <button
        onClick={() => connector && connect({ connector })}
        disabled={isPending}
        className="px-4 py-2 text-scale-2 font-medium font-mono bg-signal text-signal-ink
                   w-full hover:bg-signal/90 transition-colors disabled:opacity-50"
      >
        {isPending ? "Connecting..." : "Connect Wallet"}
      </button>
      {PRIVY_ENABLED && <GoogleSignIn fullWidth />}
    </div>
  );
}
