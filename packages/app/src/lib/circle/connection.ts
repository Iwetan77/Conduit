"use client";

// Which wallet is the merchant signed in AS — asked of the Circle connection
// itself, not of whichever connector wagmi happens to be calling "current".
//
// That distinction is what took the dashboard down. wagmi keeps a MAP of live
// connections and ONE `current` pointer into it, and every gate in this app
// asked `useAccount().connector?.id === CIRCLE_CONNECTOR_ID`. That is the
// question "is the Circle wallet the current one", which is not the question
// "is this merchant signed in". The two come apart the moment a second
// connector is also live — the ordinary state for anyone who has a wallet
// extension installed — because of two behaviours in @wagmi/core:
//
//   - reconnect() (which WagmiProvider runs on every page load) authorises
//     EVERY connector that answers, and the FIRST one to answer becomes
//     `current`. Its ordering is driven by the stored `recentConnectorId`.
//   - disconnect() drops the current connector and then PROMOTES another open
//     connection in its place, writing THAT one's id as `recentConnectorId`
//     on the way out.
//
// So: sign in with Google, connect a browser wallet at some point, press
// disconnect. wagmi hands `recentConnectorId` to the extension. Every page
// load after that reconnects the extension first, it takes `current`, and the
// dashboard — reading `current` — decides a merchant with a perfectly live
// Circle session is signed out and renders the sign-in screen at them. On
// every page. With no way back, because signing in again reconnects the
// extension again on the next load.
//
// Asking about the CONNECTION instead of the pointer removes that whole class
// of bug: a browser wallet being attached is simply not evidence about whether
// somebody is signed in.
import { useConnections } from "wagmi";
import type { Connector } from "wagmi";
import { CIRCLE_CONNECTOR_ID } from "@/lib/circle/connector";
import { wagmiConfig } from "@/lib/wagmi";

/** The live Circle connection, whether or not it is wagmi's current one. */
export function circleConnection() {
  for (const c of wagmiConfig.state.connections.values()) {
    if (c.connector.id === CIRCLE_CONNECTOR_ID) return c;
  }
  return undefined;
}

export interface CircleAccount {
  /** The signed-in wallet's address, or undefined when nobody is signed in. */
  address?: `0x${string}`;
  /** Is there a live Circle connection — regardless of what else is attached. */
  connected: boolean;
  connector?: Connector;
}

/**
 * The Circle identity, as a hook.
 *
 * Server-safe: `useConnections()` is empty during prerender, so this reports
 * "not connected" on the server and on the first client render, which is what
 * every consumer already expects while the session is being restored.
 */
export function useCircleAccount(): CircleAccount {
  const connections = useConnections();
  const circle = connections.find((c) => c.connector.id === CIRCLE_CONNECTOR_ID);
  const address = circle?.accounts[0];
  return { address, connected: !!address, connector: circle?.connector };
}

// Once per page load. See below.
let promoted = false;

/**
 * Make the Circle connection the current one, if there is one.
 *
 * Returns whether a Circle connection exists at all, so a caller can tell
 * "already attached" from "needs connecting" without a second lookup.
 *
 * ONCE per page load, deliberately. At load the choice is between a session
 * the merchant deliberately signed into and an extension that reattached
 * itself, and the session should win — that is the bug this fixes. But a
 * payer who later presses Connect Wallet and picks MetaMask has made a
 * deliberate choice about which wallet pays, and re-promoting Circle on top of
 * it would take that choice away every time. The previous code did exactly
 * that: its adopt effect re-ran on every connector change and reconnected
 * Circle over whatever had just been chosen.
 *
 * Also writes `recentConnectorId`, so the NEXT load orders Circle first and
 * this repair is not needed twice. That is the field wagmi's disconnect leaves
 * pointing at an extension.
 */
export function preferCircleConnection(): boolean {
  const conn = circleConnection();
  if (!conn) return false;
  if (wagmiConfig.state.current !== conn.connector.uid && !promoted) {
    promoted = true;
    wagmiConfig.setState((x) => ({ ...x, current: conn.connector.uid, status: "connected" }));
  }
  void wagmiConfig.storage?.setItem("recentConnectorId", CIRCLE_CONNECTOR_ID);
  return true;
}
