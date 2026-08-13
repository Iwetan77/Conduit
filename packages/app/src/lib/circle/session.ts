"use client";

// React binding for the Circle session in lib/circle/browser.ts.
//
// This used to hold the login logic itself. It cannot any more, and the reason
// is worth stating: both modules read and CLEAR the same one-shot resume stash
// at module scope. Once lib/wagmi pulled the connector (and so browser.ts) into
// every page, whichever module happened to evaluate first consumed the stash
// and the other saw nothing — so a page using this hook would report "no run to
// resume" on a redirect that was working fine. Two owners of a one-shot value
// is the bug; one owner and a binding is the fix.
//
// The public shape is unchanged so /dev/circle-tx keeps working untouched.

import { useCallback, useEffect, useReducer, useState } from "react";
import {
  circleLog,
  configureCircle,
  currentSession,
  executeChallenge,
  hasPendingResume,
  onCircleChange,
  restoreSession,
  startGoogleSignIn,
  type CircleConfig,
  type CircleWallet,
} from "@/lib/circle/browser";

export type { CircleWallet } from "@/lib/circle/browser";
export type CircleStatus = "idle" | "connecting" | "ready" | "error";

export interface CircleSession {
  status: CircleStatus;
  error?: string;
  wallet?: CircleWallet;
  userToken?: string;
  /** True when this page load is completing a redirect from Google. */
  resuming: boolean;
  signIn: () => void;
  /** Runs a Circle challenge in Circle's own UI. */
  execute: (challengeId: string) => Promise<unknown>;
  log: string[];
}

export type CircleSessionOptions = CircleConfig;

export function useCircleSession(opts: CircleSessionOptions): CircleSession {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState(false);

  // Set before anything can call restoreSession(). Idempotent — the connector
  // configures the same singleton at app boot, and the last writer wins, which
  // matters only for redirectPath: sign-in from this page must come back to
  // this page.
  configureCircle(opts);

  // Re-render when the shared session changes — it lives outside React, so
  // nothing else would tell this component the wallet arrived.
  useEffect(() => onCircleChange(bump), []);

  // Finish a login that redirected away. Safe to call unconditionally:
  // restoreSession is memoised and returns null when there is nothing pending.
  useEffect(() => {
    if (!hasPendingResume() || currentSession()) return;
    setConnecting(true);
    restoreSession()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setConnecting(false));
  }, []);

  const signIn = useCallback(() => {
    setError(undefined);
    setConnecting(true);
    startGoogleSignIn().catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setConnecting(false);
    });
  }, []);

  const session = currentSession();
  const status: CircleStatus = session
    ? "ready"
    : error
      ? "error"
      : connecting
        ? "connecting"
        : "idle";

  return {
    status,
    error,
    wallet: session?.wallet,
    userToken: session?.userToken,
    resuming: hasPendingResume(),
    signIn,
    execute: executeChallenge,
    log: [...circleLog()],
  };
}
