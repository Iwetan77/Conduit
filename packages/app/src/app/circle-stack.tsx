"use client";

// The Circle counterpart to privy-stack.tsx.
//
// It is far smaller than the Privy stack, and the reason is the wagmi
// connector: Circle is already a wallet as far as wagmi is concerned, so there
// is no second provider tree to mount, no wallet-picking to arbitrate, and no
// window where useAccount() reports one wallet and then swaps to another. All
// this has to do is translate the app's existing sign-in and sign-out events
// into connect/disconnect on that connector.
//
// It deliberately reuses privy-gate's event names rather than inventing
// parallel ones. The Google button, the dashboard layout and every sign-out
// affordance already speak that vocabulary; giving Circle its own would mean
// editing all of them, which is exactly the cost this migration is avoiding.

import { useContext, useEffect, useMemo, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import { hasPendingResume, hasPersistedSession } from "@/lib/circle/browser";
import { createAccountFromCircle, getSessionToken, setSessionToken } from "@/lib/conduit-api";
import { PrivyGateContext } from "@/lib/privy-gate";
import { clearCircleSession, currentSession, onCircleChange } from "@/lib/circle/browser";
import {
  GOOGLE_LOGIN_ALREADY,
  GOOGLE_LOGIN_EVENT,
  GOOGLE_LOGIN_FAILED,
  GOOGLE_LOGIN_FLAG,
  GOOGLE_LOGIN_STARTED,
  SIGN_OUT_EVENT,
} from "@/lib/privy-gate";

export default function CircleStack() {
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { address, connector } = useAccount();

  useEffect(() => {
    const fire = (name: string) => window.dispatchEvent(new Event(name));

    const onLogin = async () => {
      const circle = connectors.find((c) => c.id === CIRCLE_CONNECTOR_ID);
      if (!circle) {
        // Nothing to connect to. Saying so beats a button stuck on "Opening…"
        // forever, which is what silence looks like from the outside.
        fire(GOOGLE_LOGIN_FAILED);
        return;
      }
      if (connector?.id === CIRCLE_CONNECTOR_ID) {
        fire(GOOGLE_LOGIN_ALREADY);
        return;
      }
      fire(GOOGLE_LOGIN_STARTED);
      // Cleared here, not in a finally: connect() never settles on the happy
      // path because the document is navigating away, so a finally would never
      // run and the flag would survive to trigger a phantom sign-in on the
      // next load.
      try {
        sessionStorage.removeItem(GOOGLE_LOGIN_FLAG);
      } catch {
        // Storage unavailable; the flag is a hint, not state worth failing on.
      }
      try {
        // Navigates to Google and never resolves on the happy path — the page
        // is gone. Anything that lands here is a real failure before the
        // redirect, so it is reported rather than swallowed.
        await connectAsync({ connector: circle });
      } catch (err) {
        // A session restored under us mid-click is not a failure.
        if (connector?.id === CIRCLE_CONNECTOR_ID) return;
        console.error("circle: sign-in failed", err);
        fire(GOOGLE_LOGIN_FAILED);
      }
    };

    const onSignOut = async () => {
      // Both halves, in this order. wagmi's disconnect alone leaves the Circle
      // session in localStorage, so the connector's isAuthorized() still says
      // yes and the next page load silently signs the user back in — the same
      // dead end privy-gate documents for Privy.
      try {
        await disconnectAsync();
      } finally {
        clearCircleSession();
      }
    };

    window.addEventListener(GOOGLE_LOGIN_EVENT, onLogin);
    window.addEventListener(SIGN_OUT_EVENT, onSignOut);
    return () => {
      window.removeEventListener(GOOGLE_LOGIN_EVENT, onLogin);
      window.removeEventListener(SIGN_OUT_EVENT, onSignOut);
    };
  }, [connectors, connectAsync, disconnectAsync, connector]);

  // Adopt a restored session into wagmi.
  //
  // Returning from Google leaves a live Circle session that wagmi does not
  // know about yet. The connector emits "connect" from setup(), but that is
  // not enough for wagmi to adopt it as the current connector -- so the user
  // came back signed in, saw "not connected", and had to press the button a
  // second time before the UI caught up. Going through wagmi's own connect
  // action is what actually sets its state; the connector short-circuits on
  // the existing session, so this costs no round trip and never re-opens
  // Google.
  useEffect(() => {
    let cancelled = false;
    const adopt = async () => {
      if (cancelled) return;
      if (connector?.id === CIRCLE_CONNECTOR_ID) return;
      if (!currentSession()) return;
      const circle = connectors.find((c) => c.id === CIRCLE_CONNECTOR_ID);
      if (!circle) return;
      try {
        await connectAsync({ connector: circle });
      } catch (err) {
        console.error("circle: could not adopt the restored session", err);
      }
    };
    void adopt();
    // The session may land after this mounts -- restoring it is asynchronous.
    const unsubscribe = onCircleChange(() => void adopt());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [connector, connectors, connectAsync]);

  // A Conduit session on EVERY signed-in page, not just the dashboard.
  //
  // The Privy stack does this in SyncSessionToken, and its comment says why:
  // /send needs a token to create a settlement intent, and when only the
  // dashboard issued one, a user who signed in anywhere else had no usable
  // credential. The Circle path had exactly that hole -- only CircleDashboard
  // stored a token -- so every payer flow outside the dashboard would have
  // been unauthenticated.
  //
  // Calling the bootstrap is safe for a payer with no merchant account: the
  // server returns the account and a session token when one exists, and
  // rejects the call when it would have to create one (it needs a name and
  // settle currency that a payer has not given). That rejection is expected,
  // not an error worth surfacing.
  useEffect(() => {
    if (!address || connector?.id !== CIRCLE_CONNECTOR_ID) return;
    if (getSessionToken()) return;
    const s = currentSession();
    if (!s) return;
    let cancelled = false;
    (async () => {
      try {
        const account = await createAccountFromCircle(s.userToken, { login_wallet: address });
        if (!cancelled && account.session_token) setSessionToken(account.session_token);
      } catch {
        // No Conduit account yet — onboarding lives in the dashboard.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, connector]);

  // Clear any stale intent flag on mount.
  //
  // This used to auto-dispatch a sign-in when it found the flag, to cover a
  // click that happened before this mounted. That is not needed -- CircleStack
  // mounts at app boot -- and it was actively harmful: it started a connect
  // that never settles, which left wagmi permanently "pending" and every
  // sign-in button disabled before the user had touched anything.
  useEffect(() => {
    try {
      sessionStorage.removeItem(GOOGLE_LOGIN_FLAG);
    } catch {
      // Storage unavailable; nothing to clean up.
    }
  }, []);

  return null;
}

// Tells the rest of the app when useAccount()'s address is final.
//
// The Privy stack has PublishWalletSettled for this, and the race it prevents
// exists here too: a browser extension auto-connects on load, and a moment
// later the restored Circle session is adopted and the address changes. Any
// surface that DISPLAYS an address — and offers to copy it — or reads a
// balance must wait, or it shows an account that is not the user's and invites
// them to send funds to it.
//
// Tested rather than timed, for the same reason: a timeout could only give up
// and display the wrong account, which is the failure this exists to prevent.
export function CircleWalletGate({ children }: { children: React.ReactNode }) {
  const outer = useContext(PrivyGateContext);
  const { connector } = useAccount();
  // Read once: both are one-shot module values, and re-reading after the
  // session is adopted would flip this back to "not settled".
  const [pendingAtLoad] = useState(() => hasPendingResume() || hasPersistedSession());

  // Nothing to wait for when no Circle session is coming back. Otherwise the
  // address is final only once the Circle connector is actually the connected
  // one.
  const settled = !pendingAtLoad || connector?.id === CIRCLE_CONNECTOR_ID;

  const value = useMemo(() => ({ ...outer, walletSettled: settled }), [outer, settled]);
  return <PrivyGateContext.Provider value={value}>{children}</PrivyGateContext.Provider>;
}
