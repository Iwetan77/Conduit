"use client";

import { useState } from "react";
import { usePublicIntent } from "@/lib/use-public-intent";
import type { Currency } from "@conduit/sdk/lite";
import { currencyDecimals } from "@conduit/sdk/lite";
import { formatAmountRaw, shortenAddress } from "@/lib/format";
import { isoToToken } from "@/lib/currencies";
import { CrossChainBridge } from "./CrossChainBridge";
import { ArcSettlePanel } from "./ArcSettlePanel";

interface SettlementIntentPayProps {
  intentId: string;
}

// Payer surface for the B2B settlement_intents API (si_ ids) -- distinct
// from the older on-chain declaration flow this route also serves. If
// source_chain is anything other than "arc", the payer is bridging in via
// CCTP and CrossChainBridge drives the rest of this page.
export function SettlementIntentPay({ intentId }: SettlementIntentPayProps) {
  const [showAddress, setShowAddress] = useState(false);
  // Payer-chosen cross-chain: even an intent created for on-Arc payment can be
  // paid with USDC from another chain (Solana / Base / Polygon). The merchant no
  // longer has to pre-declare source_chain — the payer decides at pay time.
  const [payFromOtherChain, setPayFromOtherChain] = useState(false);

  // Shared query with the page's title effect — one request, not two.
  // Keyed by intentId with NO previous-data retention, which is what keeps
  // one invoice's merchant and amount from ever rendering on another's page
  // (the leak this replaced used raw state that survived the id change).
  const { data: fetched, isError } = usePublicIntent(intentId);
  const intent = fetched ?? null;
  const loadError = isError ? "This payment link was not found or has expired." : "";

  if (loadError) {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-4xl">⚠</p>
        <p className="text-ink font-medium">{loadError}</p>
        <p className="text-ink-dim text-sm">Ask the business that sent it for a new link.</p>
      </div>
    );
  }

  if (!intent) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-surface" />
        <div className="h-32 bg-surface" />
      </div>
    );
  }

  if (intent.status === "settled") {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-signal font-mono text-lg">Settled</p>
        <p className="text-ink-dim text-sm">This payment has already been completed.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {intent.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={intent.logo_url} alt="" className="w-10 h-10 object-contain border border-border bg-surface" />
        ) : (
          <div className="w-10 h-10 border border-border bg-surface flex items-center justify-center font-display font-bold text-signal">
            {intent.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <p className="text-ink font-medium">{intent.display_name}</p>
          <button
            type="button"
            onClick={() => setShowAddress((v) => !v)}
            className="text-ink-dim text-xs font-mono hover:text-ink"
          >
            {showAddress ? intent.settle_address : shortenAddress(intent.settle_address)}
          </button>
        </div>
      </div>

      <div className="border border-border bg-surface p-4 space-y-1">
        <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">Requesting</p>
        <p className="text-ink font-mono text-2xl">
          {formatAmountRaw(BigInt(intent.amount), currencyDecimals(isoToToken(intent.settle_currency)))}{" "}
          {intent.settle_currency}
        </p>
      </div>

      {intent.source_chain !== "arc" || payFromOtherChain ? (
        <>
          <CrossChainBridge intentId={intentId} intent={intent} />
          {intent.source_chain === "arc" && (
            <button
              type="button"
              onClick={() => setPayFromOtherChain(false)}
              className="text-ink-dim text-xs font-mono hover:text-ink"
            >
              ← Pay on Arc instead
            </button>
          )}
        </>
      ) : (
        <>
          <ArcSettlePanel
            settleToken={isoToToken(intent.settle_currency) as Currency}
            settleCurrencyIso={intent.settle_currency}
            settleAddress={intent.settle_address}
            amountRaw={BigInt(intent.amount)}
            displayName={intent.display_name}
            // The intent already exists on this surface — just hand back its id.
            ensureIntentId={async () => intent.id}
          />
          <button
            type="button"
            onClick={() => setPayFromOtherChain(true)}
            className="w-full text-center text-ink-dim text-xs font-mono hover:text-ink border border-border py-2 hover:border-signal/40 transition-colors"
          >
            Pay with USDC from another chain (Solana, Base, Polygon)
          </button>
        </>
      )}
    </div>
  );
}
