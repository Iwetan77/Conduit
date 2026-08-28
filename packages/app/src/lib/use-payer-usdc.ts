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
// Arc INCLUDED, which it was not before, and its absence was a bug people saw.
//
// The two balances have genuinely different shapes and must not be conflated:
// SOURCE_CHAINS is the Gateway source list with Arc excluded on purpose (Arc is
// the destination domain, so it cannot be deposited into the pool), while the
// Arc balance is a plain wallet balance read through useBalances. What was
// wrong was leaving the combining to each caller. They disagreed: /send threaded
// Arc up out of PayerCurrencyPicker via a callback, and the nav menu simply
// never read it and printed the pool under the heading "Your USDC".
//
// So this hook now answers both questions, separately and by name:
//   funded / pooledMinor  -- the Gateway pool. Feeds routing and burn intents.
//   arcMinor              -- USDC on Arc.
//   holdings / heldMinor  -- everything, Arc included. For DISPLAY only.
// and spendableUsdc() below turns them into the one number a single payment is
// allowed to draw on. Nothing outside this file should be doing that sum itself.

import { useEffect, useMemo, useState } from "react";
import {
  ARC_CHAIN,
  fundedChains,
  getUnifiedUsdc,
  getWalletUsdc,
  mergeUsdc,
  type PayerAdapter,
  type UnifiedUsdc,
} from "@/lib/unified-balance";
import { useBalances } from "@/lib/use-balances";

export interface PayerUsdc {
  loading: boolean;
  /** Non-empty only when BOTH reads failed; a partial read is still useful. */
  error: string;
  unified: UnifiedUsdc | null;
  /** Chains holding a non-zero balance, richest first. */
  funded: Array<{ chain: string; minor: bigint }>;
  /**
   * The Gateway pool: every SOURCE chain, summed. Arc is NOT in here.
   *
   * Named `spendableMinor` until it caused the bug it is renamed to prevent.
   * The nav menu rendered it under the label "Your USDC", so a payer holding 12
   * on Arc and 40 across Base and Polygon was told they had 40 -- their Arc
   * balance, on the chain everything settles on, silently missing from a figure
   * claiming to be their USDC.
   *
   * "Spendable" was the wrong word for it in both directions: it excludes money
   * they hold, and it is not by itself the ceiling on a payment either (see
   * spendableUsdc, which takes the larger of this and Arc). It is the pool, so
   * it is called the pool.
   *
   * Single-family by construction: the hook reads EVM chains for an EVM wallet
   * and Solana for a Solana wallet, never both, because balances in two
   * families cannot pool into one signature.
   */
  pooledMinor: bigint;
  /**
   * USDC held on Arc. Zero for a Solana wallet, which cannot sign on Arc.
   */
  arcMinor: bigint;
  /**
   * Everything this payer holds: Arc plus the pool.
   *
   * A HOLDINGS figure, for anywhere that answers "how much USDC do I have".
   * Deliberately NOT the same as what one payment can spend -- see
   * spendableUsdc for that, and never substitute this for it.
   */
  heldMinor: bigint;
  /**
   * Every chain holding a non-zero balance INCLUDING Arc, richest first.
   *
   * The display counterpart to `funded`. Kept separate because `funded` feeds
   * planAllocations, which turns it into Gateway burn intents -- and Arc is the
   * destination domain, so an Arc entry there would build an intent to burn on
   * the chain being minted to.
   */
  holdings: Array<{ chain: string; minor: bigint }>;
  /** True once the Arc read has actually landed (or is not applicable). */
  arcSettled: boolean;
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
  pooledMinor: 0n,
  arcMinor: 0n,
  heldMinor: 0n,
  holdings: [],
  arcSettled: false,
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

