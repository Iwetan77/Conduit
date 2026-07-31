"use client";

// Payer surface for a payment link (pl_ ids) — Phase 3 built the lifecycle
// enforcement, Phase 5 wires the actual payer-facing consumption: show the
// link's identity/description/amount policy, collect an amount for
// open/open_with_suggested modes plus the payer's own reference (Phase
// 3.1's two-sided reconciliation field), then turn it into a real
// settlement_intent via POST /:id/pay and hand off to the existing si_ pay
// flow -- same component, no page reload.
import { useEffect, useState } from "react";
import {
  getPublicPaymentLink,
  payPaymentLink,
  type PublicPaymentLink,
  ConduitApiError,
} from "@/lib/conduit-api";
import { formatAmountRaw, shortenAddress } from "@/lib/format";
import { isoToToken } from "@/lib/currencies";
import { currencyDecimals } from "@conduit/sdk";
import { SettlementIntentPay } from "./SettlementIntentPay";

interface PaymentLinkPayProps {
  linkId: string;
}

// Minor units in the settle token's REAL decimals — BRLA/ZARU/KRW1 are
// 18-decimals tokens; assuming 6 there mis-prices by 10^12.
function toMinorUnits(humanAmount: string, decimals: number): string {
  const clean = humanAmount.replace(/[^0-9.]/g, "");
  const [whole = "0", frac = ""] = clean.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

export function PaymentLinkPay({ linkId }: PaymentLinkPayProps) {
  const [link, setLink] = useState<PublicPaymentLink | null>(null);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("");
  const [payerReference, setPayerReference] = useState("");
  const [showAddress, setShowAddress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [intentId, setIntentId] = useState<string | null>(null);

  useEffect(() => {
    getPublicPaymentLink(linkId)
      .then((l) => {
        setLink(l);
        document.title = `Pay ${l.display_name} · Conduit`;
        if (l.amount_mode === "open_with_suggested" && l.amount) {
          setAmount(formatAmountRaw(BigInt(l.amount), currencyDecimals(isoToToken(l.settle_currency))));
        }
      })
      .catch(() => setError("This payment link was not found or is no longer available."));
  }, [linkId]);

  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!link) return;
    setError("");
    setBusy(true);
    try {
      const needsAmount = link.amount_mode !== "fixed";
      const decimals = currencyDecimals(isoToToken(link.settle_currency));
      const result = await payPaymentLink(linkId, {
        amount: needsAmount && amount ? toMinorUnits(amount, decimals) : undefined,
        payer_reference: payerReference || undefined,
      });
      setIntentId(result.id);
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "This link can no longer be paid.");
    } finally {
      setBusy(false);
    }
  };

  // Once the link has been turned into a real settlement_intent, hand off
  // to the exact same flow a bare si_ link would use -- balance-aware
  // paying, honest bridge progress, everything.
  if (intentId) {
    return <SettlementIntentPay intentId={intentId} />;
  }

  if (error) {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-4xl">⚠</p>
        <p className="text-ink font-medium">{error}</p>
        <p className="text-ink-dim text-sm">Ask the business that sent it for a new link.</p>
      </div>
    );
  }

  if (!link) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-surface" />
        <div className="h-32 bg-surface" />
      </div>
    );
  }

  if (link.status === "void" || link.status === "expired") {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-ink font-medium">
          {link.status === "void" ? "This payment link has been voided." : "This payment link has expired."}
        </p>
      </div>
    );
  }
  if (link.status === "paid" || link.status === "settled") {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-signal font-mono text-lg">Already paid</p>
        <p className="text-ink-dim text-sm">This single-use link has already been used.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handlePay} className="space-y-6">
      <div className="flex items-center gap-3">
        {link.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={link.logo_url} alt="" className="w-10 h-10 object-contain border border-border bg-surface" />
        ) : (
          <div className="w-10 h-10 border border-border bg-surface flex items-center justify-center font-display font-bold text-signal">
            {link.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <p className="text-ink font-medium">{link.display_name}</p>
          <button
            type="button"
            onClick={() => setShowAddress((v) => !v)}
            className="text-ink-dim text-xs font-mono hover:text-ink"
          >
            {showAddress ? link.settle_address : shortenAddress(link.settle_address)}
          </button>
        </div>
      </div>

      {link.description && <p className="text-ink-dim text-sm">{link.description}</p>}

      <div className="border border-border bg-surface p-4 space-y-1">
        <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">
          {link.amount_mode === "fixed" ? "Requesting" : "Amount"}
        </p>
        {link.amount_mode === "fixed" && link.amount ? (
          <p className="text-ink font-mono text-2xl">
            {formatAmountRaw(BigInt(link.amount), currencyDecimals(isoToToken(link.settle_currency)))} {link.settle_currency}
          </p>
        ) : (
          <div className="flex items-baseline gap-2">
            <input
              className="flex-1 bg-transparent text-ink font-mono text-2xl focus:outline-none"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
            <span className="text-ink-dim font-mono">{link.settle_currency}</span>
          </div>
        )}
        {(link.min_amount || link.max_amount) && (
          <p className="text-ink-dim text-xs font-mono">
            {link.min_amount && `min ${formatAmountRaw(BigInt(link.min_amount), currencyDecimals(isoToToken(link.settle_currency)))}`}
            {link.min_amount && link.max_amount && " · "}
            {link.max_amount && `max ${formatAmountRaw(BigInt(link.max_amount), currencyDecimals(isoToToken(link.settle_currency)))}`}
          </p>
        )}
      </div>

      <div>
        <label className="text-ink-dim text-xs uppercase tracking-wider font-mono block mb-1">
          Your reference (optional)
        </label>
        <input
          className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
          placeholder="Your PO number, etc."
          value={payerReference}
          onChange={(e) => setPayerReference(e.target.value)}
        />
      </div>

      <button
        type="submit"
        disabled={busy}
        className="w-full py-4 bg-signal text-signal-ink font-mono text-lg hover:bg-signal/90 transition-colors disabled:opacity-50"
      >
        {busy ? "Preparing..." : "Continue to pay"}
      </button>
    </form>
  );
}
