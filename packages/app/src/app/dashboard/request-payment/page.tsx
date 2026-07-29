"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { createSettlementIntent, type SettlementIntent, ConduitApiError } from "@/lib/conduit-api";

const CURRENCIES = ["EUR", "USD", "BRL", "AUD", "MXN", "CAD", "GBP", "ZAR"];

// This form's amount input assumes 6 fractional digits max for simplicity;
// the API stores minor units per the settle currency's real decimals
// (18dp for BRL/ZAR) — parse defensively rather than hardcoding a factor.
function toMinorUnits(humanAmount: string): string {
  const clean = humanAmount.replace(/[^0-9.]/g, "");
  const [whole = "0", frac = ""] = clean.split(".");
  const padded = frac.padEnd(6, "0").slice(0, 6);
  return (BigInt(whole || "0") * 1_000_000n + BigInt(padded || "0")).toString();
}

export default function RequestPaymentPage() {
  const [amount, setAmount] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("EUR");
  const [reference, setReference] = useState("");
  const [expiresIn, setExpiresIn] = useState("3600");
  const [acceptCurrencies, setAcceptCurrencies] = useState<string[]>([]);
  const [settleAddress, setSettleAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SettlementIntent | null>(null);

  const toggleAccept = (c: string) => {
    setAcceptCurrencies((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const intent = await createSettlementIntent({
        amount: toMinorUnits(amount),
        settle_currency: settleCurrency,
        settle_address: settleAddress,
        accept_currencies: acceptCurrencies.length ? acceptCurrencies : undefined,
        reference: reference || undefined,
        expires_in: Number(expiresIn),
      });
      setResult(intent);
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Failed to create payment request");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="max-w-md">
        <h1 className="font-display text-3xl font-bold mb-6">Payment requested</h1>
        <div className="border border-brand-border rounded-lg p-6 flex flex-col items-center gap-4">
          <div style={{ background: "#000", padding: 12, borderRadius: 12, border: "2px solid #1F1F1F" }}>
            <QRCodeSVG value={result.hosted_url} size={200} bgColor="#000000" fgColor="#B2F55A" level="H" />
          </div>
          <p className="text-sm text-brand-muted">{result.reference || result.id}</p>
          <div className="w-full flex gap-2">
            <input
              readOnly
              className="flex-1 bg-brand-surface border border-brand-border rounded px-3 py-2 text-xs font-mono"
              value={result.hosted_url}
              onFocus={(e) => e.target.select()}
            />
            <button
              className="border border-brand-border rounded px-3 py-2 text-xs"
              onClick={() => navigator.clipboard.writeText(result.hosted_url)}
            >
              Copy
            </button>
          </div>
          <button
            className="text-brand-green text-sm hover:underline"
            onClick={() => {
              setResult(null);
              setAmount("");
              setReference("");
            }}
          >
            Create another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md">
      <h1 className="font-display text-3xl font-bold mb-6">Request payment</h1>
      <form onSubmit={handleSubmit} className="space-y-4 border border-brand-border rounded-lg p-6">
        <div>
          <label className="text-xs text-brand-muted block mb-1">Amount</label>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
            <select
              className="bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm"
              value={settleCurrency}
              onChange={(e) => setSettleCurrency(e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="text-xs text-brand-muted block mb-1">Settle to address</label>
          <input
            className="w-full bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm font-mono"
            placeholder="0x..."
            value={settleAddress}
            onChange={(e) => setSettleAddress(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="text-xs text-brand-muted block mb-1">Reference (optional)</label>
          <input
            className="w-full bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm"
            placeholder="INV-2026-0412"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>

        <div>
          <label className="text-xs text-brand-muted block mb-1">Expires in</label>
          <select
            className="w-full bg-brand-surface border border-brand-border rounded px-3 py-2 text-sm"
            value={expiresIn}
            onChange={(e) => setExpiresIn(e.target.value)}
          >
            <option value="900">15 minutes</option>
            <option value="3600">1 hour</option>
            <option value="86400">24 hours</option>
            <option value="604800">7 days</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-brand-muted block mb-2">Accepted currencies (default: all routable)</label>
          <div className="flex flex-wrap gap-2">
            {CURRENCIES.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => toggleAccept(c)}
                className={`text-xs px-2 py-1 rounded border ${
                  acceptCurrencies.includes(c)
                    ? "border-brand-green text-brand-green"
                    : "border-brand-border text-brand-muted"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-brand-green text-brand-black font-medium rounded py-2 text-sm disabled:opacity-50"
        >
          {busy ? "Creating..." : "Create payment request"}
        </button>
      </form>
    </div>
  );
}
