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

import { useEffect } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
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
  const { connector } = useAccount();

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
