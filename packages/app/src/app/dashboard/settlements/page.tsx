"use client";

import { useEffect, useMemo, useState } from "react";
import { listSettlements, getMyAccount, type Settlement, ConduitApiError } from "@/lib/conduit-api";
import { formatDate, shortenAddress, formatMinorUnits, tokenLabel } from "@/lib/format";
import { PageHeader } from "@/components/Dashboard/PageHeader";
import { useSettledTotal, type CurrencyTotal } from "@/lib/use-settled-total";

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
      if (search && !`${s.reference ?? ""} ${s.payer_address ?? ""} ${s.settle_address}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [settlements, currencyFilter, search]);

  // Per-currency subtotals, summed in integer minor units so they stay exact.
  // These are the input to the roll-up, not the headline itself.
  const perCurrency: CurrencyTotal[] = useMemo(() => {
    const byCurrency = new Map<string, CurrencyTotal>();
    for (const s of filtered) {
      const cur = s.settle_currency;
      const entry = byCurrency.get(cur) ?? { currency: cur, netMinor: 0n, grossMinor: 0n, count: 0 };
      entry.grossMinor += BigInt(s.settle_amount);
      entry.netMinor += BigInt(s.settle_amount) - BigInt(s.fee);
      entry.count += 1;
      byCurrency.set(cur, entry);
    }
    return Array.from(byCurrency.values());
  }, [filtered]);

  // What one number should be denominated in: the merchant's own settle
  // currency, chosen in Settings. Filtering to a single currency answers a
  // different question ("how much of THIS did I take"), so that view reports
  // that currency exactly, with no conversion.
  const [settleCurrency, setSettleCurrency] = useState<string | undefined>();
  useEffect(() => {
    getMyAccount().then((a) => setSettleCurrency(a.settle_currency)).catch(() => {});
  }, []);

  const displayCurrency = currencyFilter === "all" ? settleCurrency : currencyFilter;
  const total = useSettledTotal(perCurrency, displayCurrency);

  const fmtMoney = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div>
      <PageHeader title="Settlements" description="Every payment that has landed, with the on-chain transaction behind it." />

      {/* The headline figure, in its own panel. It used to sit bare on the grid
          ABOVE the page title, so the first thing on screen was an unlabelled
          number with no page context around it. */}
      <div className="border border-border bg-surface p-6 mb-6">
        <p className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider mb-3">
          {currencyFilter === "all" ? "Money settled" : `Settled · ${tokenLabel(currencyFilter)}`}
        </p>
        {perCurrency.length === 0 ? (
          <>
            <p className="font-anton text-scale-6 text-ink leading-none">0</p>
            <p className="text-scale-1 font-mono text-ink-dim mt-2">
              Nothing settled yet — create a payment link to get started.
            </p>
          </>
        ) : (
          <>
            {/* One number, in the merchant's own currency. Takings in other
                currencies are rolled in at today's rate — marked with ≈ so the
                figure is never mistaken for an exact historical total. */}
            <p className="font-anton text-scale-5 text-ink leading-none">
              {total.approximate && <span className="text-ink-dim">≈ </span>}
              {total.loading && total.net === 0 ? "…" : fmtMoney(total.net)}{" "}
              <span className="text-scale-3 text-ink-dim">
                {displayCurrency ? tokenLabel(displayCurrency) : ""}
              </span>
            </p>
            <p className="text-scale-1 font-mono text-ink-dim mt-1">
              net received · {total.count} settlement{total.count === 1 ? "" : "s"} ·{" "}
              {fmtMoney(total.gross)} gross
              {total.approximate && " · converted at today's rate"}
            </p>

            {/* Money we hold but can't express in the display currency, because
                the pair has no FX route. Shown rather than dropped: a total that
                quietly omits real takings is worse than one that admits a gap. */}
            {total.unconverted.length > 0 && (
              <p className="text-scale-1 font-mono text-ink-dim mt-3">
                plus{" "}
                {total.unconverted.map((u, i) => (
                  <span key={u.currency}>
                    {i > 0 && ", "}
                    {formatMinorUnits(u.netMinor.toString(), u.currency)}
                  </span>
                ))}{" "}
                — no rate available to convert
              </p>
            )}
          </>
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
            <option key={c} value={c}>{tokenLabel(c)}</option>
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
                    {/* Was settle_address — the merchant's OWN receiving
                        address, so this column showed the same value on every
                        row and named the wrong party entirely. */}
                    <td className="px-4 py-3 font-mono text-xs">
                      {s.payer_address ? shortenAddress(s.payer_address) : <span className="text-ink-dim">—</span>}
                    </td>
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
