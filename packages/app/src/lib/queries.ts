"use client";

// Every dashboard read, in one place, through the cache that was already there.
//
// React Query was installed, configured in providers.tsx with a 10s staleTime,
// and used by exactly four hooks. The eight dashboard call sites each did raw
// `useState(null)` + `useEffect(fetch)` instead, which meant:
//
//   - Navigating Settlements -> Links -> Settlements refetched from scratch and
//     showed "Loading..." for rows fetched four seconds earlier.
//   - `getMyAccount()` fired TWICE CONCURRENTLY on /dashboard/settlements, once
//     from MerchantIdentity in the layout and once from the page, and again on
//     /dashboard/request-payment and /dashboard/settings. Nothing deduped them.
//   - MerchantIdentity showed "Loading..." in the sidebar on every navigation,
//     so the merchant's own business name flickered on every single click.
//
// None of that is a caching problem. It is the same request written eight times
// without a cache in front of it.
//
// Two deliberate choices below:
//
//   `useMyAccount` gets a five minute staleTime. A merchant's settle currency
//   does not change between two clicks, and this one hook alone removes the
//   sidebar flicker and collapses four duplicate requests into one.
//
//   Lists get `placeholderData: keepPreviousData`. Returning to a page you were
//   just on shows the rows you were just looking at and updates them in place,
//   instead of blanking to a spinner and rebuilding. That is the difference
//   between a dashboard that feels instant and one that feels like eight
//   separate web pages.
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import {
  getMyAccount,
  listAccounts,
  listApiKeys,
  listBalanceTransactions,
  listPaymentLinks,
  listSettlements,
  listWebhookDeliveries,
  listWebhookEndpoints,
} from "@/lib/conduit-api";

/**
 * One namespace for every dashboard key, so an invalidation cannot miss a
 * cache by spelling its key differently at the call site.
 */
export const qk = {
  myAccount: ["account", "me"] as const,
  settlements: ["settlements"] as const,
  paymentLinks: ["payment-links"] as const,
  balanceTransactions: ["balance-transactions"] as const,
  apiKeys: ["api-keys"] as const,
  webhookEndpoints: ["webhook-endpoints"] as const,
  webhookDeliveries: (endpointId: string) => ["webhook-deliveries", endpointId] as const,
  subAccounts: ["accounts"] as const,
};

/** Five minutes: a merchant's own account details do not change mid-session. */
const ACCOUNT_STALE_MS = 5 * 60_000;

export function useMyAccount(enabled = true) {
  return useQuery({
    queryKey: qk.myAccount,
    queryFn: getMyAccount,
    staleTime: ACCOUNT_STALE_MS,
    enabled,
  });
}

export function useSettlements(enabled = true) {
  return useQuery({
    queryKey: qk.settlements,
    queryFn: async () => (await listSettlements()).data ?? [],
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function usePaymentLinks(enabled = true) {
  return useQuery({
    queryKey: qk.paymentLinks,
    queryFn: async () => (await listPaymentLinks()).data ?? [],
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useBalanceTransactions(enabled = true) {
  return useQuery({
    queryKey: qk.balanceTransactions,
    queryFn: async () => (await listBalanceTransactions()).data ?? [],
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useApiKeys(enabled = true) {
  return useQuery({
    queryKey: qk.apiKeys,
    queryFn: async () => (await listApiKeys()).data ?? [],
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useWebhookEndpoints(enabled = true) {
  return useQuery({
    queryKey: qk.webhookEndpoints,
    queryFn: async () => (await listWebhookEndpoints()).data ?? [],
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useWebhookDeliveries(endpointId: string | null) {
  return useQuery({
    queryKey: qk.webhookDeliveries(endpointId ?? ""),
    queryFn: async () => (await listWebhookDeliveries(endpointId!)).data ?? [],
    enabled: !!endpointId,
  });
}

export function useSubAccounts(enabled = true) {
  return useQuery({
    queryKey: qk.subAccounts,
    queryFn: async () => (await listAccounts()).data ?? [],
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * A mutation that refreshes the caches it affects when it succeeds.
 *
 * Every write in the dashboard used to be followed by a hand-rolled `refresh()`
 * or `load()` callback threaded down through props. Those go stale in the usual
 * way: a new page forgets to pass one, or passes one that refreshes the wrong
 * list, and the screen quietly disagrees with the server until a reload. Naming
 * the affected keys is harder to get wrong and impossible to forget silently.
 */
export function useInvalidatingMutation<TData, TVars>(
  mutationFn: (vars: TVars) => Promise<TData>,
  invalidates: readonly (readonly unknown[])[],
  options?: Omit<UseMutationOptions<TData, Error, TVars>, "mutationFn" | "onSuccess">,
) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn,
    ...options,
    onSuccess: () => {
      for (const key of invalidates) void qc.invalidateQueries({ queryKey: key });
    },
  });
}
