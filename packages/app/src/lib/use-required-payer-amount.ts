"use client";

import { useQuery } from "@tanstack/react-query";
import type { Currency } from "@conduit/sdk/lite";
import { parseAmount } from "@/lib/format";
import { getFxRate } from "@/lib/conduit-api";

// How much of `payerCurrency` this send will cost, in the payer token's minor
// units — the figure the balance guard compares against what the wallet holds.
//
// Same-currency is exact and needs no network call.
//
// Cross-currency used to return 0n, on the grounds that only Circle StableFX
// could price it and only at pay time, against an intent that doesn't exist
// yet. That left the balance guard switched off for every cross-currency send:
// someone holding 19 EURC could start a payment needing 50 EURC and only find
// out when the wallet rejected the signature, after the intent had been
// created. GET /v1/fx/rates now prices exactly this — its `pay_amount` IS the
// answer, for the requested destination amount — so the guard applies to every
// pair, not just the ones where the arithmetic was trivial.
//
// The firm quote at pay time is still authoritative; this is a pre-flight check
// against the same provider, and a rate that drifts between the two is handled
// by the quote, not here.
export function useRequiredPayerAmount(
  payerCurrency: Currency,
  recipientCurrency: Currency,
  amount: string
) {
  const sameCurrency = payerCurrency === recipientCurrency;
  let recipientMinor: bigint | undefined;
  try {
    recipientMinor = amount ? parseAmount(amount, recipientCurrency) : undefined;
  } catch {
    recipientMinor = undefined; // mid-typing ("1.", "abc") — nothing to price yet
  }
  const validAmount = recipientMinor !== undefined && recipientMinor > 0n;

  return useQuery({
    queryKey: ["required-payer-amount", payerCurrency, recipientCurrency, amount],
    enabled: validAmount,
    staleTime: 15_000,
    // Same-currency can't fail. Cross-currency failures here are answers, not
    // faults — "this pair has no route", "this amount is below the minimum" —
    // and retrying them only delays telling the payer.
    retry: sameCurrency ? 2 : false,
    retryDelay: (attempt: number) => 300 * 2 ** attempt,
    queryFn: async (): Promise<bigint> => {
      if (sameCurrency) return recipientMinor!;
      const rate = await getFxRate(payerCurrency, recipientCurrency, recipientMinor!.toString());
      return BigInt(rate.pay_amount);
    },
  });
}
