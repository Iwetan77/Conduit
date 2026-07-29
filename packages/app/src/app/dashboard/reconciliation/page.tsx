"use client";

import { useEffect, useState } from "react";
import { listBalanceTransactions, downloadBalanceTransactionsCsv, type BalanceTransaction, ConduitApiError } from "@/lib/conduit-api";
import { formatDate } from "@/lib/format";

export default function ReconciliationPage() {
  const [transactions, setTransactions] = useState<BalanceTransaction[] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listBalanceTransactions()
      .then((r) => setTransactions(r.data ?? []))
      .catch((err) => setError(err instanceof ConduitApiError ? err.message : "Failed to load"));
  }, []);

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
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl font-bold">Reconciliation</h1>
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="bg-brand-green text-brand-black font-medium rounded px-4 py-2 text-sm disabled:opacity-50"
        >
          {downloading ? "Preparing..." : "Download CSV"}
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      <div className="border border-brand-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-brand-border text-brand-muted text-xs uppercase text-left">
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Gross</th>
              <th className="px-4 py-3 font-medium">Fee</th>
              <th className="px-4 py-3 font-medium">Net</th>
              <th className="px-4 py-3 font-medium">Currency</th>
            </tr>
          </thead>
          <tbody>
            {(transactions ?? []).map((t) => (
              <tr key={t.id} className="border-b border-brand-border last:border-0">
                <td className="px-4 py-3 whitespace-nowrap">{formatDate(new Date(t.created_at).getTime() / 1000)}</td>
                <td className="px-4 py-3">{t.type}</td>
                <td className="px-4 py-3">{t.gross}</td>
                <td className="px-4 py-3">{t.fee}</td>
                <td className="px-4 py-3">{t.net}</td>
                <td className="px-4 py-3">{t.currency}</td>
              </tr>
            ))}
            {transactions?.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-brand-muted text-sm">No transactions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-brand-muted mt-2">
        Table shows raw minor-unit amounts; the CSV export converts each to its currency&apos;s real decimal precision.
      </p>
    </div>
  );
}
