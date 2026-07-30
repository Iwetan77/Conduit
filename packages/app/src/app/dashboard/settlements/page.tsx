"use client";

import { useEffect, useMemo, useState } from "react";
import { listSettlements, type Settlement, ConduitApiError } from "@/lib/conduit-api";
import { formatDate, shortenAddress } from "@/lib/format";

const EXPLORER = process.env["NEXT_PUBLIC_EXPLORER"] ?? "https://testnet.arcscan.app";

function formatMinor(amount: string, currency: string): string {
  // Settlement rows carry pre-formatted decimal strings from the API (Postgres
  // NUMERIC as text) — not raw minor-unit bigints, so no decimals lookup needed
  // here; just present them.
  return `${amount} ${currency}`;
}

export default function SettlementsPage() {
  const [settlements, setSettlements] = useState<Settlement[] | null>(null);
  const [error, setError] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    listSettlements()
      .then((res) => setSettlements(res.data ?? []))
      .catch((err) => setError(err instanceof ConduitApiError ? err.message : "Failed to load settlements"));
  }, []);

  const currencies = useMemo(() => {
    const set = new Set((settlements ?? []).map((s) => s.settle_currency));
    return Array.from(set);
  }, [settlements]);

  const filtered = useMemo(() => {
    return (settlements ?? []).filter((s) => {
      if (currencyFilter !== "all" && s.settle_currency !== currencyFilter) return false;
      if (search && !`${s.reference ?? ""} ${s.settle_address}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [settlements, currencyFilter, search]);

  const heroLabel = currencyFilter === "all" ? "Total settlements" : `Total settled · ${currencyFilter}`;
  const heroValue =
    currencyFilter === "all"
      ? String(filtered.length)
      : filtered
          .reduce((sum, s) => sum + Number(s.settle_amount), 0)
          .toLocaleString("en-US", { maximumFractionDigits: 2 });

  return (
    <div>
      <div className="mb-8">
        <p className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider mb-1">{heroLabel}</p>
        <p className="font-anton text-scale-6 text-ink leading-none">{heroValue}</p>
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl font-bold">Settlements</h1>
      </div>

      <div className="flex gap-3 mb-4">
        <input
          className="bg-surface border border-border px-3 py-1.5 text-sm flex-1"
          placeholder="Search reference or address..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="bg-surface border border-border px-3 py-1.5 text-sm"
          value={currencyFilter}
          onChange={(e) => setCurrencyFilter(e.target.value)}
        >
          <option value="all">All currencies</option>
          {currencies.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      {settlements === null && !error && <p className="text-ink-dim text-sm">Loading...</p>}

      {settlements !== null && filtered.length === 0 && (
        <div className="border border-border p-8 text-center text-ink-dim text-sm">
          No settlements yet. Create a payment request to get started.
        </div>
      )}

      {filtered.length > 0 && (
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-ink-dim text-scale-1 font-mono uppercase tracking-wider text-left">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 font-medium">Counterparty</th>
                <th className="px-4 py-3 font-medium text-right">Paid</th>
                <th className="px-4 py-3 font-medium text-right">Received</th>
                <th className="px-4 py-3 font-medium text-right">Rate</th>
                <th className="px-4 py-3 font-medium text-right">Fee</th>
                <th className="px-4 py-3 font-medium text-right">Net</th>
                <th className="px-4 py-3 font-medium text-right">Tx</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const net = (Number(s.settle_amount) - Number(s.fee)).toString();
                return (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-surface/50">
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-ink-dim">{formatDate(new Date(s.settled_at).getTime() / 1000)}</td>
                    <td className="px-4 py-3 font-mono">{s.reference || "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">{shortenAddress(s.settle_address)}</td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-right">{formatMinor(s.pay_amount, s.pay_currency)}</td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-right">{formatMinor(s.settle_amount, s.settle_currency)}</td>
                    <td className="px-4 py-3 font-mono text-right">{s.rate_applied ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-right">{s.fee}</td>
                    <td className="px-4 py-3 font-mono text-right">{net} {s.settle_currency}</td>
                    <td className="px-4 py-3 text-right">
                      <a
                        href={`${EXPLORER}/tx/${s.tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-signal hover:underline text-xs font-mono"
                      >
                        {shortenAddress(s.tx_hash, 6)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
