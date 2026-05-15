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

const wcProjectId = process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"] ?? "demo";

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [
    injected(),
    walletConnect({ projectId: wcProjectId }),
  ],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
  },
});
