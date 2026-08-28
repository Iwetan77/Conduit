"use client";

import { usePayerIdentity } from "@/lib/use-payer-identity";
import { ArcOnlyNotice } from "@/components/Shared/ArcOnlyNotice";
import { useHydrated } from "@/lib/use-hydrated";
import { useMemo } from "react";
import { useAccount } from "wagmi";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import {
  HistoryTable,
  onChainReceiptsToRows,
  walletSettlementsToRows,
} from "@/components/Shared/HistoryTable";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { useOnChainHistory, useWalletFxHistory } from "@/lib/payer-queries";

export default function HistoryPage() {
  const { address, isConnected, connector } = useAccount();
  const mounted = useHydrated();
  const { identity } = usePayerIdentity();

  // Both halves cached, and each still fills in independently of the other.
  //
  // Same-currency: a pure on-chain read, no server involved. Cross-currency:
  // Circle's maker settles via Permit2, which never touches ConduitRouter, so
  // those payments have no on-chain event at all — the only record is Conduit's
  // own database, reached with a wallet signature proving this is genuinely
  // that wallet's history to see.
  //
  // That signature is why caching matters most here. It used to be requested on
  // every mount, so leaving the page and coming back meant approving a wallet
  // prompt again to see rows the browser had just displayed. It is now once per
  // wallet per five minutes; the Refresh button forces it when actually wanted.
  const ready = mounted && isConnected && !!address;
  const onChain = useOnChainHistory(address, ready);
  const fx = useWalletFxHistory(address, connector, ready);

  const onChainRows = useMemo(
    () => (onChain.data && address ? onChainReceiptsToRows(onChain.data, address) : []),
    [onChain.data, address],
  );
  const fxRows = useMemo(
    () => (fx.data ? walletSettlementsToRows(fx.data) : []),
    [fx.data],
  );

  // "Failed to fetch" here is Arc's public RPC rate-limiting the browser — say
  // that, not a bare fetch error.
  const error = onChain.error
    ? "Arc's public RPC is rate-limiting right now. Wait a few seconds and retry."
    : "";
  // A declined signature is the most common failure on this half and is not
  // really an error — the payer just chose not to prove wallet ownership right
  // now. Said without alarm; the same-currency half above is unaffected.
  const fxError = fx.error
    ? "Sign the request in your wallet to see cross-currency payments too."
    : "";
  const isLoading = onChain.isLoading || fx.isLoading;
  const load = () => {
    void onChain.refetch();
    void fx.refetch();
  };

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
