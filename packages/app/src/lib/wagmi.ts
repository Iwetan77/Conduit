import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, walletConnect } from "wagmi/connectors";

// Arc's public RPC rate-limits hard and its 429s come back with no CORS
// headers, so the browser surfaces them as an opaque "Load failed" on
// eth_blockNumber / eth_call. Allow pointing every browser-side read at a
// reliable/proxied endpoint (a private RPC, or the Conduit API acting as an
// RPC proxy) without a code change. Falls back to the public endpoint.
export const ARC_RPC_URL =
  process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.testnet.arc.network";

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
      http: [ARC_RPC_URL],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  // REQUIRED, not cosmetic. wagmi/viem only batch a useReadContracts into a
  // single Multicall3 call when the chain declares this address; without it
  // they silently fall back to one eth_call PER contract. Reading 9 token
  // balances then fired 9 parallel requests, and Arc's public RPC rejected a
  // random subset of them with "request limit reached" every time — which is
  // why balances appeared, vanished, and read as zero at random. Measured on
  // the live endpoint: 9 parallel calls returned 7-9 of 9; one Multicall3
  // returned all 9 in ~200ms, three times out of three.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
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
    [arcTestnet.id]: http(ARC_RPC_URL),
  },
} as const;

// Plain config: used whenever the Privy stack isn't mounted.
export const wagmiConfig = createConfig(wagmiConfigParams);
