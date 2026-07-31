"use client";

import { useEffect, useState } from "react";
import { listPaymentLinks, voidPaymentLink, type PaymentLink, ConduitApiError } from "@/lib/conduit-api";
import { formatDate } from "@/lib/format";

// Mirrors request-payment's own simplification: assumes 6 fractional digits
// for display. The API stores real integer minor units regardless.
function formatMinor(amount: string | undefined, currency: string): string {
  if (!amount) return "—";
  const value = Number(amount) / 1_000_000;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
}

const STATUS_STYLE: Record<string, string> = {
  draft: "text-ink-dim",
  active: "text-signal",
  viewed: "text-signal",
  paid: "text-ink",
  settled: "text-ink",
  expired: "text-danger",
  void: "text-danger",
};

export default function LinksPage() {
  const [links, setLinks] = useState<PaymentLink[] | null>(null);
  const [error, setError] = useState("");
  const [voidingID, setVoidingID] = useState<string | null>(null);

  const load = () => {
    listPaymentLinks()
      .then((res) => setLinks(res.data ?? []))
      .catch((err) => setError(err instanceof ConduitApiError ? err.message : "Failed to load payment links"));
  };

  useEffect(load, []);

  const handleVoid = async (id: string) => {
    setVoidingID(id);
    try {
      await voidPaymentLink(id);
      load();
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Failed to void link");
    } finally {
      setVoidingID(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl font-bold">Links & invoices</h1>
      </div>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}
      {links === null && !error && <p className="text-ink-dim text-sm">Loading...</p>}

      {links !== null && links.length === 0 && (
        <div className="border border-border p-8 text-center text-ink-dim text-sm">
          No payment links yet. Create one from "Request payment".
        </div>
      )}

      {links !== null && links.length > 0 && (
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-ink-dim text-scale-1 font-mono uppercase tracking-wider text-left">
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Mode</th>
                <th className="px-4 py-3 font-medium">Reuse</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0 hover:bg-surface/50">
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-ink-dim">{formatDate(new Date(l.created).getTime() / 1000)}</td>
                  <td className="px-4 py-3 font-mono">{l.merchant_reference || l.description || l.id}</td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono">
                    {l.amount_mode === "open" ? "Open" : formatMinor(l.amount, l.settle_currency)}
                  </td>
                  <td className="px-4 py-3 text-ink-dim">{l.amount_mode.replace(/_/g, " ")}</td>
                  <td className="px-4 py-3 text-ink-dim">{l.reuse_policy === "multi_use" ? "Reusable" : "Single use"}</td>
                  <td className={`px-4 py-3 font-mono uppercase ${STATUS_STYLE[l.status] ?? ""}`}>{l.status}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-2 justify-end">
                      <button
                        className="text-xs font-mono text-ink-dim hover:text-ink"
                        onClick={() => navigator.clipboard.writeText(l.hosted_url)}
                      >
                        Copy link
                      </button>
                      {(l.status === "draft" || l.status === "active" || l.status === "viewed") && (
                        <button
                          className="text-xs font-mono text-danger hover:underline disabled:opacity-50"
                          disabled={voidingID === l.id}
                          onClick={() => handleVoid(l.id)}
                        >
                          {voidingID === l.id ? "Voiding..." : "Void"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
