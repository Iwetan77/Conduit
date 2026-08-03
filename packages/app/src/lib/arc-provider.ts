import { ethers } from "ethers";
import { ARC_TESTNET } from "@conduit/sdk/lite";

// One read-only provider config for every browser-side direct RPC read.
// Arc's public RPC aggressively rate-limits, and its 429s come back without
// CORS headers — the browser then reports an opaque "Failed to fetch".
// staticNetwork skips the eth_chainId probe on every call and
// batchMaxCount:1 disables ethers' request batching (batched payloads are
// another thing the endpoint rejects under load).
export function arcReadProvider(): ethers.JsonRpcProvider {
  // Same env override as the wagmi transport (see lib/wagmi.ts): lets browser
  // reads use a reliable/proxied RPC instead of Arc's rate-limited public one.
  const rpc = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? ARC_TESTNET.rpc;
  return new ethers.JsonRpcProvider(
    rpc,
    { chainId: ARC_TESTNET.chainId, name: "arc-testnet" },
    { staticNetwork: true, batchMaxCount: 1 }
  );
}
