"use client";

import { usePayerIdentity } from "@/lib/use-payer-identity";
import { ArcOnlyNotice } from "@/components/Shared/ArcOnlyNotice";
import { useHydrated } from "@/lib/use-hydrated";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import {
  HistoryTable,
  onChainReceiptsToRows,
  walletSettlementsToRows,
  type HistoryRow,
} from "@/components/Shared/HistoryTable";
import { WalletConnect } from "@/components/Shared/WalletConnect";

export default function HistoryPage() {
  const { address, isConnected, connector } = useAccount();
  const [onChainRows, setOnChainRows] = useState<HistoryRow[]>([]);
  const [fxRows, setFxRows] = useState<HistoryRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>("");
  // Cross-currency history needs a wallet signature; not fatal if it's
  // skipped or declined — the on-chain half still loads and this only shows
  // if that half specifically failed.
  const [fxError, setFxError] = useState<string>("");
  const mounted = useHydrated();
  const { identity } = usePayerIdentity();

  const load = async () => {
    if (!isConnected || !address) return;
    setIsLoading(true);
    setError("");
    setFxError("");

    // Same-currency: pure on-chain read, no server involved. Cross-currency:
    // Circle's maker settles via Permit2, which never touches ConduitRouter,
    // so those payments have no on-chain event to read at all — the only
    // record of them is Conduit's own database, reached here with a wallet
    // signature proving this is genuinely that wallet's history to see.
    // Run both concurrently; each fills in independently of the other.
    const onChainPromise = (async () => {
      try {
        const { ReceiptClient } = await import("@conduit/sdk");
        const { arcReadProvider } = await import("@/lib/arc-provider");
        const receiptClient = new ReceiptClient(arcReadProvider());
        const receipts = await receiptClient.getHistory(address as `0x${string}`, { limit: 50 });
        setOnChainRows(onChainReceiptsToRows(receipts, address));
      } catch (err) {
        console.error("Failed to load on-chain history:", err);
        // "Failed to fetch" = Arc's public RPC rate-limiting the browser —
        // say that, not a bare fetch error.
        setError("Arc's public RPC is rate-limiting right now. Wait a few seconds and retry.");
      }
    })();

    const fxPromise = (async () => {
      try {
        const { getWalletProvider } = await import("@/lib/wallet-provider");
        const { signWalletHistoryRequest } = await import("@/lib/wallet-history-signature");
        const { getWalletSettlements } = await import("@/lib/conduit-api");
        const provider = await getWalletProvider(connector);
        const { timestamp, signature } = await signWalletHistoryRequest(address, provider);
        const rows = await getWalletSettlements(address, timestamp, signature);
        setFxRows(walletSettlementsToRows(rows));
      } catch (err) {
        console.error("Failed to load cross-currency history:", err);
        // A declined signature is the most common failure here and isn't
        // really an error — the payer just chose not to prove wallet
        // ownership right now. Say so without alarming language; same-
        // currency history above is unaffected either way.
        setFxError("Sign the request in your wallet to see cross-currency payments too.");
      }
    })();

    await Promise.all([onChainPromise, fxPromise]);
    setIsLoading(false);
  };

  useEffect(() => {
    if (!mounted || !isConnected || !address) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, isConnected, address]);

  const rows = [...onChainRows, ...fxRows];

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-2xl mx-auto px-4 pt-24 pb-24">
        <div className="mb-8">
          <h1 className="text-3xl font-anton text-brand-white">History</h1>
          <p className="text-brand-muted text-sm mt-1">All settled payments from this wallet</p>
        </div>

        {!mounted || !identity ? (
          <div className="text-center py-16 space-y-4">
            <p className="text-brand-muted">Connect your wallet to see your history.</p>
            <WalletConnect />
          </div>
        ) : identity.kind === "solana" || !isConnected ? (
          /* This one is a genuine gap, not a limitation of the rails, and it is
             described as such. Both halves of this page key on an Arc address:
             the on-chain half reads Arc receipts for it, and the cross-currency
             half proves ownership with an EVM signature. A bridged payment mints
             at Conduit's relayer, and nothing recorded on our side ties it back
             to the Solana address that funded it. Making this work needs the
             payer's source address stored at spend time and a lookup that can
             verify an ed25519 signature -- real work, not a display fix. */
          <ArcOnlyNotice
            title="History is tied to an Arc address"
            body={
              <>
                <p>
                  Your Solana payments do settle — they just aren&apos;t listed
                  here yet. A bridged payment arrives on Arc from Conduit&apos;s
                  relayer, so there is no Arc address of yours for this page to
                  look up.
                </p>
                <p>
                  The receipt shown when a payment completes, and its ArcScan
                  link, remain the record until Solana history is built.
                </p>
              </>
            }
          />
        ) : (
          <>
            {error && (
              <div className="mb-4 p-3 bg-danger/10 border border-danger/30 flex items-center justify-between gap-3">
                <p className="text-danger text-sm font-mono">{error}</p>
                <button
                  onClick={load}
                  disabled={isLoading}
                  className="shrink-0 px-3 py-1.5 text-scale-2 font-mono border border-danger/40
                             text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
                >
                  {isLoading ? "Retrying…" : "Retry"}
                </button>
              </div>
            )}
            {fxError && !isLoading && (
              <div className="mb-4 p-3 bg-surface border border-border flex items-center justify-between gap-3">
                <p className="text-ink-dim text-sm font-mono">{fxError}</p>
                <button
                  onClick={load}
                  className="shrink-0 px-3 py-1.5 text-scale-2 font-mono border border-border
                             text-ink-dim hover:text-ink transition-colors"
                >
                  Sign
                </button>
              </div>
            )}
            <HistoryTable rows={rows} isLoading={isLoading} />
          </>
        )}
      </main>
      <MobileNav />
    </div>
  );
}
