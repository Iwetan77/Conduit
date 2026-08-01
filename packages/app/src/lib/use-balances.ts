"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { Currency } from "@conduit/sdk/lite";
import { getBalances } from "@/lib/conduit-api";

export type BalanceMap = Partial<Record<Currency, bigint>>;

const snapshotKey = (address: string) => `conduit.balances.${address.toLowerCase()}`;

// Last-known balances, so a returning wallet paints instantly instead of
// showing "checking..." while the network round-trip happens.
export function readBalanceSnapshot(address: string): BalanceMap | null {
  try {
    const raw = localStorage.getItem(snapshotKey(address));
    if (!raw) return null;
    return Object.fromEntries(
      Object.entries(JSON.parse(raw) as Record<string, string>).map(([k, v]) => [k, BigInt(v)])
    );
  } catch {
    return null;
  }
}

function writeBalanceSnapshot(address: string, balances: BalanceMap) {
  try {
    localStorage.setItem(
      snapshotKey(address),
      JSON.stringify(Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)])))
    );
  } catch {}
}

// One shared balance query for the whole app. Reads through the Conduit API's
// cached Multicall3 endpoint rather than from the browser: N visitors cost the
// upstream RPC one call, not N. React Query dedupes this key, so the nav menu
// and the send form share a single request.
export function useBalances(address: string | undefined, enabled = true) {
  const query = useQuery({
    queryKey: ["balances", address?.toLowerCase()],
    enabled: enabled && !!address,
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 2,
    retryDelay: (attempt: number) => 400 * (attempt + 1),
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<BalanceMap> => {
      const rows = await getBalances(address!);
      const map = Object.fromEntries(
        rows.map((r) => [r.symbol as Currency, BigInt(r.amount)])
      ) as BalanceMap;
      writeBalanceSnapshot(address!, map);
      return map;
    },
  });

  // Never claim "you hold nothing" from a failed read: fall back to the last
  // known-good snapshot, and only treat all-zero as real once a read succeeds.
  const snapshot = !query.data && address ? readBalanceSnapshot(address) : null;
  const balances: BalanceMap = query.data ?? snapshot ?? {};
  const settled = query.isSuccess || !!snapshot;

  return { balances, settled, isLoading: query.isLoading && !snapshot, error: query.error };
}
