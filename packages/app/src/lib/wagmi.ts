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

// Shared by the plain config below AND the Privy-synced config built inside
// the lazily-loaded privy-stack (do NOT build the Privy config here — a
// module-level @privy-io/wagmi import would drag all of @privy-io into the
// main bundle and undo the lazy split).
// Where Google returns after a Circle sign-in. Exported so the spike pages and
// the eventual app callback route agree on one value — a mismatch here fails
// as redirect_uri_mismatch at Google, well away from anything that mentions it.
export const CIRCLE_CALLBACK_PATH = "/dev/circle-connector";

export const wagmiConfigParams = {
  chains: [arcTestnet],
  connectors: [
    injected(),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId })] : []),
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
  ],
  transports: {
    [arcTestnet.id]: http(ARC_RPC_URL),
  },
} as const;

// Plain config: used whenever the Privy stack isn't mounted.
export const wagmiConfig = createConfig(wagmiConfigParams);
