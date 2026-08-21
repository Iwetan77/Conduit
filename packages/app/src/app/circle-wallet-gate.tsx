"use client";

// The wallet gate, extracted so it can render on the SERVER.
//
// This lived in circle-stack.tsx, which imports the Circle SDK at module scope,
// so providers.tsx could only reach it through dynamic(ssr:false) -- and because
// it wraps every child of the root layout, that one flag meant NO client-side
// page in this application server-rendered its body. Every route shipped chrome
// and a <title> and nothing else, then hydrated, then downloaded this chunk,
// then finally painted its content. It is the largest single cause of "one
// screen shows before the other", and it quietly made the five loading.tsx
// boundaries in the codebase dead weight: there was no server render for them
// to bridge from. (Server-component pages such as /docs escaped it, which is
// why those alone looked fine.)
//
// Nothing here needs the SDK. The gate computes one boolean. So it imports only
// the session predicates -- all of which are `typeof window` guarded and safe on
// the server -- and providers.tsx imports it statically. CircleStack, which does
// touch the SDK, stays dynamic(ssr:false); it renders null and gates nothing.
import { useContext, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import {
  currentSession,
  hasPendingResume,
  hasPersistedSession,
  onCircleChange,
} from "@/lib/circle/browser";
import { WalletGateContext } from "@/lib/wallet-gate";

/**
 * Holds back anything that DISPLAYS an address until the Circle session has
 * been adopted — otherwise an auto-connected extension's address paints first
 * and then swaps to the signed-in one.
 *
 * It holds back nothing else. `children` render immediately, on the server
 * included; only consumers that read `walletSettled` wait.
 */
export function CircleWalletGate({ children }: { children: React.ReactNode }) {
  const outer = useContext(WalletGateContext);
  const { connector } = useAccount();

  // Every one of these starts false, on the server AND on the first client
  // render, and moves only in an effect.
  //
  // That is not defensive style, it is the whole reason this component can be
  // server-rendered at all. The predicates below read sessionStorage and
  // localStorage, which the server cannot see: computing them during render
  // would make the server say "settled" and the client say "not settled" for
  // the same markup. React calls that a hydration mismatch, and what the user
  // sees is the same flash this component was extracted to remove.
  const [hydrated, setHydrated] = useState(false);
  // Was a session coming when this page loaded? Captured ONCE.
  //
  // Deliberately not recomputed. It answers a question about page load, and
  // re-reading it later is a bug with a nasty shape: signing out clears the
  // session but cannot change a value about the past, so a recomputed version
  // stuck at "not settled" forever and every surface gated on it -- the nav,
  // both Connect Wallet buttons -- rendered null with no way back but a reload.
  const [pendingAtLoad, setPendingAtLoad] = useState(false);
  // Whether a session is still expected. This one DOES track changes.
  const [sessionExpected, setSessionExpected] = useState(false);

  useEffect(() => {
    const expected = () =>
      hasPendingResume() || !!currentSession() || hasPersistedSession();
    setPendingAtLoad(hasPendingResume() || hasPersistedSession());
    setSessionExpected(expected());
    setHydrated(true);
    // A resume that fails calls clearCircleSession(), which emits, so the
    // failure path settles through this subscription rather than hanging.
    return onCircleChange(() => setSessionExpected(expected()));
  }, []);

  // Nothing to wait for when no Circle session is coming back. Otherwise the
  // address is final only once the Circle connector is actually the connected
  // one.
  //
  // `hydrated` in front of it keeps the first client render identical to the
  // server's. It costs one frame of "not settled" for everyone, which is free
  // in practice: the components that read this already blank their own first
  // paint behind a hydration check of their own.
  const settled =
    hydrated &&
    (!pendingAtLoad || connector?.id === CIRCLE_CONNECTOR_ID || !sessionExpected);

  const value = useMemo(() => ({ ...outer, walletSettled: settled }), [outer, settled]);
  return <WalletGateContext.Provider value={value}>{children}</WalletGateContext.Provider>;
}
