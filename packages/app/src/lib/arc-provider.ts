import { ethers } from "ethers";
import { ARC_TESTNET } from "@conduit/sdk";

// One read-only provider config for every browser-side direct RPC read.
// Arc's public RPC aggressively rate-limits, and its 429s come back without
// CORS headers — the browser then reports an opaque "Failed to fetch".
// staticNetwork skips the eth_chainId probe on every call and
// batchMaxCount:1 disables ethers' request batching (batched payloads are
// another thing the endpoint rejects under load).
export function arcReadProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(
    ARC_TESTNET.rpc,
    { chainId: ARC_TESTNET.chainId, name: "arc-testnet" },
    { staticNetwork: true, batchMaxCount: 1 }
  );
}
