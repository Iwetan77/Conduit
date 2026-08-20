"use client";

// Payer surface for a payment link (pl_ ids) — Phase 3 built the lifecycle
// enforcement, Phase 5 wires the payer-facing consumption. Everything now
// lives on ONE screen: the link's identity/description, the amount (fixed and
// shown, or an input for open/suggested), the payer's own reference, the
// pay-with currency picker, the route preview, and the Pay button. The
// settlement_intent is minted at pay time (POST /:id/pay) inside the shared
// ArcSettlePanel, so there's no dead "Continue to pay" hop and no orphan
// intent created just from opening the link.
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { Currency } from "@conduit/sdk/lite";
import {
  getPublicPaymentLink,
  getPublicSettlementIntent,
  payPaymentLink,
  type PublicPaymentLink,
  type PublicSettlementIntent,
} from "@/lib/conduit-api";
import { formatAmountRaw, shortenAddress } from "@/lib/format";
import { isoToToken } from "@/lib/currencies";
import { currencyDecimals } from "@conduit/sdk/lite";
import { ArcSettlePanel } from "./ArcSettlePanel";
import { usePayerIdentity } from "@/lib/use-payer-identity";
import { usePayerUsdc, routeForAmount } from "@/lib/use-payer-usdc";
import { useBalances } from "@/lib/use-balances";
import { chainLabel } from "@/lib/unified-balance";
// Loaded when reached. The cross chain flow is a screen the payer only sees
// after choosing to fund from another chain, and it is one of the largest in
// the app -- shipping it on first paint made every payer pay for a path most
// of them never take. ssr:false: it is wallet driven and renders nothing
// useful on the server.
const CrossChainBridge = dynamic(
  () => import("./CrossChainBridge").then((m) => m.CrossChainBridge),
  { ssr: false },
);

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
  // Cross-chain funding, same as the settlement-intent surface offers. The
  // difference here is that a payment link has no settlement intent until pay
  // time, so this mints one (POST /:id/pay) and then hands it to
  // CrossChainBridge — which needs a real intent to bridge against.
  const [bridgeIntent, setBridgeIntent] = useState<PublicSettlementIntent | null>(null);
  // Cross-chain follows from where the payer's USDC is, not from a button.
  // Same rule as /send and the settlement-intent surface: a payer knows which
  // wallet they hold, not which rail should carry it.
  const { identity } = usePayerIdentity();
  const sourceUsdc = usePayerUsdc({
    address: identity?.address,
    family: identity?.kind,
    enabled: !!identity,
  });
  const arcBalances = useBalances(identity?.kind === "evm" ? identity.address : undefined);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState("");
  const bridgeIntentIdRef = useRef<string | null>(null);
  const bridgeMintedForRef = useRef<string>("");

  // Every piece of per-link state resets when linkId changes. Without this,
  // opening a second payment link showed the FIRST link's merchant name and
  // prefilled amount.
  useEffect(() => {
    let cancelled = false;
    setLink(null);
    setError("");
    setAmount("");
    setPayerReference("");
    setShowAddress(false);
    setBridgeIntent(null);
    setBridgeError("");
    bridgeIntentIdRef.current = null;

    getPublicPaymentLink(linkId)
      .then((l) => {
        if (cancelled) return;
        setLink(l);
        document.title = `Pay ${l.display_name} · Conduit`;
        if (l.amount_mode === "open_with_suggested" && l.amount) {
          setAmount(formatAmountRaw(BigInt(l.amount), currencyDecimals(isoToToken(l.settle_currency))));
        }
      })
      .catch(() => {
        if (!cancelled) setError("This payment link was not found or is no longer available.");
      });
    return () => { cancelled = true; };
  }, [linkId]);

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

  const decimals = currencyDecimals(isoToToken(link.settle_currency));
  const settleToken = isoToToken(link.settle_currency) as Currency;
  const isFixed = link.amount_mode === "fixed";

  // The amount the intent will settle: the link's own for fixed, the payer's
  // typed amount otherwise. Kept as minor units so nothing downstream ever
  // touches a float.
  const enteredMinor = amount ? toMinorUnits(amount, decimals) : "0";
  const amountRaw = isFixed && link.amount ? BigInt(link.amount) : BigInt(enteredMinor);

  // Which chain has to pay, if not Arc. Arc counts only for an EVM wallet: a
  // Solana wallet cannot sign on Arc, so an Arc balance is not spendable by it.
  const arcUsdc =
    identity?.kind === "evm" ? (arcBalances.balances.USDC ?? 0n) : 0n;
  const crossChain =
    amountRaw > 0n
      ? (() => {
          const r = routeForAmount(amountRaw, arcUsdc, sourceUsdc.funded);
          return r.kind === "cross_chain" ? r.chain : null;
        })()
      : null;

  // Open/suggested links must have a sane amount before the Pay button means
  // anything. Enforce the merchant's min/max here too, in minor units.
  const disabledReason = (() => {
    if (isFixed) return undefined;
    if (amountRaw <= 0n) return "Enter an amount";
    if (link.min_amount && amountRaw < BigInt(link.min_amount)) return "Amount is below the minimum";
    if (link.max_amount && amountRaw > BigInt(link.max_amount)) return "Amount is above the maximum";
    return undefined;
  })();

  const ensureIntentId = async (): Promise<string> => {
    const res = await payPaymentLink(linkId, {
      amount: isFixed ? undefined : enteredMinor,
      payer_reference: payerReference || undefined,
    });
    return res.id;
  };

  // Mint the intent, then hand it to CrossChainBridge. Validated on CLICK
  // rather than by disabling the button: for a payer whose USDC is on Solana
  // this is the ONLY path that works, so a greyed-out control with no
  // explanation is a dead end rather than a hint.
  const startCrossChain = async () => {
    if (disabledReason) {
      setBridgeError(disabledReason);
      return;
    }
    setBridgeBusy(true);
    setBridgeError("");
    try {
      // Cached so going back and returning doesn't mint a second intent — but
      // keyed to what's actually on screen, so editing the amount or reference
      // after minting can't bridge the stale one.
      const key = `${enteredMinor}|${payerReference}`;
      if (!bridgeIntentIdRef.current || bridgeMintedForRef.current !== key) {
        bridgeIntentIdRef.current = await ensureIntentId();
        bridgeMintedForRef.current = key;
      }
      setBridgeIntent(await getPublicSettlementIntent(bridgeIntentIdRef.current));
    } catch (err) {
      const { formatTxError } = await import("@/lib/tx-errors");
      setBridgeError(formatTxError(err));
    } finally {
      setBridgeBusy(false);
    }
  };

  return (
    <div className="space-y-6">
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

      {bridgeIntent ? (
        <>
          <CrossChainBridge intentId={bridgeIntent.id} intent={bridgeIntent} />
          <button
            type="button"
            onClick={() => setBridgeIntent(null)}
            className="text-ink-dim text-xs font-mono hover:text-ink"
          >
            ← Pay on Arc instead
          </button>
        </>
      ) : (
        <>
      {/* Amount, currency picker, route preview and Pay all on one screen.
          The amount box + reference are handed to ArcSettlePanel as children so
          they sit above the pay-with picker; the settlement intent is created
          only when the payer actually taps Pay. */}
      <ArcSettlePanel
        settleToken={settleToken}
        settleAddress={link.settle_address}
        amountRaw={amountRaw}
        displayName={link.display_name}
        ensureIntentId={ensureIntentId}
        disabledReason={disabledReason}
      >
        <div className="border border-border bg-surface p-4 space-y-1">
          <p className="text-ink-dim text-xs uppercase tracking-wider font-mono">
            {isFixed ? "Requesting" : "Amount"}
          </p>
          {isFixed && link.amount ? (
            <p className="text-ink font-mono text-2xl">
              {formatAmountRaw(BigInt(link.amount), decimals)} {settleToken}
            </p>
          ) : (
            <div className="flex items-baseline gap-2">
              <input
                inputMode="decimal"
                className="flex-1 min-w-0 bg-transparent text-ink font-mono text-2xl focus:outline-none"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="text-ink-dim font-mono shrink-0">{settleToken}</span>
            </div>
          )}
          {(link.min_amount || link.max_amount) && (
            <p className="text-ink-dim text-xs font-mono">
              {link.min_amount && `min ${formatAmountRaw(BigInt(link.min_amount), decimals)}`}
              {link.min_amount && link.max_amount && " · "}
              {link.max_amount && `max ${formatAmountRaw(BigInt(link.max_amount), decimals)}`}
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
      </ArcSettlePanel>

      {/* The one path that works for a payer holding USDC on Solana, Base or
          any other supported chain — previously reachable from a settlement
          intent but not from a merchant's payment link. */}
      {/* Entered automatically when the payer's Arc balance cannot cover this
          and another chain can. The button that used to sit here asked a
          question about rails; this states the answer instead. */}
      {crossChain && !bridgeIntent && (
        <button
          type="button"
          onClick={startCrossChain}
          disabled={bridgeBusy}
          className="w-full py-3.5 px-4 border border-signal/40 bg-signal/5
                     hover:bg-signal/10 transition-colors disabled:opacity-60
                     text-signal font-mono text-sm"
        >
          {bridgeBusy ? "Preparing…" : `Pay from ${chainLabel(crossChain)}`}
        </button>
      )}
      {bridgeError && <p className="text-danger text-sm">{bridgeError}</p>}
        </>
      )}
    </div>
  );
}
