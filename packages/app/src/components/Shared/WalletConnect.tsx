"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import {
  useWalletGate,
  requestGoogleLogin,
  requestSignOut,
  GOOGLE_LOGIN_ALREADY,
  GOOGLE_LOGIN_FAILED,
  GOOGLE_LOGIN_STARTED,
} from "@/lib/wallet-gate";
import { shortenAddress } from "@/lib/format";
import { usePayerIdentity } from "@/lib/use-payer-identity";
import { usePayerUsdc } from "@/lib/use-payer-usdc";
import { chainLabel, usdcDisplay } from "@/lib/unified-balance";

// Google sign-in exists when Circle is configured. There is no provider flag
// any more: Privy was removed in Phase 7, so this is the only Google path and
// there is nothing to choose between. A deployment without Circle credentials
// simply shows wallet-only sign-in, which is the same graceful degradation the
// WalletConnect connector already gets in lib/wagmi.ts.
const CIRCLE_ENABLED = Boolean(process.env.NEXT_PUBLIC_CIRCLE_APP_ID);

// Payers get two ways in: a real wallet (injected/WalletConnect) or a Google
// sign-in that provisions a Circle user-controlled wallet. No business
// onboarding on this path — that's the dashboard's AccountGate, not this
// component.
//
// The button touches no SDK itself: it dispatches an event and lets
// circle-stack.tsx do the work (see lib/wallet-gate.tsx). Under Privy that
// indirection existed to keep ~700 kB of @privy-io/* out of the payer bundle;
// it is kept because it is also what lets the button stay dumb while the
// sign-in mechanism changes underneath it — which is exactly what just
// happened.
function GoogleSignIn({ fullWidth = false, short = false }: { fullWidth?: boolean; short?: boolean }) {
  const [starting, setStarting] = useState(false);
  // "loading" = fetching the Circle SDK chunk and minting a device token;
  // "opening" = the redirect to Google is under way. Not shown to the user —
  // it only selects which timeout budget applies (see below).
  const [stage, setStage] = useState<"loading" | "opening">("loading");
  const [error, setError] = useState("");

  // A failed sign-in start (Circle unreachable, device token refused, redirect
  // blocked) must reset the button — otherwise it reads as a permanent hang.
  // The timeout covers failures that never surface an error at all.
  //
  // The timeout is two-stage on purpose. A single flat 15s was itself a cause
  // of "sometimes it works, sometimes it errors out": clicking Google
  // downloads the SDK chunk and makes a server round trip for a device token,
  // which on mobile data routinely takes longer than that. The button then
  // declared failure while the sign-in was still coming, and often redirected
  // a moment later. So: a generous budget for boot, and a tight one once the
  // redirect is known to be under way (from there it should be near-immediate).
  // Listeners are registered ONCE on mount, never gated on `starting`.
  //
  // Gating them on `starting` lost the answer outright: the stack can dispatch
  // its outcome before this effect has subscribed, and the event vanishes.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const stop = () => {
      clearTimeout(timer.current);
      setStarting(false);
    };
    const fail = (msg: string) => {
      stop();
      setError(msg);
    };

    const onFail = (e: Event) =>
      fail((e as CustomEvent<string>).detail || "Google sign-in failed.");
    // Already signed in — nothing to open, and nothing broke.
    const onAlready = () => {
      stop();
    };
    // The redirect to Google is actually under way; from here it should be
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
        setError("");
        setStage("loading");
        setStarting(true);
        // Budget for downloading the SDK chunk and minting a device token.
        // Started here rather than in an effect so it can't race the outcome.
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
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
        // One label for both stages. "Loading…" vs "Opening…" is a distinction
        // about our chunk loading, which means nothing to the person waiting —
        // the stage still drives the timeouts, it just isn't narrated.
        "Signing in…"
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

// Sign-out.
//
// Two components used to live here: one that called Privy's own connect modal
// (@privy-io/wagmi stripped the injected/walletConnect connectors, so the
// plain wagmi buttons had nothing to connect with while Privy was mounted) and
// one that signed out of Privy. Both are gone with Privy. The Circle connector
// sits alongside injected() and walletConnect() in one config, so the ordinary
// wagmi buttons work for everyone and there is nothing to branch on.
//
// A bare wagmi disconnect is still not enough: the Circle session stays in
// localStorage, the connector's isAuthorized() still says yes, and the next
// page load silently signs the user back in. So sign-out goes through the
// event, which CircleStack handles by disconnecting AND clearing the session.
// A bare x inside the chip stood here. Removed: the chip is the balance
// control now, so a tap has to mean "show me my money", and Disconnect is a
// labelled button beside it rather than a glyph competing with it.

