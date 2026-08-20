"use client";

// Where the payer's USDC actually is, across every chain Conduit can source
// from.
//
// This read already existed, buried inside CrossChainBridge -- which meant the
// app only learned where the money was AFTER the payer had committed to the
// cross-chain flow. So the route was a thing the payer chose up front and the
// balance merely confirmed, when it should be the other way round: the balance
// is the fact, and the route follows from it.
//
// Deliberately does NOT cover Arc. Arc balances come from useBalances, which
// reads every settle currency rather than USDC alone, and SOURCE_CHAINS is the
// Gateway source list with Arc excluded on purpose (Arc is the destination).
// Callers combine the two -- see routeForAmount below.

import { useEffect, useState } from "react";
import {
  fundedChains,
  getUnifiedUsdc,
  getWalletUsdc,
  mergeUsdc,
  type PayerAdapter,
  type UnifiedUsdc,
} from "@/lib/unified-balance";

export interface PayerUsdc {
  loading: boolean;
  /** Non-empty only when BOTH reads failed; a partial read is still useful. */
  error: string;
  unified: UnifiedUsdc | null;
  /** Chains holding a non-zero balance, richest first. */
  funded: Array<{ chain: string; minor: bigint }>;
  /**
   * The payer's spendable cross-chain USDC: every source chain, summed.
   *
   * This is a real balance now, and it is the number to show and to check an
   * amount against. It used to be deliberately named so it could NOT be
   * mistaken for one ("a portfolio figure, never a spendable one") because a
   * payment could only ever draw from a single chain. Circle Gateway pools
   * deposited balance across chains behind one signature, so the sum is what
   * the payer can actually spend.
   *
   * Single-family by construction: the hook reads EVM chains for an EVM wallet
   * and Solana for a Solana wallet, never both, because balances in two
   * families cannot pool into one signature.
   */
  spendableMinor: bigint;
  /**
   * The largest single chain, kept only for the places that genuinely need one
   * chain -- naming a route, or reporting a source to the API.
   */
  maxSingleChainMinor: bigint;
}

// One read per wallet, shared by every component that asks.
//
// The nav wants this to show a balance and the send form wants it to pick a
// route, and each mounting its own copy meant two fan outs across twelve
// chains for one answer -- doubling the wait the payer already noticed. Keyed
// by address so switching wallets never serves the previous one's balance.
const cache = new Map<string, PayerUsdc>();
const inflight = new Map<string, Promise<PayerUsdc>>();

/** Drop a cached read, so the next mount fetches fresh. */
export function invalidatePayerUsdc(address?: string) {
  if (address) {
    for (const k of [...cache.keys()]) if (k.startsWith(address)) cache.delete(k);
  } else {
    cache.clear();
  }
}

const EMPTY: PayerUsdc = {
  loading: false,
  error: "",
  unified: null,
  funded: [],
  spendableMinor: 0n,
  maxSingleChainMinor: 0n,
};

export interface UsePayerUsdcOptions {
  address?: string;
  family?: "evm" | "solana";
  /**
   * The EIP-1193 (or Solana) provider, when one is available.
   *
   * Optional on purpose. The wallet read only needs an address -- it goes
   * straight to each chain's RPC -- so a page can show a payer where their
   * money is the moment they connect, without asking the wallet for anything.
   * With a provider we can additionally ask Circle what has already been
   * deposited into Gateway, which is usually nothing.
   */
  provider?: unknown;
  enabled?: boolean;
}