  // Arc, read here rather than by each caller.
  //
  // It used to be every caller's own problem, and they disagreed: /send threaded
  // it up out of PayerCurrencyPicker through an onBalancesChange callback, while
  // the nav menu simply never read it and printed the pool as "Your USDC". One
  // hook that answers "where is this payer's USDC" cannot disagree with itself.
  //
  // Costs nothing extra: useBalances is a React Query key shared app-wide, so
  // the nav menu and the send form still make one request between them.
  //
  // EVM only. `address` is a Solana pubkey for a Solana wallet, which cannot
  // sign on Arc at all -- crediting it an Arc balance would show money that no
  // route on the page can spend. Hooks run unconditionally either way; it is
  // the QUERY that is disabled, never the call.
  const wantsArc = enabled && family === "evm" && !!address;
  const { balances: arcBalances, settled: arcRead } = useBalances(address, wantsArc);
  const arcMinor = wantsArc ? (arcBalances.USDC ?? 0n) : 0n;
  // A Solana wallet has no Arc read to wait for, so it is settled by definition
  // -- otherwise every caller gating on this would wait forever.
  const arcSettled = wantsArc ? arcRead : true;

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
          ...EMPTY,
          loading: false,
          error: "",
          unified,
          funded,
          pooledMinor: funded.reduce((sum, c) => sum + c.minor, 0n),
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

  // Arc folded in on the way out, not into the cached read.
  //
  // The module cache above is keyed by wallet and holds the Gateway result,
  // which is slow and worth remembering. The Arc balance is React Query's to
  // own -- it refetches on its own schedule -- so baking a snapshot of it into
  // that cache would pin a stale Arc figure for the life of the page.
  return useMemo(() => {
    const holdings = [...state.funded];
    if (arcMinor > 0n) holdings.push({ chain: ARC_CHAIN, minor: arcMinor });
    holdings.sort((a, b) => (b.minor > a.minor ? 1 : b.minor < a.minor ? -1 : 0));
    return {
      ...state,
      arcMinor,
      arcSettled,
      heldMinor: state.pooledMinor + arcMinor,
      holdings,
    };
  }, [state, arcMinor, arcSettled]);
}

/**
 * The largest USDC payment this wallet can actually make, and how.
 *
 * Not a sum. Arc and the Gateway source chains are two routes that cannot
 * combine into one payment: a balance already on Arc settles directly in one
 * transaction, while balances on the source chains pool inside Circle Gateway
 * and bridge in. Arc is the DESTINATION domain, so it cannot be deposited into
 * the pool alongside them.
 *
 * So the spendable figure is the larger of the two, and that is exactly the
 * ceiling routeForAmount enforces -- it tries Arc first, then the pool. Adding
 * them would print a number nothing can spend: 12 on Arc plus 20 on Polygon
 * plus 20 on Base is not 52 of spending power, it is 40, because the 12 can
 * never join the other two.
 *
 * That 52 is a real figure and worth showing -- it is what the payer HOLDS, and
 * `heldMinor` is where it lives. The mistake is showing it HERE, as though a
 * payment could reach it. /send shows both and says in one line why they differ,
 * which is the only version that does not leave a payer doubting both numbers.
 */
export function spendableUsdc(
  arcMinor: bigint,
  usdc: PayerUsdc,
): { minor: bigint; via: "arc" | "chains"; chains: Array<{ chain: string; minor: bigint }> } {
  return arcMinor > usdc.pooledMinor
    ? { minor: arcMinor, via: "arc", chains: [] }
    : { minor: usdc.pooledMinor, via: "chains", chains: usdc.funded };
}

/**
 * Fill `needMinor` from `funded`, in the order given, or null if it cannot be met.
 *
 * Drawn in the order given and NOT re-sorted: fundedChains already returns
 * richest first, which costs the fewest deposits and so the fewest wallet
 * prompts, but a caller that deliberately puts a payer's chosen chain at the
 * head needs that respected rather than sorted away.
 *
 * Split out from routeForAmount because CrossChainBridge needs the allocations
 * without the route wrapper -- it already knows the payment is cross-chain and
 * is only re-planning which chains fund it after a balance read or a payer's
 * pick. Two copies of this arithmetic is exactly the kind that drifts.
 */
