"use client";

import { useEffect, useState } from "react";
import { getPublicSettlementIntent, type PublicSettlementIntent } from "@/lib/conduit-api";
import { formatAmountRaw, shortenAddress } from "@/lib/format";
import { CrossChainBridge } from "./CrossChainBridge";

interface SettlementIntentPayProps {
  intentId: string;
}

// Payer surface for the B2B settlement_intents API (si_ ids) -- distinct
// from the older on-chain declaration flow this route also serves. If
// source_chain is anything other than "arc", the payer is bridging in via
// CCTP and CrossChainBridge drives the rest of this page.
export function SettlementIntentPay({ intentId }: SettlementIntentPayProps) {
  const [intent, setIntent] = useState<PublicSettlementIntent | null>(null);
  const [error, setError] = useState("");
  const [showAddress, setShowAddress] = useState(false);

  useEffect(() => {
    getPublicSettlementIntent(intentId)
      .then(setIntent)
      .catch(() => setError("This payment link was not found or has expired."));
  }, [intentId]);

  if (error) {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-4xl">⚠</p>
        <p className="text-ink font-medium">{error}</p>
        <a href="/" className="text-signal text-sm hover:underline">Go to Conduit →</a>
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
          {formatAmountRaw(BigInt(intent.amount), 6)} {intent.settle_currency}
        </p>
      </div>

      {intent.source_chain !== "arc" ? (
        <CrossChainBridge intentId={intentId} intent={intent} />
      ) : (
        // Direct same-chain checkout (payer already holding funds on Arc)
        // isn't wired to this page yet -- the settlement_intents REST flow
        // needs a client-facing key-distribution story (pk_ keys aren't
        // embedded in hosted links today) that's a separate piece of work
        // from CCTP cross-chain inbound. Documented honestly rather than
        // faking a pay button that can't actually call quote/prepare/confirm
        // without credentials this page has no way to obtain.
        <p className="text-ink-dim text-sm">
          Direct payment from an Arc wallet isn&apos;t available on this page yet.
        </p>
      )}
    </div>
  );
}
