import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { ARC_RPC_URL, arcTestnet } from "@/lib/chain";
import { circleConnector } from "@/lib/circle/connector";

// Re-exported so the many modules that import these from here are unaffected
// by the move to lib/chain.
export { ARC_RPC_URL, arcTestnet };

// Literal dot form — Next.js only inlines `process.env.NEXT_PUBLIC_X`
// member expressions into the browser bundle.
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const circleAppId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const conduitApiBase = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "http://localhost:8080";

// These params were shared with a second, Privy-synced config built inside the
// lazily-loaded privy-stack, because @privy-io/wagmi's createConfig filtered the
// connector list down to mock connectors only — the two could never be one
// config. With Privy gone in Phase 7 there is exactly one config and every
// connector, Circle's included, lives in it.
//
// CIRCLE_CALLBACK_PATH is where Google returns after a Circle sign-in. Exported
// so every caller agrees on one value — a mismatch here fails as
// redirect_uri_mismatch at Google, well away from anything that mentions it.
export const CIRCLE_CALLBACK_PATH = "/auth/circle/callback";

export const wagmiConfigParams = {
  chains: [arcTestnet],
  connectors: [
    // Circle FIRST, and the order matters. wagmi's reconnect() runs on every
    // page load, authorises every connector that answers, and makes the first
    // one to answer `current` -- ties broken by this array's order. With
    // injected() ahead of it, a wallet extension that had ever been authorised
    // on this origin took the slot ahead of the merchant's own session.
    //
    // Google sign-in via a Circle user-controlled wallet. Added only when
    // configured, on the same opt-in pattern as WalletConnect: a deployment
    // without Circle credentials behaves exactly as it did before.
    //
    // CIRCLE_CALLBACK_PATH is where Google returns the user, and it must be
    // registered in the Google console. One fixed path for the whole app, not
    // one per page — the alternative is a console entry per route.
    ...(circleAppId && googleClientId
      ? [
          circleConnector({
            apiBase: conduitApiBase,
            appId: circleAppId,
            googleClientId,
            redirectPath: CIRCLE_CALLBACK_PATH,
          }),
        ]
      : []),
    injected(),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId })] : []),
  ],
  transports: {
    [arcTestnet.id]: http(ARC_RPC_URL),
  },
} as const;

// The app's one and only wagmi config.
export const wagmiConfig = createConfig(wagmiConfigParams);
