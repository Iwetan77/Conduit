"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import {
  usePrivyGate,
  requestGoogleLogin,
  GOOGLE_LOGIN_ALREADY,
  GOOGLE_LOGIN_FAILED,
  GOOGLE_LOGIN_STARTED,
} from "@/lib/privy-gate";
import { shortenAddress } from "@/lib/format";
import { logAuth } from "@/lib/auth-debug";

const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

// Payers get two ways in: a real wallet (injected/WalletConnect) or a Google
// sign-in that provisions a Privy embedded wallet. No business onboarding on
// this path — that's the dashboard's AccountGate, not this component.
// The button doesn't touch Privy hooks itself: it flags intent and lets
// providers.tsx lazily mount the Privy stack (see lib/privy-gate.tsx), so
// payer pages don't ship @privy-io/* until someone actually wants it.
function GoogleSignIn({ fullWidth = false, short = false }: { fullWidth?: boolean; short?: boolean }) {
  const [starting, setStarting] = useState(false);
  // "loading" = fetching/booting the Privy chunk; "opening" = initOAuth has
  // been called and we're waiting on the redirect. Shown on the button so a
  // hang says WHICH half is stuck instead of an undifferentiated "Opening…".
  const [stage, setStage] = useState<"loading" | "opening">("loading");
  const [error, setError] = useState("");

  // A failed OAuth start (provider disabled on the Privy app, popup blocked)
  // must reset the button — otherwise it reads as a permanent hang. The
  // timeout covers failures that never surface an error at all.
  //
  // The timeout is two-stage on purpose. A single flat 15s was itself a cause
  // of "sometimes it works, sometimes it errors out": clicking Google
  // downloads a ~700 kB lazy chunk and boots Privy, which on mobile data
  // routinely takes longer than that. The button then declared failure while
  // the sign-in was still coming, and often redirected a moment later. So:
  // a generous budget for boot, and a tight one once we know initOAuth has
  // actually been called (from there a redirect should be near-immediate).
  // Listeners are registered ONCE on mount, never gated on `starting`.
  //
  // Gating them on `starting` lost the answer outright. Clicking batches
  // setStarting(true) here with setPending(true) in the Privy stack; React
  // then runs effects for that commit in tree order, and StartGoogleOAuth
  // sits above this button, so the stack dispatched its outcome BEFORE this
  // effect had subscribed. When the outcome was "already authenticated" the
  // event vanished and the button sat on "Loading…" until the 45s budget
  // expired — the exact hang in the ?debug=auth trace.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const stop = () => {
      clearTimeout(timer.current);
      setStarting(false);
    };
    const fail = (msg: string) => {
      logAuth(`button: giving up -- ${msg}`);
      stop();
      setError(msg);
    };

    const onFail = (e: Event) =>
      fail((e as CustomEvent<string>).detail || "Google sign-in failed.");
    // Already signed in — nothing to open, and nothing broke.
    const onAlready = () => {
      logAuth("button: already signed in");
      stop();
    };
    // initOAuth has actually been called; from here a redirect should be
    // near-immediate, so the budget tightens.
    const onStarted = () => {
      setStage("opening");
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => fail("Google didn't open. Check that pop-ups aren't blocked, then try again."),
        20000
      );
    };

    window.addEventListener(GOOGLE_LOGIN_FAILED, onFail);
    window.addEventListener(GOOGLE_LOGIN_STARTED, onStarted);
    window.addEventListener(GOOGLE_LOGIN_ALREADY, onAlready);
    return () => {
      window.removeEventListener(GOOGLE_LOGIN_FAILED, onFail);
      window.removeEventListener(GOOGLE_LOGIN_STARTED, onStarted);
      window.removeEventListener(GOOGLE_LOGIN_ALREADY, onAlready);
      clearTimeout(timer.current);
    };
  }, []);

  return (
   <div className={fullWidth ? "w-full" : ""}>
    <button
      onClick={() => {
        logAuth("button: clicked");
        setError("");
        setStage("loading");
        setStarting(true);
        // Budget for downloading and booting the lazy Privy chunk. Started
        // here rather than in an effect so it can't race the outcome.
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          logAuth("button: giving up -- boot timeout");
          setStarting(false);
          setError("Sign-in is taking longer than expected. Check your connection and try again.");
        }, 45000);
        requestGoogleLogin();
      }}
      disabled={starting}
      className={`${fullWidth ? "w-full " : ""}px-4 py-2 text-scale-2 font-mono
                 border border-border text-ink-dim hover:text-ink hover:border-ink-dim
                 transition-colors disabled:opacity-50 whitespace-nowrap`}
    >
      {starting ? (
        stage === "loading" ? "Loading…" : "Opening…"
      ) : short ? (
        "Google"
      ) : (
        <>
          {/* Narrow screens can't fit both full labels on one row, and
              wrapping stacks them into two competing CTAs. */}
          <span className="sm:hidden">Google</span>
          <span className="hidden sm:inline">Sign in with Google</span>
        </>
      )}
    </button>
    {error && (
      <p className="mt-1 text-scale-1 font-mono text-danger max-w-[220px]">{error}</p>
    )}
   </div>
  );
}

