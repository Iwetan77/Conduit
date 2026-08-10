"use client";

import { useEffect, useMemo, useState } from "react";
import { listSettlements, type Settlement, ConduitApiError } from "@/lib/conduit-api";
import { formatDate, shortenAddress, formatMinorUnits, minorUnitsToNumber } from "@/lib/format";
import { PageHeader } from "@/components/Dashboard/PageHeader";

const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER ?? "https://testnet.arcscan.app";

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

  // Money settled, not just a row count. Grouped by settle currency (rows can
  // mix EUR/USD/…), each total converted from raw minor units to its currency's
  // real precision — the same conversion the table cells were missing.
  const settledTotals = useMemo(() => {
    const byCurrency = new Map<string, { received: number; net: number; count: number }>();
    for (const s of filtered) {
      const cur = s.settle_currency;
      const entry = byCurrency.get(cur) ?? { received: 0, net: 0, count: 0 };
      entry.received += minorUnitsToNumber(s.settle_amount, cur);
      entry.net += minorUnitsToNumber((BigInt(s.settle_amount) - BigInt(s.fee)).toString(), cur);
      entry.count += 1;
      byCurrency.set(cur, entry);
    }
    return Array.from(byCurrency.entries());
  }, [filtered]);

  const fmtMoney = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div>
      <PageHeader title="Settlements" description="Every payment that has landed, with the on-chain transaction behind it." />

      {/* The headline figure, in its own panel. It used to sit bare on the grid
          ABOVE the page title, so the first thing on screen was an unlabelled
          number with no page context around it. */}
      <div className="border border-border bg-surface p-6 mb-6">
        <p className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider mb-3">
          {currencyFilter === "all" ? "Money settled" : `Settled · ${currencyFilter}`}
        </p>
        {settledTotals.length === 0 ? (
          <>
            <p className="font-anton text-scale-6 text-ink leading-none">0</p>
            <p className="text-scale-1 font-mono text-ink-dim mt-2">
              Nothing settled yet — create a payment link to get started.
            </p>
          </>
        ) : (
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            {settledTotals.map(([cur, t]) => (
              <div key={cur}>
                <p className="font-anton text-scale-5 text-ink leading-none">
                  {fmtMoney(t.net)} <span className="text-scale-3 text-ink-dim">{cur}</span>
                </p>
                <p className="text-scale-1 font-mono text-ink-dim mt-1">
                  net received · {t.count} settlement{t.count === 1 ? "" : "s"} · {fmtMoney(t.received)} gross
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
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
                const net = (BigInt(s.settle_amount) - BigInt(s.fee)).toString();
                return (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-surface/50">
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-ink-dim">{formatDate(new Date(s.settled_at).getTime() / 1000)}</td>
                    <td className="px-4 py-3 font-mono">{s.reference || "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">{shortenAddress(s.settle_address)}</td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-right">{formatMinorUnits(s.pay_amount, s.pay_currency)}</td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-right">{formatMinorUnits(s.settle_amount, s.settle_currency)}</td>
                    <td className="px-4 py-3 font-mono text-right">{s.rate_applied ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-right">{formatMinorUnits(s.fee, s.settle_currency)}</td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono text-right">{formatMinorUnits(net, s.settle_currency)}</td>
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
