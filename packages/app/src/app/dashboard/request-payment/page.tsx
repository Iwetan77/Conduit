"use client";

import { useMyAccount } from "@/lib/queries";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { createPaymentLink, type PaymentLink, type AmountMode, type ReusePolicy, ConduitApiError } from "@/lib/conduit-api";
import { SETTLE_CURRENCIES as CURRENCIES, isoToToken } from "@/lib/currencies";
import { SettleCurrencySelect } from "@/components/Shared/SettleCurrencySelect";
import { TokenIcon } from "@/components/Shared/TokenBadge";
import { currencyDecimals, type Currency } from "@conduit/sdk/lite";
import { shortenAddress } from "@/lib/format";
import { useCopy } from "@/lib/use-copy";
import { PageHeader } from "@/components/Dashboard/PageHeader";

// Minor units in the settle token's REAL decimals — BRLA/ZARU/KRW1 are
// 18-decimals tokens; a hardcoded 6 mis-prices those links by 10^12.
function toMinorUnits(humanAmount: string, decimals: number): string {
  const clean = humanAmount.replace(/[^0-9.]/g, "");
  const [whole = "0", frac = ""] = clean.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

export default function RequestPaymentPage() {
  const [amountMode, setAmountMode] = useState<AmountMode>("fixed");
  const [amount, setAmount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [settleCurrency, setSettleCurrency] = useState("EUR");
  const [description, setDescription] = useState("");
  const [merchantReference, setMerchantReference] = useState("");
  const [reusePolicy, setReusePolicy] = useState<ReusePolicy>("single_use");
  const [expiresIn, setExpiresIn] = useState("3600");
  const [acceptCurrencies, setAcceptCurrencies] = useState<string[]>([]);
  // The merchant's own account address, prefilled below. Kept separately so
  // "Use my account address" can restore it after the merchant has edited the
  // field, and so we can show whether they're paying out to themselves or
  // somewhere else.
  const [accountAddress, setAccountAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();
  const [error, setError] = useState("");
  const [result, setResult] = useState<PaymentLink | null>(null);

  // Default the payout to the merchant's own settle address (and match their
  // account's settle currency) rather than an empty field they must paste an
  // address into every time. They can still send a link's proceeds elsewhere
  // via "Use a different address".
  // The fourth page fetching the same account, concurrently with the sidebar.
  // Shared key now, so the whole dashboard makes one request for it.
  //
  // A failure stays non-fatal: the field remains editable and required, exactly
  // as before.
  const { data: myAccount } = useMyAccount();
  useEffect(() => {
    const addr = myAccount?.settle_address;
    if (!addr) return;
    setAccountAddress(addr);
  }, [myAccount?.settle_address]);

  const toggleAccept = (c: string) => {
    setAcceptCurrencies((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const decimals = currencyDecimals(isoToToken(settleCurrency));
      const link = await createPaymentLink({
        amount_mode: amountMode,
        amount: amountMode !== "open" ? toMinorUnits(amount, decimals) : undefined,
        min_amount: amountMode !== "fixed" && minAmount ? toMinorUnits(minAmount, decimals) : undefined,
        max_amount: amountMode !== "fixed" && maxAmount ? toMinorUnits(maxAmount, decimals) : undefined,
        settle_currency: settleCurrency,
        accept_currencies: acceptCurrencies.length ? acceptCurrencies : undefined,
        description: description || undefined,
        merchant_reference: merchantReference || undefined,
        reuse_policy: reusePolicy,
        expires_in: expiresIn === "none" ? undefined : Number(expiresIn),
      });
      setResult(link);
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Failed to create payment request");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="max-w-md mx-auto">
        <h1 className="font-display text-3xl font-bold mb-6">Payment link created</h1>
        <div className="border border-border p-6 flex flex-col items-center gap-4">
          <div style={{ background: "var(--bg)", padding: 12, border: "1px solid var(--border)" }}>
            <QRCodeSVG value={result.hosted_url} size={200} bgColor="#050505" fgColor="#B2F55A" level="H" />
          </div>
          <p className="text-sm text-ink-dim">{result.merchant_reference || result.id}</p>
          <p className="text-xs text-ink-dim">
            {result.reuse_policy === "multi_use" ? "Reusable" : "Single use"} · {result.amount_mode.replace(/_/g, " ")}
          </p>
          <div className="w-full flex gap-2">
            <input
              readOnly
              className="flex-1 bg-surface border border-border px-3 py-2 text-xs font-mono"
              value={result.hosted_url}
              onFocus={(e) => e.target.select()}
            />
            <button
              className={`border px-3 py-2 text-xs ${copied ? "border-signal text-signal" : "border-border"}`}
              onClick={() => copy(result.hosted_url)}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            className="text-signal text-sm hover:underline"
            onClick={() => {
              setResult(null);
              setAmount("");
              setMerchantReference("");
              setDescription("");
            }}
          >
            Create another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <PageHeader
        title="Request payment"
        description="Create a link or QR to send someone. They can pay in any routable stablecoin; you're paid in yours."
      />
      <form onSubmit={handleSubmit} className="space-y-4 border border-border bg-surface p-6">
        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-2">Amount mode</label>
          <div className="flex gap-2">
            {([
              ["fixed", "Fixed"],
              ["open", "Open (payer decides)"],
              ["open_with_suggested", "Suggested"],
            ] as [AmountMode, string][]).map(([mode, label]) => (
              <button
                type="button"
                key={mode}
                onClick={() => setAmountMode(mode)}
                className={`flex-1 text-xs px-2 py-2 border ${
                  amountMode === mode ? "border-signal text-signal" : "border-border text-ink-dim"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">
            {amountMode === "fixed" ? "Amount" : amountMode === "open_with_suggested" ? "Suggested amount" : "Currency"}
          </label>
          <div className="flex gap-2">
            {amountMode !== "open" && (
              <input
                className="flex-1 bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            )}
            <SettleCurrencySelect
              value={settleCurrency}
              onChange={setSettleCurrency}
              className={amountMode === "open" ? "flex-1" : "w-32"}
            />
          </div>
        </div>

        {amountMode !== "fixed" && (
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Min (optional)</label>
              <input
                className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
                placeholder="0.00"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Max (optional)</label>
              <input
                className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
                placeholder="0.00"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Where this link settles is not a choice made per link.
            It was: an editable address, defaulting to the account's, with "use
            a different address" beside it. That is one text box per payment
            request pointing at wherever somebody pasted -- and a link outlives
            the moment it was made, printed and pasted and paid weeks later.
            It settles to this business's own address, full stop. */}
        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Settles to</label>
          <p className="bg-bg border border-border px-3 py-2 text-sm font-mono text-ink-dim truncate" title={accountAddress}>
            {accountAddress ? shortenAddress(accountAddress) : "—"}
            <span className="ml-2 text-xs">your business wallet</span>
          </p>
        </div>

        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Description (shown to payer)</label>
          <input
            className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
            placeholder="What is this payment for?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Your reference (optional)</label>
          <input
            className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
            placeholder="INV-2026-0412"
            value={merchantReference}
            onChange={(e) => setMerchantReference(e.target.value)}
          />
        </div>

        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-2">Reuse</label>
          <div className="flex gap-2">
            {([
              ["single_use", "Single use (invoice)"],
              ["multi_use", "Reusable (café QR)"],
            ] as [ReusePolicy, string][]).map(([policy, label]) => (
              <button
                type="button"
                key={policy}
                onClick={() => setReusePolicy(policy)}
                className={`flex-1 text-xs px-2 py-2 border ${
                  reusePolicy === policy ? "border-signal text-signal" : "border-border text-ink-dim"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Expires in</label>
          <select
            className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
            value={expiresIn}
            onChange={(e) => setExpiresIn(e.target.value)}
          >
            <option value="900">15 minutes</option>
            <option value="3600">1 hour</option>
            <option value="86400">24 hours</option>
            <option value="604800">7 days</option>
            <option value="none">No expiry</option>
          </select>
        </div>

        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-2">Accepted currencies (default: all routable)</label>
          <div className="flex flex-wrap gap-2">
            {CURRENCIES.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => toggleAccept(c)}
                className={`flex items-center gap-1.5 text-xs px-2 py-1 border ${
                  acceptCurrencies.includes(c)
                    ? "border-signal text-signal"
                    : "border-border text-ink-dim"
                }`}
              >
                <TokenIcon currency={isoToToken(c) as Currency} px={14} />
                {isoToToken(c)}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
        >
          {busy ? "Creating..." : "Create payment link"}
        </button>
      </form>
    </div>
  );
}
