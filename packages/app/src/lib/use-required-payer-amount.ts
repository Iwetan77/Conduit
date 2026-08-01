"use client";

import { useQuery } from "@tanstack/react-query";
import type { Currency } from "@conduit/sdk/lite";
import { parseAmount } from "@/lib/format";

// How much of `payerCurrency` this send will actually cost, in the payer
// token's minor units. Direct send is same-currency only, so this is exact
// (1:1). Cross-currency is Circle StableFX via the Conduit API's settlement
// intents — it is never quoted here, and the old AMM estimate was removed:
// there is no USDC/EURC pool on Arc testnet, so it only ever produced an
// error while implying an on-chain swap route existed.
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
      const recipientUnits = parseAmount(amount, recipientCurrency);
      if (payerCurrency !== recipientCurrency) {
        throw new Error("Cross-currency is not available on direct send.");
      }
      return recipientUnits;
    },
  });
}
