"use client";

// The payer-facing reads — /links and /history — behind the cache.
//
// Phase 5 put the DASHBOARD's reads behind React Query (see queries.ts) and
// left these two, which are the ones a payer actually uses. Both were raw
// useState + useEffect, so both refetched from scratch on every visit and
// showed a spinner for rows fetched seconds earlier.
//
// /history was worse than slow. Its cross-currency half needs a wallet
// SIGNATURE, and that ran on every mount: leaving the page and coming back
// meant approving a wallet prompt again to see rows the browser had just been
// shown. Caching it is not a nicety, it is the difference between a page you
// can navigate and one you avoid.
//
// Keyed by wallet address rather than by account, which is why these live apart
// from queries.ts: there is no API key or session here, only a connected
// wallet, and switching wallets must never serve the previous one's rows.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Connector } from "wagmi";
import type { PaymentDeclaration } from "@conduit/sdk/lite";
import { ARC_RPC_URL } from "@/lib/chain";

/** Namespaced so an invalidation cannot miss a cache by respelling its key. */
export const payerQk = {
  links: (address?: string) => ["payer", "links", address?.toLowerCase()] as const,
  onChainHistory: (address?: string) => ["payer", "history", "onchain", address?.toLowerCase()] as const,
  fxHistory: (address?: string) => ["payer", "history", "fx", address?.toLowerCase()] as const,
};

/**
 * Long enough that navigating between the payer pages does not refetch.
 *
 * Settled payments are immutable and new ones are rare within a single visit,
 * so a minute of staleness costs nothing a manual refresh cannot fix, and saves
 * a full Arc RPC round trip on every navigation.
 */
const HISTORY_STALE_MS = 60_000;

/**
 * The signed read gets five minutes, not one.
 *
 * Its refetch costs a WALLET PROMPT, so the usual "cheap to refresh" reasoning
 * is inverted: every refetch interrupts the payer and asks them to approve
 * something. Refetch-on-focus is off for the same reason — alt-tabbing back to
 * the page must never pop a signature request.
 */
const FX_HISTORY_STALE_MS = 5 * 60_000;

export interface WalletLinks {
  declarations: PaymentDeclaration[];
  /** Payments received, per declaration id. */
  paymentCounts: Record<string, number>;
}

export function useWalletLinks(address: string | undefined, enabled = true) {
  return useQuery({
    queryKey: payerQk.links(address),
    enabled: enabled && !!address,
    staleTime: HISTORY_STALE_MS,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<WalletLinks> => {
      const { ConduitClient, ReceiptClient } = await import("@conduit/sdk");
      const { arcReadProvider } = await import("@/lib/arc-provider");
      const provider = arcReadProvider();
      // ConduitClient wants a signer even to READ. Nothing here sends a
      // transaction, so a stub that can report the address is enough — and is
      // preferable to asking the wallet for a real one just to list links.
      const mockSigner = {
        getAddress: async () => address!,
        sendTransaction: async () => ({
          hash: "0x",
          wait: async () => ({ status: 1, blockNumber: 0 }),
        }),
      };

      const receiptClient = new ReceiptClient(provider);
      const conduitClient = new ConduitClient({ signer: mockSigner, rpcUrl: ARC_RPC_URL });

      const [declarations, receipts] = await Promise.all([
        conduitClient.getDeclarations(address as `0x${string}`),
        receiptClient.getHistory(address as `0x${string}`, { limit: 200 }),
      ]);

      const paymentCounts: Record<string, number> = {};
      for (const r of receipts) {
        if (r.recipient.toLowerCase() === address!.toLowerCase()) {
          paymentCounts[r.declarationId] = (paymentCounts[r.declarationId] ?? 0) + 1;
        }
      }
      return { declarations, paymentCounts };
    },
  });
}

/** Same-currency payments, read straight off ConduitRouter. No server. */
export function useOnChainHistory(address: string | undefined, enabled = true) {
  return useQuery({
    queryKey: payerQk.onChainHistory(address),
    enabled: enabled && !!address,
    staleTime: HISTORY_STALE_MS,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { ReceiptClient } = await import("@conduit/sdk");
      const { arcReadProvider } = await import("@/lib/arc-provider");
      const receiptClient = new ReceiptClient(arcReadProvider());
      return receiptClient.getHistory(address as `0x${string}`, { limit: 50 });
    },
  });
}

/**
 * Cross-currency and cross-chain payments, which leave no on-chain event.
 *
 * Circle's maker settles via Permit2 and never touches ConduitRouter, so this
 * endpoint is the only record either side has. It is gated by a wallet
 * signature rather than an API key, because a payer has no key.
 *
 * /history enables this on mount, which is the behaviour it has always had.
 * What changes is that it now happens ONCE per wallet per five minutes instead
 * of on every single mount — so returning to the page shows the rows already
 * fetched rather than asking the payer to re-approve seeing their own history.
 */
export function useWalletFxHistory(
  address: string | undefined,
  connector: Connector | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: payerQk.fxHistory(address),
    enabled: enabled && !!address,
    staleTime: FX_HISTORY_STALE_MS,
    gcTime: 30 * 60_000,
    // Both off deliberately: each would open a wallet signature prompt with no
    // action behind it. A prompt the payer did not ask for reads as an attack.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A declined signature is a CHOICE, not a transient failure. Retrying it
    // re-prompts someone who just said no.
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { getWalletProvider } = await import("@/lib/wallet-provider");
      const { signWalletHistoryRequest } = await import("@/lib/wallet-history-signature");
      const { getWalletSettlements } = await import("@/lib/conduit-api");
      const provider = await getWalletProvider(connector);
      const { timestamp, signature } = await signWalletHistoryRequest(address!, provider);
      return getWalletSettlements(address!, timestamp, signature);
    },
  });
}