// @privy-io/wagmi's createConfig STRIPS the injected/walletConnect
// connectors (it only keeps Privy-synced wallets), so once the Privy stack
// is mounted the wagmi connect buttons have nothing to connect with.
// External wallets must go through Privy's own connect modal instead —
// it handles MetaMask/WalletConnect and syncs the result back into wagmi.
function PrivyConnectWallet({ fullWidth = false }: { fullWidth?: boolean }) {
  const { connectWallet } = usePrivy();
  return (
    <button
      onClick={() => connectWallet()}
      className={`${fullWidth ? "w-full " : ""}px-4 py-2 text-scale-2 font-mono bg-signal text-signal-ink
                 hover:bg-signal/90 transition-colors whitespace-nowrap`}
    >
      Connect Wallet
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
  const { mounted: privyMounted } = usePrivyGate();

  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  if (isConnected && address) {
    return <ConnectedChip address={address} />;
  }

  const injected = connectors.find((c) => c.id === "injected" || c.type === "injected");

  return (
    // nowrap: wrapping put Connect Wallet and Google on separate lines on
    // mobile, reading as two stacked competing CTAs.
    <div className="flex flex-nowrap items-center justify-center gap-2">
      {privyMounted ? (
        <PrivyConnectWallet />
      ) : (
        <>
          {injected && (
            <button
              onClick={() => connect({ connector: injected })}
              disabled={isPending}
              className="px-4 py-2 text-scale-2 font-mono bg-signal text-signal-ink
                         hover:bg-signal/90 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {isPending ? "Connecting..." : "Connect Wallet"}
            </button>
          )}
        </>
      )}
      {PRIVY_ENABLED && <GoogleSignIn />}
    </div>
  );
}

export function WalletConnectCompact() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { mounted: privyMounted } = usePrivyGate();

  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  if (isConnected && address) {
    return <ConnectedChip address={address} compact />;
  }

  const connector =
    connectors.find((c) => c.id === "injected" || c.type === "injected") ?? connectors[0];

  // Side-by-side on one row — a stacked pair of full-width buttons read as
  // two competing CTAs on mobile.
  return (
    <div className="flex flex-row gap-2 w-full">
      <div className="flex-1">
        {privyMounted ? (
          <PrivyConnectWallet fullWidth />
        ) : (
          <button
            onClick={() => connector && connect({ connector })}
            disabled={isPending || !connector}
            className="px-4 py-2 text-scale-2 font-medium font-mono bg-signal text-signal-ink
                       w-full hover:bg-signal/90 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {isPending ? "Connecting..." : "Connect Wallet"}
          </button>
        )}
      </div>
      {PRIVY_ENABLED && <GoogleSignIn short />}
    </div>
  );
}