// The connected wallet, and what it holds.
//
// This used to be an address and an x. The x was redundant -- Disconnect sits
// beside it -- and the balance, the one thing a payer wants to know before
// typing an amount, was nowhere on the page. Tapping the chip now answers it.
//
// Per chain, never summed. One payment draws from a single chain, so a total
// would promise an amount that cannot be sent.
function ConnectedChip({
  address,
  compact = false,
  onDisconnect,
}: {
  address: string;
  compact?: boolean;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { identity } = usePayerIdentity();
  const usdc = usePayerUsdc({
    address: identity?.address,
    family: identity?.kind,
    enabled: !!identity && open,
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Show balances"
        className={`inline-flex items-center ${compact ? "gap-1.5 px-3 py-1.5" : "gap-2 px-3 py-2"}
                    bg-surface border border-border hover:border-ink-dim transition-colors`}
      >
        <span className={`${compact ? "w-1.5 h-1.5" : "w-2 h-2 animate-pulse"} bg-signal`} />
        <span className={`${compact ? "text-scale-1" : "text-scale-2"} font-mono text-ink`}>
          {shortenAddress(address, compact ? 3 : 4)}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 min-w-[13rem] border border-border bg-surface p-3 space-y-1.5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-dim">
            Your USDC
          </p>
          {usdc.loading && usdc.funded.length === 0 ? (
            <p className="font-mono text-scale-1 text-ink-dim">Reading…</p>
          ) : usdc.funded.length === 0 ? (
            <p className="font-mono text-scale-1 text-ink-dim">
              {usdc.error || "None found on any supported chain."}
            </p>
          ) : (
            usdc.funded.map((c) => (
              <div key={c.chain} className="flex items-baseline justify-between gap-4">
                <span className="font-mono text-scale-1 text-ink-dim">{chainLabel(c.chain)}</span>
                <span className="font-mono text-scale-2 text-ink">{usdcDisplay(c.minor)}</span>
              </div>
            ))
          )}
          {/* Disconnect lives in here, not beside the chip.
              That is the pattern the Google session already used, and a payer
              should not have to learn two. It also keeps a destructive action
              behind a deliberate tap rather than one stray thumb from the
              address. */}
          <button
            onClick={onDisconnect}
            className="w-full mt-2 pt-2 border-t border-border text-left
                       font-mono text-scale-1 text-ink-dim hover:text-danger transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

// Every wallet family, everywhere this renders.
//
// Solana was briefly opt-in per surface, which broke the one promise this
// component exists to keep: the nav rendered it without the flag and the send
// page with it, so a connected Solana wallet showed as a chip at the bottom of
// the page and as "Connect Wallet" at the top. Two controls disagreeing about
// the same wallet is worse than either answer alone.
//
// A Solana wallet genuinely cannot do everything an EVM one can -- it cannot
// sign on Arc -- but that is a fact about specific ACTIONS, and actions are
// where it belongs. Refusing the connection outright to prevent a later
// failure means the payer cannot connect the only wallet they own.
export function WalletConnect() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { walletSettled } = useWalletGate();
  const { identity, solanaWallets, connectSolana, disconnect, connecting, error } =
    usePayerIdentity();
  const [picking, setPicking] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  // A connected Solana wallet is the answer to "who is paying", so it is shown
  // in place of the connect buttons exactly as an EVM one is.
  if (identity?.kind === "solana") {
    return (
      <ConnectedChip address={identity.address} onDisconnect={() => void disconnect()} />
    );
  }

  // Same reason as the nav: before the Circle session has been adopted,
  // `address` may be whatever wallet an extension auto-connected rather than
  // the one this user signed in with, and showing it invites acting on the
  // wrong account.
  if (!walletSettled) return null;

  // Same shape as the Solana branch above. The chip no longer carries an x, so
  // without this an EVM payer had a balance to look at and no way to disconnect.
  if (isConnected && address) {
    return (
      <ConnectedChip
        address={address}
        onDisconnect={() => (CIRCLE_ENABLED ? requestSignOut() : void disconnect())}
      />
    );
  }

  const injected = connectors.find((c) => c.id === "injected" || c.type === "injected");

  return (
    <div className="flex flex-col items-center gap-2">
    {/* nowrap: wrapping put Connect Wallet and Google on separate lines on
        mobile, reading as two stacked competing CTAs. */}
    <div className="flex flex-nowrap items-center justify-center gap-2">
      {/* One Connect Wallet button, whatever the wallet is.
          Solana wallets are choices INSIDE it, never a second button beside
          it: "connect a wallet" is one intent, and splitting it by chain
          family makes the payer answer a question about our plumbing before
          they can answer the one they came with. With no Solana extension
          present this behaves exactly as it always did -- one click, straight
          into the browser wallet. */}
      {(injected || solanaWallets.length > 0) && (
        <div className="relative">
          <button
            onClick={() => {
              if (solanaWallets.length === 0 && injected) connect({ connector: injected });
              else setPicking((p) => !p);
            }}
            disabled={isPending || connecting}
            className="px-4 py-2 text-scale-2 font-mono bg-signal text-signal-ink
                       hover:bg-signal/90 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {isPending || connecting ? "Connecting..." : "Connect Wallet"}
          </button>

          {picking && (
            <div className="absolute left-0 top-full mt-1 z-40 min-w-[13rem] border border-border bg-surface">
              {injected && (
                <button
                  onClick={() => { setPicking(false); connect({ connector: injected }); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-scale-2 font-mono
                             text-left text-ink-dim hover:text-ink hover:bg-bg/40 transition-colors"
                >
                  Browser wallet
                </button>
              )}
              {solanaWallets.map((w) => (
                <button
                  key={w.id}
                  onClick={() => { setPicking(false); void connectSolana(w); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-scale-2 font-mono
                             text-left text-ink-dim hover:text-ink hover:bg-bg/40 transition-colors"
                >
                  {/* The wallet's own icon, when it registered one. Plain img:
                      a data URI from the extension, not one of our assets. */}
                  {w.icon && <img src={w.icon} alt="" width={16} height={16} />}
                  {w.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {CIRCLE_ENABLED && <GoogleSignIn />}

    </div>
    {/* Under the buttons rather than inside them: "no Solana wallet found" is
        advice about this browser, not a failure of the click. */}
    {error && (
      <p className="text-scale-1 text-danger max-w-xs text-center">{error}</p>
    )}
    </div>
  );
}

export function WalletConnectCompact() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { walletSettled } = useWalletGate();
  // Same identity as the desktop nav. Reading wagmi alone here would recreate
  // the split on mobile: connected on Solana, still asking you to connect.
  const { identity, solanaWallets, connectSolana, disconnect, connecting } = usePayerIdentity();
  const [picking, setPicking] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  if (!walletSettled) return null;

  if (identity?.kind === "solana") {
    return (
      <ConnectedChip address={identity.address} compact onDisconnect={() => void disconnect()} />
    );
  }

  if (isConnected && address) {
    return (
      <ConnectedChip
        address={address}
        compact
        onDisconnect={() => (CIRCLE_ENABLED ? requestSignOut() : void disconnect())}
      />
    );
  }

  const connector =
    connectors.find((c) => c.id === "injected" || c.type === "injected") ?? connectors[0];

  // Side-by-side on one row — a stacked pair of full-width buttons read as
  // two competing CTAs on mobile.
  return (
    <div className="flex flex-row gap-2 w-full">
      <div className="flex-1 relative">
        <button
          onClick={() => {
            if (solanaWallets.length === 0 && connector) connect({ connector });
            else setPicking((p) => !p);
          }}
          disabled={(isPending || connecting) || (!connector && solanaWallets.length === 0)}
          className="px-4 py-2 text-scale-2 font-medium font-mono bg-signal text-signal-ink
                     w-full hover:bg-signal/90 transition-colors disabled:opacity-50 whitespace-nowrap"
        >
          {isPending || connecting ? "Connecting..." : "Connect Wallet"}
        </button>
        {picking && (
          <div className="absolute left-0 right-0 top-full mt-1 z-40 border border-border bg-surface">
            {connector && (
              <button
                onClick={() => { setPicking(false); connect({ connector }); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-scale-2 font-mono
                           text-left text-ink-dim hover:text-ink hover:bg-bg/40 transition-colors"
              >
                Browser wallet
              </button>
            )}
            {solanaWallets.map((w) => (
              <button
                key={w.id}
                onClick={() => { setPicking(false); void connectSolana(w); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-scale-2 font-mono
                           text-left text-ink-dim hover:text-ink hover:bg-bg/40 transition-colors"
              >
                {w.icon && <img src={w.icon} alt="" width={16} height={16} />}
                {w.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {CIRCLE_ENABLED && <GoogleSignIn short />}
    </div>
  );
}
