"use client";

import { useQuery } from "@tanstack/react-query";
import { getFxRate, ConduitApiError, type FxRate } from "@/lib/conduit-api";

// Live indicative rate for a pair, for showing what a payer will actually send
// BEFORE they commit to anything.
//
// Deliberately NOT retried and NOT refetched on a timer: the two answers that
// matter most here are permanent for the inputs given ("this pair has no route"
// and "this amount is below the minimum"), and retrying them just delays
// telling the payer. A rate that goes stale is corrected at payment time by the
// firm quote, which is the authoritative one.
export function useFxRate(
  from: string | undefined,
  to: string | undefined,
  amountMinor: string | undefined,
  address?: string
) {
  const enabled = !!from && !!to && !!amountMinor && amountMinor !== "0";
  return useQuery<FxRate, ConduitApiError>({
    queryKey: ["fx-rate", from, to, amountMinor, address ?? ""],
    enabled,
    // Comfortably longer than the provider's ~3.5s quote TTL: this is a display
    // rate, and re-asking on every keystroke or re-render buys nothing.
    staleTime: 30_000,
    retry: false,
    queryFn: () => getFxRate(from!, to!, amountMinor!, address),
  });
}
