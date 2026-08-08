"use client";

import type { Currency } from "@conduit/sdk/lite";
import { currencyDecimals } from "@conduit/sdk/lite";
import { TokenBadge } from "@/components/Shared/TokenBadge";
import { useFxRate } from "@/lib/use-fx-rate";
import { formatAmountRaw } from "@/lib/format";

interface RoutePreviewProps {
  payerCurrency: Currency;
  recipientCurrency: Currency;
  recipientAmount: string;
  payerAmount?: string;
  isLoading?: boolean;
  /**
   * The recipient amount in minor units. When given, this component fetches a
   * live indicative rate and shows what the payer will actually send — instead
   * of the "≈ market rate" placeholder that left the real number invisible
   * until the wallet prompt. Optional so callers without a raw amount (e.g. an
   * open-amount link before anything is typed) keep the old behaviour.
   */
  recipientAmountRaw?: bigint;
}

export function RoutePreview({
  payerCurrency,
  recipientCurrency,
  recipientAmount,
  payerAmount,
  isLoading,
  recipientAmountRaw,
}: RoutePreviewProps) {
  const isSameCurrency = payerCurrency === recipientCurrency;

  // Only ask when it would tell the payer something they don't already know:
  // same-currency is 1:1, and an explicit payerAmount means a firm quote has
  // already replaced the estimate.
  const quotable = !isSameCurrency && !payerAmount && recipientAmountRaw !== undefined;
  const { data: fx, error: fxError, isLoading: fxLoading } = useFxRate(
    quotable ? payerCurrency : undefined,
    quotable ? recipientCurrency : undefined,
    quotable ? recipientAmountRaw!.toString() : undefined
  );
  const estimated = fx
    ? formatAmountRaw(BigInt(fx.pay_amount), currencyDecimals(payerCurrency))
    : null;

  return (
    <div className="bg-surface border border-border p-4 space-y-3">
      <p className="text-xs font-mono text-ink-dim uppercase tracking-wider">
        Route Preview
      </p>

      {/* Stacked on phones, side-by-side from sm up. Two columns of
          badge + amount don't fit a 390px viewport: the placeholder text
          wrapped to three lines and the recipient amount was pushed off the
          right edge. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <p className="text-xs text-ink-dim">You send</p>
          <div className="flex items-center gap-2 min-w-0">
            <TokenBadge currency={payerCurrency} />
            <span className="font-mono text-ink truncate">
              {isLoading || fxLoading ? (
                <span className="inline-block w-16 h-4 bg-border animate-pulse" />
              ) : payerAmount ? (
                payerAmount
              ) : isSameCurrency ? (
                recipientAmount
              ) : estimated ? (
                // The real number, before anything is signed. Still an estimate
                // — the firm rate comes from the quote at payment time — so it
                // is marked as one rather than shown as a promise.
                <span className="whitespace-nowrap">≈ {estimated}</span>
              ) : fxError ? (
                <span className="text-danger text-xs whitespace-nowrap">unavailable</span>
              ) : (
                <span className="text-ink-dim text-xs whitespace-nowrap">≈ market rate</span>
              )}
            </span>
          </div>
        </div>

        {/* The arrow points down when the sides are stacked. */}
        <div className="text-signal text-xl leading-none self-center sm:self-auto">
          <span className="sm:hidden">↓</span>
          <span className="hidden sm:inline">→</span>
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-1 sm:items-end">
          <p className="text-xs text-ink-dim">They receive</p>
          <div className="flex items-center gap-2 min-w-0">
            <TokenBadge currency={recipientCurrency} />
            <span className="font-mono text-ink truncate">{recipientAmount}</span>
          </div>
        </div>
      </div>

      {!isSameCurrency && (
        <div className="pt-2 border-t border-border space-y-1">
          {/* Why this pair can't be paid, in the payer's words, at the moment
              they're choosing — not as a failure after they've committed. */}
          {fxError ? (
            <div className="flex items-start gap-2 text-xs text-danger">
              <span className="w-1.5 h-1.5 bg-danger shrink-0 mt-1.5" />
              <span>{fxError.message}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-ink-dim">
              <span className="w-1.5 h-1.5 bg-signal shrink-0" />
              <span>
                They receive exactly{" "}
                <span className="text-ink">{recipientAmount}</span>
                {fx ? (
                  <>
                    {" "}
                    at ≈{" "}
                    <span className="text-ink">
                      {fx.rate} {recipientCurrency}/{payerCurrency}
                    </span>
                    . Final rate is confirmed in your wallet before you sign.
                  </>
                ) : (
                  <> — you pay the live rate, shown for approval before you sign.</>
                )}
              </span>
            </div>
          )}
          <p className="text-[11px] text-ink-dim/70 pl-3.5">
            Routed via Circle StableFX
          </p>
        </div>
      )}

      {isSameCurrency && (
        <div className="pt-2 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-ink-dim">
            <span className="w-1.5 h-1.5 bg-signal" />
            Direct transfer · No FX conversion
          </div>
        </div>
      )}
    </div>
  );
}
