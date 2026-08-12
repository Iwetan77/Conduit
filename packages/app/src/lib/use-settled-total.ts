"use client";

import { useQueries } from "@tanstack/react-query";
import { getFxRate, type FxRate } from "@/lib/conduit-api";
import { currencyDecimals } from "@conduit/sdk/lite";
import { isoToToken } from "@/lib/currencies";

// One headline number for "money settled", expressed in the merchant's own
// settle currency.
//
// The Settlements page used to print a separate total per currency side by
// side — "20.00 USDC   35.50 EURC" — which is a breakdown, not a total. A
// merchant who settles in EUR wants to know what they took, once, in EUR.
//
// Converting historical takings at TODAY's rate is an approximation and is
// labelled as one wherever this is rendered. The per-currency figures stay
// exact underneath (they are summed in integer minor units); only the final
// roll-up is converted, and only for display.

export interface CurrencyTotal {
  currency: string;
  netMinor: bigint;
  grossMinor: bigint;
  count: number;
}

export interface SettledTotal {
  /** Roll-up in `displayCurrency`, as a Number of major units. */
  net: number;
  gross: number;
  count: number;
  /** True while any conversion is still in flight. */
  loading: boolean;
  /** True if at least one slice needed converting (so the figure is approximate). */
  approximate: boolean;
  /**
   * Slices we could NOT convert, with the reason. Never silently dropped:
   * money the merchant actually received must always be visible somewhere,
   * even when no FX route exists for the pair (StableFX only quotes pairs with
   * USDC on one leg, so e.g. BRLA -> EURC has no direct rate).
   */
  unconverted: Array<CurrencyTotal & { reason: string }>;
}

function toMajor(minor: bigint, currency: string): number {
  return Number(minor) / 10 ** currencyDecimals(isoToToken(currency));
}

// A nominal destination amount used purely to read the pair's rate back.
// Deliberately well above the provider's ~1.00 USD minimum notional, which
// rejects dust quotes outright.
function probeAmount(currency: string): string {
  return (10n ** BigInt(currencyDecimals(isoToToken(currency))) * 100n).toString();
}

export function useSettledTotal(
  totals: CurrencyTotal[],
  displayCurrency: string | undefined
): SettledTotal {
  // Only foreign slices need a rate; same-currency ones are already exact.
  const foreign = displayCurrency
    ? totals.filter((t) => isoToToken(t.currency) !== isoToToken(displayCurrency))
    : [];

  const results = useQueries({
    queries: foreign.map((t) => ({
      queryKey: ["fx-rate-rollup", t.currency, displayCurrency],
      // A roll-up rate is not a payment quote — no retry, and cached long
      // enough that switching tabs doesn't re-ask on every mount.
      staleTime: 60_000,
      retry: false,
      queryFn: () => getFxRate(t.currency, displayCurrency!, probeAmount(displayCurrency!)),
    })),
  });

  if (!displayCurrency) {
    return { net: 0, gross: 0, count: 0, loading: true, approximate: false, unconverted: [] };
  }

  let net = 0;
  let gross = 0;
  let count = 0;
  let loading = false;
  let approximate = false;
  const unconverted: Array<CurrencyTotal & { reason: string }> = [];

  for (const t of totals) {
    if (isoToToken(t.currency) === isoToToken(displayCurrency)) {
      net += toMajor(t.netMinor, t.currency);
      gross += toMajor(t.grossMinor, t.currency);
      count += t.count;
      continue;
    }

    const idx = foreign.findIndex((f) => f.currency === t.currency);
    const q = results[idx];
    if (!q || q.isLoading) {
      loading = true;
      continue;
    }
    const rate = Number((q.data as FxRate | undefined)?.rate);
    if (!q.data || !Number.isFinite(rate) || rate <= 0) {
      // No route, or the provider refused. Surface it rather than pretending
      // this money doesn't exist.
      unconverted.push({
        ...t,
        reason: q.error instanceof Error ? q.error.message : "no rate available",
      });
      continue;
    }
    // `rate` is units of `from` per unit of `to`, so converting a holding of
    // `from` into `to` divides.
    approximate = true;
    net += toMajor(t.netMinor, t.currency) / rate;
    gross += toMajor(t.grossMinor, t.currency) / rate;
    count += t.count;
  }

  return { net, gross, count, loading, approximate, unconverted };
}
