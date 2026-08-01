"use client";

import { useQuery } from "@tanstack/react-query";
import type { Currency } from "@conduit/sdk/lite";
import { parseAmount } from "@/lib/format";

// How much of `payerCurrency` this send will actually cost, in the payer
// token's minor units. Same-currency is exact (1:1). Cross-currency asks the
// same AMM routers the real swap uses (exact-out getAmountsIn), so the UI
// validates against what execution would genuinely charge — before the 1%
// slippage cap. Estimator failure returns an error, never a fake number.
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
      if (payerCurrency === recipientCurrency) return recipientUnits;
      const [{ estimateRequiredIn }, { arcReadProvider }] = await Promise.all([
        import("@conduit/sdk"),
        import("@/lib/arc-provider"),
      ]);
      return estimateRequiredIn(arcReadProvider(), payerCurrency, recipientCurrency, recipientUnits);
    },
  });
}
