import { ethers } from "ethers";
import { ARC_TESTNET } from "@conduit/sdk/lite";

/**
 * How often to ask whether a transaction has landed.
 *
 * ethers defaults this to 4000ms and nothing in this repo overrode it, which
 * the Phase B0 trace found to be the single largest cost in the product. Arc
 * produces blocks in about a second, so every `tx.wait()` spent roughly four
 * seconds asleep -- measured at 4.9s per receipt, on every path, run after run.
 * Two receipts per payment made that ~9.7s of a 12.7s same-currency send.
 *
 * The proof is in the outlier: one traced receipt returned in 238ms, because
 * that transaction happened to broadcast just before a poll tick. Same code,
 * same network, same chain, twenty times faster -- the only variable was where
 * in the four-second cycle it landed.
 *
 * 500ms rather than something smaller. Arc's public RPC rate-limits hard (a
 * single payment already earns 429s through the API proxy -- see perf/README),
 * and polling faster than blocks are produced spends requests to learn nothing.
 * Half a block time bounds the wait without doubling the request count for it.
 */
export const ARC_POLLING_INTERVAL_MS = 500;

// One read-only provider config for every browser-side direct RPC read.
// Arc's public RPC aggressively rate-limits, and its 429s come back without
// CORS headers — the browser then reports an opaque "Failed to fetch".
// staticNetwork skips the eth_chainId probe on every call and
// batchMaxCount:1 disables ethers' request batching (batched payloads are
// another thing the endpoint rejects under load).
// Memoised per URL.
//
// This constructed a NEW provider on every call, so nothing was reused across
// reads: every one paid a fresh connection, and any per-provider state ethers
// keeps -- its block cache included -- was thrown away each time. The Go side
// already memoises its Arc client (internal/arcrpc); this is the same idea on
// the browser side.
const readProviders = new Map<string, ethers.JsonRpcProvider>();

export function arcReadProvider(): ethers.JsonRpcProvider {
  // Same env override as the wagmi transport (see lib/wagmi.ts): lets browser
  // reads use a reliable/proxied RPC instead of Arc's rate-limited public one.
  const rpc = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? ARC_TESTNET.rpc;

  const cached = readProviders.get(rpc);
  if (cached) return cached;

  const provider = new ethers.JsonRpcProvider(
    rpc,
    { chainId: ARC_TESTNET.chainId, name: "arc-testnet" },
    { staticNetwork: true, batchMaxCount: 1 }
  );
  provider.pollingInterval = ARC_POLLING_INTERVAL_MS;
  readProviders.set(rpc, provider);
  return provider;
}
