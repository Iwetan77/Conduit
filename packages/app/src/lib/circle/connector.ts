"use client";

// A wagmi connector for a Circle user-controlled wallet.
//
// This is the piece that makes the migration cheap. wagmi's connector is what
// getWalletProvider() already asks for the provider, so once Circle is a
// connector, every write path in the app reaches it through code that does not
// change: eight call sites, zero edits. Without it each one would have to learn
// about user tokens and challenges, and backing the migration out later would
// mean unpicking all of them.
//
// Two things make this connector unlike an injected one:
//
//   1. connect() navigates the whole page to Google. The returned promise does
//      not resolve — the document is gone. The connection is completed on the
//      NEXT page load, which is what setup() is for.
//   2. There is nothing to listen to. A Circle wallet is one address on one
//      chain for the life of the session, so accountsChanged and chainChanged
//      never fire. The handlers exist because wagmi calls them unconditionally.

import { createConnector } from "wagmi";
import type { Eip1193Provider } from "ethers";
import { arcTestnet } from "@/lib/chain";
import { createCircleProvider } from "@/lib/circle/provider";
import {
  configureCircle,
  currentSession,
  executeChallenge,
  hasPendingResume,
  hasPersistedSession,
  restoreSession,
  returnPathAfterLogin,
  startGoogleSignIn,
  clearCircleSession,
  type CircleConfig,
} from "@/lib/circle/browser";

export const CIRCLE_CONNECTOR_ID = "circle";

// wagmi's connect() is generic over `withCapabilities`, which makes its return
// type conditional. This connector never reports capabilities, so it always
// produces the plain-address branch; the cast at each return says exactly that
// and nothing more.
type ConnectResult<withCapabilities extends boolean> = {
  accounts: withCapabilities extends true
    ? readonly { address: `0x${string}`; capabilities: Record<string, unknown> }[]
    : readonly `0x${string}`[];
  chainId: number;
};

export function circleConnector(params: CircleConfig) {
  let provider: Eip1193Provider | undefined;

  return createConnector<Eip1193Provider>((config) => ({
    id: CIRCLE_CONNECTOR_ID,
    name: "Google",
    type: "circle",

    // Runs on every page load, before wagmi decides what is connected. This is
    // where a sign-in that redirected away gets finished: the callback hash is
    // in the URL now, and nothing else will consume it.
    async setup() {
      configureCircle(params);
      // Either a redirect to finish, or a stored session to reattach. Without
      // the second, a refresh dropped the merchant back to signed-out even
      // though the session was still valid.
      if (!hasPendingResume() && !hasPersistedSession()) return;
      try {
        const s = await restoreSession();
        if (s) {
          config.emitter.emit("connect", {
            accounts: [s.wallet.address as `0x${string}`],
            chainId: arcTestnet.id,
          });
          // Google only ever redirects to the one registered callback, so put
          // the merchant back where they pressed sign in. Done after the
          // session exists, or the destination would load signed-out and
          // bounce them straight back here.
          const back = returnPathAfterLogin();
          if (back) window.location.replace(back);
        }
      } catch {
        // Swallowed deliberately. setup() runs during app boot for every user,
        // including those who never touched Circle; a failed resume must not
        // take the page down. The error surfaces when the user tries to
        // connect, which is the point at which they can act on it.
      }
    },

    async connect<withCapabilities extends boolean = false>(
      { isReconnecting }: { isReconnecting?: boolean } = {}
    ): Promise<ConnectResult<withCapabilities>> {
      configureCircle(params);

      // Already signed in, or returning from Google: finish rather than start
      // a second round trip.
      const existing = currentSession() ?? (await restoreSession());
      if (existing) {
        return {
          accounts: [existing.wallet.address as `0x${string}`],
          chainId: arcTestnet.id,
        } as unknown as ConnectResult<withCapabilities>;
      }

      // Reconnect is wagmi restoring a previous session on load. It must never
      // navigate the user to Google unprompted — that would hijack the page on
      // every refresh. No session means not connected.
      if (isReconnecting) throw new Error("Circle session expired — sign in again");


      await startGoogleSignIn();
      // Unreachable in practice: startGoogleSignIn navigates away. If the
      // browser blocked the navigation, saying so beats hanging forever.
      throw new Error("redirecting to Google…");
    },

    async disconnect() {
      clearCircleSession();
      provider = undefined;
    },

    async getAccounts() {
      const s = currentSession() ?? (await restoreSession());
      return s ? [s.wallet.address as `0x${string}`] : [];
    },

    async getChainId() {
      return arcTestnet.id;
    },

    async getProvider() {
      const s = currentSession();
      if (!s) throw new Error("no Circle session — sign in first");
      // Rebuilt when the session changes: the provider closes over the user
      // token and wallet, and a stale one would sign against the wrong
      // session after a re-login.
      if (!provider) {
        provider = createCircleProvider({
          address: s.wallet.address,
          walletId: s.wallet.id,
          userToken: s.userToken,
          apiBase: params.apiBase,
          execute: executeChallenge,
        }) as unknown as Eip1193Provider;
      }
      return provider;
    },

    async isAuthorized() {
      // A pending resume or a stored session counts as authorized: the session
      // is one round trip away and wagmi should wait for it rather than declare
      // the user disconnected and drop a connection it is about to have.
      return !!currentSession() || hasPendingResume() || hasPersistedSession();
    },

    // A Circle wallet is provisioned per chain and cannot move. Accepting a
    // switch to the chain it is already on is honest; anything else is not.
    async switchChain({ chainId }) {
      if (chainId !== arcTestnet.id) {
        throw new Error(`this Circle wallet exists only on ${arcTestnet.name}`);
      }
      return arcTestnet;
    },

    onAccountsChanged() {
      // Never fires — one wallet, one address, for the session's lifetime.
    },
    onChainChanged() {
      // Never fires — the wallet is bound to Arc.
    },
    onDisconnect() {
      clearCircleSession();
      provider = undefined;
      config.emitter.emit("disconnect");
    },
  }));
}