export function usePayerUsdc({
  address,
  family = "evm",
  provider,
  enabled = true,
}: UsePayerUsdcOptions): PayerUsdc {
  const [state, setState] = useState<PayerUsdc>(EMPTY);

  useEffect(() => {
    if (!enabled || !address) {
      setState(EMPTY);
      return;
    }
    const key = `${address}:${family}:${provider ? "p" : "-"}`;

    const cached = cache.get(key);
    if (cached) {
      setState(cached);
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: "" }));

    // Join a read already in flight rather than starting a second one. Two
    // components mounting in the same tick is the normal case, not the edge.
    const run =
      inflight.get(key) ??
      (async (): Promise<PayerUsdc> => {
        // getWalletUsdc reads only .family and .address for the EVM branch, so
        // a provider-less handle is enough for the part that matters.
        const payer: PayerAdapter = { adapter: null, address, family, provider };

        // Both reads are allowed to fail independently. Circle's testnet
        // Gateway flaps, and that must not hide a wallet balance readable
        // without Circle being involved at all; equally a failed wallet read
        // should still show whatever was already deposited.
        const [deposited, wallet] = await Promise.all([
          provider ? getUnifiedUsdc(payer).catch(() => null) : Promise.resolve(null),
          getWalletUsdc(payer).catch(() => null),
        ]);

        if (!deposited && !wallet) {
          return { ...EMPTY, error: "Couldn't read your USDC balances. Try again in a moment." };
        }
        const unified = mergeUsdc(deposited ?? ({} as UnifiedUsdc), wallet ?? []);
        // Richest first — which decides the order a payment draws from, since
        // fewer, larger draws means fewer deposits and fewer wallet prompts.
        const funded = fundedChains(unified);
        return {
          loading: false,
          error: "",
          unified,
          funded,
          spendableMinor: funded.reduce((sum, c) => sum + c.minor, 0n),
          maxSingleChainMinor: funded[0]?.minor ?? 0n,
        };
      })();

    inflight.set(key, run);
    void run
      .then((result) => {
        inflight.delete(key);
        // Only a good read is worth remembering; caching a failure would make
        // one bad moment permanent for the life of the page.
        if (!result.error) cache.set(key, result);
        if (!cancelled) setState(result);
      })
      .catch(() => {
        inflight.delete(key);
        if (!cancelled) setState({ ...EMPTY, error: "Couldn't read your USDC balances." });
      });

    return () => {
      cancelled = true;
    };
  }, [address, family, provider, enabled]);

  return state;
}

export type PayerRoute =
  | { kind: "arc" }
  | {
      kind: "cross_chain";
      /** Every chain this payment draws from, richest first. */
      allocations: Array<{ chain: string; minor: bigint }>;
      /** The largest contributor — what the route is named after. */
      chain: string;
      /** Total being drawn across those chains. */
      minor: bigint;
    }
  | { kind: "insufficient"; bestMinor: bigint };

/**
 * Which route can actually settle this amount.
 *
 * Arc wins when it can cover the amount on its own, because it is one
 * transaction with nothing in between and no bridge.
 *
 * Otherwise the payment is funded from the payer's cross-chain balance, and
 * that balance is a SUM, not a maximum. This is the rule that changed. It used
 * to pick the richest single chain that could cover the whole amount, on the
 * grounds that a spend deposits into one chain and spends it there -- so a
 * payer holding 20 on Polygon and 20 on Base was refused a payment of 30 while
 * plainly holding 40. Circle Gateway pools deposited balance across chains and
 * settles the whole set from one EIP-712 `BurnIntentSet` signature, so the
 * payment simply draws from as many chains as it needs to.
 *
 * `funded` must therefore be single-family: EVM chains for an EVM wallet, and
 * Solana alone for a Solana wallet. Chains from two families cannot pool,
 * because each family signs with its own adapter and the batching that makes
 * this one signature is per adapter.
 */
export function routeForAmount(
  needMinor: bigint,
  arcMinor: bigint,
  funded: Array<{ chain: string; minor: bigint }>,
): PayerRoute {
  if (arcMinor >= needMinor) return { kind: "arc" };

  // Drawn in the order given, and NOT re-sorted here. fundedChains already
  // returns richest first, which is the order that costs the fewest deposits
  // and so the fewest wallet prompts -- but a caller that deliberately puts a
  // payer's chosen chain at the head needs that respected rather than sorted
  // away.
  const allocations: Array<{ chain: string; minor: bigint }> = [];
  let remaining = needMinor;
  for (const c of funded) {
    if (remaining <= 0n) break;
    if (c.minor <= 0n) continue;
    const take = c.minor < remaining ? c.minor : remaining;
    allocations.push({ chain: c.chain, minor: take });
    remaining -= take;
  }

  if (remaining <= 0n && allocations.length > 0) {
    return {
      kind: "cross_chain",
      allocations,
      chain: allocations[0].chain,
      minor: needMinor,
    };
  }

  // Short everywhere. Report the whole cross-chain balance, not the best single
  // chain: that total is now genuinely what a payment can draw on, so naming a
  // smaller number would understate what the payer has.
  const across = funded.reduce((s, c) => s + c.minor, 0n);
  return { kind: "insufficient", bestMinor: arcMinor > across ? arcMinor : across };
}
