"use client";

import { useBalanceTransactions } from "@/lib/queries";
import { useState } from "react";
import { listBalanceTransactions, downloadBalanceTransactionsCsv, type BalanceTransaction, ConduitApiError } from "@/lib/conduit-api";
import { formatDate, minorUnitsToNumber } from "@/lib/format";
import { PageHeader } from "@/components/Dashboard/PageHeader";

// Value only (no currency suffix) — this table has a dedicated Currency column.
function money(amount: string, currency: string): string {
  return minorUnitsToNumber(amount, currency).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function ReconciliationPage() {
  const { data: transactions, error: queryError } = useBalanceTransactions();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const loadError = queryError ? "Failed to load balance transactions" : "";

  const handleDownload = async () => {
    setDownloading(true);
    setError("");
    try {
      await downloadBalanceTransactionsCsv();
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Export failed");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="Reconciliation"
        description="Export settled payments for your books, in the currency you keep them in."
        action={
          <><button
          onClick={handleDownload}
          disabled={downloading}
          className="bg-signal text-signal-ink font-medium px-4 py-2 text-sm disabled:opacity-50"
        >
          {downloading ? "Preparing..." : "Download CSV"}
        </button></>
        }
      />

      {(error || loadError) && <p className="text-danger text-sm mb-4">{error || loadError}</p>}

      <div className="border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-ink-dim text-scale-1 font-mono uppercase tracking-wider text-left">
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium text-right">Gross</th>
              <th className="px-4 py-3 font-medium text-right">Fee</th>
              <th className="px-4 py-3 font-medium text-right">Net</th>
              <th className="px-4 py-3 font-medium">Currency</th>
            </tr>
          </thead>
          <tbody>
            {(transactions ?? []).map((t) => (
              <tr key={t.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 whitespace-nowrap font-mono text-ink-dim">{formatDate(new Date(t.created_at).getTime() / 1000)}</td>
                <td className="px-4 py-3 font-mono">{t.type}</td>
                <td className="px-4 py-3 font-mono text-right">{money(t.gross, t.currency)}</td>
                <td className="px-4 py-3 font-mono text-right">{money(t.fee, t.currency)}</td>
                <td className="px-4 py-3 font-mono text-right">{money(t.net, t.currency)}</td>
                <td className="px-4 py-3 font-mono">{t.currency}</td>
              </tr>
            ))}
            {transactions?.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-dim text-sm">No transactions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-dim mt-2">
        Amounts are shown in each currency&apos;s real decimal precision; the CSV export matches.
      </p>
    </div>
  );
}
