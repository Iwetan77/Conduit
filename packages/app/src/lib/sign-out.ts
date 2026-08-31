"use client";

// Signing out, in one place, because there were two and they disagreed.
//
// The dashboard's own button did the whole job: revoke the session server-side,
// drop Conduit's token, empty the query cache, disconnect the wallet, clear the
// Circle session. The nav's button -- the one reachable from every other page,
// and the one people actually use on a phone -- only disconnected wagmi and
// cleared the Circle session.
//
// So Conduit's own cs_ token survived a sign-out. The next person to sign in on
// that device was handed the PREVIOUS account: /accounts/me answered with it,
// and every cached read under ["account","me"] was still the old account's for
// another five minutes. Signing into a second Google account showed the first
// one's name and username, which is what this was reported as -- but the name
// was the visible edge of a live session belonging to somebody else.
//
// Two sign-out paths that have to stay in step is a thing that will drift
// again. There is one now, and both callers use it.
import type { QueryClient } from "@tanstack/react-query";
import { disconnect as disconnectConnector } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { clearSessionToken, logout } from "@/lib/conduit-api";
import { clearCircleSession } from "@/lib/circle/browser";

/**
 * Disconnects EVERY connected wallet, not just the active one.
 *
 * wagmi's disconnect() takes the current connector only, and then — this is the
 * part that caused the bug — if any other connection is still open it makes
 * that one current (see its disconnect action, "switch over to another
 * connection"). Its reconnect() meanwhile authorises every connector it can,
 * not the first that answers, so having two live at once is the ordinary state
 * for anyone who has ever connected a browser wallet AND signed in with Google.
 *
 * So pressing Disconnect handed the person a different wallet instead of none,
 * and because the second connector never had its "disconnected" marker written,
 * every later visit reconnected it on its own — connected again without anyone
 * touching Connect Wallet.
 *
 * Reads the config's live state rather than a React snapshot: a connection that
 * lands while this is running still has to go.
 */
export async function disconnectEveryWallet(): Promise<void> {
  // Bounded, because each disconnect mutates the map this reads. Ten is far
  // beyond any real number of connectors and turns a hypothetical loop into a
  // terminating one.
  for (let pass = 0; pass < 10; pass++) {
    const connections = [...wagmiConfig.state.connections.values()];
    if (connections.length === 0) return;
    for (const c of connections) {
      try {
        await disconnectConnector(wagmiConfig, { connector: c.connector });
      } catch {
        // A connector that refuses to disconnect must not strand the person on
        // the other connectors, so each is attempted independently.
      }
    }
  }
}

export async function signOutCompletely({
  queryClient,
}: {
  queryClient?: QueryClient;
}): Promise<void> {
  // Revoke server-side FIRST, while the token is still there to authenticate
  // the call. Clearing storage only drops this browser's copy -- the token
  // stays valid for the rest of its 12 hours anywhere else it reached.
  //
  // A failure must not strand someone on a page they asked to leave, so the
  // local sign-out proceeds either way. The cost is a token that outlives the
  // click; the cost of the alternative is a sign-out button that can refuse.
  try {
    await logout();
  } catch {
    // Reported by the revoke endpoint's own logs, not here. Nothing the person
    // clicking can do about it, and stopping would be worse.
  }

  // Conduit's session token AND the Circle one. Missing this line is the whole
  // bug: without it the next sign-in on this device inherits this account.
  clearSessionToken();

  // Anything already read under this session. ["account","me"] is not keyed by
  // account -- it cannot be, the endpoint means "whoever is signed in" -- so a
  // stale entry is the previous person's account served to the next one.
  queryClient?.clear();

  try {
    localStorage.removeItem("conduit.lastMerchant");
  } catch {
    // Storage unavailable. A leftover hint is cosmetic.
  }

  // Both halves, in this order. wagmi's disconnect alone leaves the Circle
  // session in localStorage, so the connector's isAuthorized() still says yes
  // and the next page load silently signs the user back in.
  //
  // Every wallet, not the current one -- see disconnectEveryWallet. A sign-out
  // that leaves one connector attached is not a sign-out, and the one it leaves
  // comes back by itself on the next visit.
  try {
    await disconnectEveryWallet();
  } finally {
    clearCircleSession();
  }
}
