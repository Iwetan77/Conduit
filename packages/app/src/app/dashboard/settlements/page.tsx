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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl font-bold">Settlements</h1>
      </div>

      <div className="flex gap-3 mb-4">
        <input
          className="bg-brand-surface border border-brand-border rounded px-3 py-1.5 text-sm flex-1"
          placeholder="Search reference or address..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="bg-brand-surface border border-brand-border rounded px-3 py-1.5 text-sm"
          value={currencyFilter}
          onChange={(e) => setCurrencyFilter(e.target.value)}
        >
          <option value="all">All currencies</option>
          {currencies.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {settlements === null && !error && <p className="text-brand-muted text-sm">Loading...</p>}

      {settlements !== null && filtered.length === 0 && (
        <div className="border border-brand-border rounded-lg p-8 text-center text-brand-muted text-sm">
          No settlements yet. Create a payment request to get started.
        </div>
      )}

      {filtered.length > 0 && (
        <div className="border border-brand-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brand-border text-brand-muted text-xs uppercase text-left">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 font-medium">Counterparty</th>
                <th className="px-4 py-3 font-medium">Paid</th>
                <th className="px-4 py-3 font-medium">Received</th>
                <th className="px-4 py-3 font-medium">Rate</th>
                <th className="px-4 py-3 font-medium">Fee</th>
                <th className="px-4 py-3 font-medium">Net</th>
                <th className="px-4 py-3 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const net = (Number(s.settle_amount) - Number(s.fee)).toString();
                return (
                  <tr key={s.id} className="border-b border-brand-border last:border-0 hover:bg-brand-surface/50">
                    <td className="px-4 py-3 whitespace-nowrap">{formatDate(new Date(s.settled_at).getTime() / 1000)}</td>
                    <td className="px-4 py-3">{s.reference || "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">{shortenAddress(s.settle_address)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatMinor(s.pay_amount, s.pay_currency)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatMinor(s.settle_amount, s.settle_currency)}</td>
                    <td className="px-4 py-3">{s.rate_applied ?? "—"}</td>
                    <td className="px-4 py-3">{s.fee}</td>
                    <td className="px-4 py-3">{net} {s.settle_currency}</td>
                    <td className="px-4 py-3">
                      <a
                        href={`${EXPLORER}/tx/${s.tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand-green hover:underline text-xs font-mono"
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
