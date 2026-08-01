"use client";

import { useQuery } from "@tanstack/react-query";
import { getPublicSettlementIntent, type PublicSettlementIntent } from "@/lib/conduit-api";

// One shared query for the payer page's settlement intent.
//
// The page fired TWO identical getPublicSettlementIntent requests on every
// load: one in the page (to set the browser-tab title) and one inside
// SettlementIntentPay (to render the body). React Query dedupes by key, so
// both callers now share a single in-flight request.
//
// NOTE, deliberately: no placeholderData/keepPreviousData here. Keeping
// previous data is exactly the state leak that showed one merchant's invoice
// on another's page — when intentId changes, this must go to undefined and
// re-load, not display the last intent.
export function usePublicIntent(intentId: string | undefined) {
  return useQuery<PublicSettlementIntent>({
    queryKey: ["public-intent", intentId],
    enabled: !!intentId,
    staleTime: 5_000,
    retry: 1,
    queryFn: () => getPublicSettlementIntent(intentId!),
  });
}