export function planAllocations(
  needMinor: bigint,
  funded: Array<{ chain: string; minor: bigint }>,
): Array<{ chain: string; minor: bigint }> | null {
  const allocations: Array<{ chain: string; minor: bigint }> = [];
  let remaining = needMinor;
  for (const c of funded) {
    if (remaining <= 0n) break;
    if (c.minor <= 0n) continue;
    const take = c.minor < remaining ? c.minor : remaining;
    allocations.push({ chain: c.chain, minor: take });
    remaining -= take;
  }
  return remaining <= 0n && allocations.length > 0 ? allocations : null;
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

  const allocations = planAllocations(needMinor, funded);
  if (allocations) {
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

// ── Deciding which screen to show ────────────────────────────────────────────

/**
 * A route, or the honest admission that we do not know one yet.
 *
 * This type exists because "loading" kept collapsing into a decision. Every
 * surface in the app computed its route straight from `routeForAmount`, and
 * during the balance read `funded` is `[]` and the Arc balance map is `{}` --
 * so the call returned `insufficient`, which looked exactly like a real answer
 * and selected a real screen. Seconds later the balances landed and the payer's
 * screen was replaced underneath them.
 *
 * A third state is the whole fix. "Resolving" is not a route and cannot be
 * mistaken for one.
 */
export type RouteDecision =
  | { status: "resolving" }
  | {
      status: "resolved";
      route: PayerRoute;
      /** True when the ceiling below fired and the balances are incomplete. */
      partial: boolean;
    };

/**
 * How long a skeleton is allowed to stand before we answer with what we know.
 *
 * A skeleton that never resolves is worse than the flash it replaced: the payer
 * cannot act, cannot see why, and has no reason to believe waiting will help.
 * Four seconds is past the normal balance read and short of the point where a
 * stalled screen reads as broken.
 */
export const RESOLVE_CEILING_MS = 4000;

/**
 * Pure form: resolving until BOTH balance reads have finished.
 *
 * `arcSettled` comes from useBalances' own `settled` flag rather than being
 * inferred from an empty map, because an empty map is also what a wallet with
 * no Arc balance legitimately looks like -- and treating those two as the same
 * thing is the bug this function exists to prevent.
 */
export function decideRoute(
  needMinor: bigint | undefined,
  arcMinor: bigint,
  usdc: PayerUsdc,
  arcSettled: boolean,
): RouteDecision {
  if (needMinor === undefined) return { status: "resolving" };
  if (usdc.loading || !arcSettled) return { status: "resolving" };
  return {
    status: "resolved",
    route: routeForAmount(needMinor, arcMinor, usdc.funded),
    partial: false,
  };
}

/**
 * decideRoute plus the ceiling. This is what components should use.
 *
 * Keeping the pure function separate matters for the same reason it always
 * does -- the rule is testable without a renderer -- but every call site wants
 * the timeout, and a call site that forgets it renders a skeleton forever.
 */
export function useRouteDecision(
  needMinor: bigint | undefined,
  arcMinor: bigint,
  usdc: PayerUsdc,
  arcSettled: boolean,
): RouteDecision {
  const decided = decideRoute(needMinor, arcMinor, usdc, arcSettled);
  const [expired, setExpired] = useState(false);

  const waiting = decided.status === "resolving";
  const hasAmount = needMinor !== undefined;
  useEffect(() => {
    // Deliberately NOT keyed on the balances themselves. Restarting this timer
    // every time a chain reports back would mean it never fires on exactly the
    // slow fan-out it exists to cut short.
    if (!waiting || !hasAmount) {
      setExpired(false);
      return;
    }
    const t = setTimeout(() => setExpired(true), RESOLVE_CEILING_MS);
    return () => clearTimeout(t);
  }, [waiting, hasAmount]);

  if (decided.status === "resolved") return decided;
  if (expired && needMinor !== undefined) {
    // Answer with what is known, and say that it is incomplete. Callers surface
    // `partial` as a one-line note; they must not present it as a full read.
    return {
      status: "resolved",
      route: routeForAmount(needMinor, arcMinor, usdc.funded),
      partial: true,
    };
  }
  return { status: "resolving" };
}
