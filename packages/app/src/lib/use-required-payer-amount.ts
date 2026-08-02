"use client";

import { useQuery } from "@tanstack/react-query";
import type { Currency } from "@conduit/sdk/lite";
import { parseAmount } from "@/lib/format";

// How much of `payerCurrency` this send will cost, in the payer token's minor
// units. Same-currency is exact (1:1) and can be checked up front.
//
// Cross-currency is quoted by Circle StableFX at pay time, against a
// settlement intent that doesn't exist yet — so there is nothing to check
// here and the balance guard simply doesn't apply. (The old AMM estimate was
// removed: no USDC/EURC pool exists on Arc testnet, so it only ever errored
// while implying an on-chain swap route existed.)
export function useRequiredPayerAmount(
  payerCurrency: Currency,
  recipientCurrency: Currency,
  amount: string
) {
  const validAmount = parseFloat(amount || "0") > 0;

  return useQuery({
    queryKey: ["required-payer-amount", payerCurrency, recipientCurrency, amount],
    enabled: validAmount,
    staleTime: 15_000,
    retry: 2,
    retryDelay: (attempt: number) => 300 * 2 ** attempt,
    queryFn: async (): Promise<bigint> => {
      // Cross-currency: no pre-quote available, so report no requirement
      // rather than a wrong one. The real cost is shown at quote time.
      if (payerCurrency !== recipientCurrency) return 0n;
      return parseAmount(amount, recipientCurrency);
    },
  });
}
