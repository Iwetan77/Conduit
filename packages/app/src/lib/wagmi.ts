import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, walletConnect } from "wagmi/connectors";

// Arc Testnet chain definition
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18, // native gas uses 18 decimals internally
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

// Literal dot form — Next.js only inlines `process.env.NEXT_PUBLIC_X`
// member expressions into the browser bundle.
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// Shared by the plain config below AND the Privy-synced config built inside
// the lazily-loaded privy-stack (do NOT build the Privy config here — a
// module-level @privy-io/wagmi import would drag all of @privy-io into the
// main bundle and undo the lazy split).
export const wagmiConfigParams = {
  chains: [arcTestnet],
  connectors: [
    injected(),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId })] : []),
  ],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
  },
} as const;

// Plain config: used whenever the Privy stack isn't mounted.
export const wagmiConfig = createConfig(wagmiConfigParams);
