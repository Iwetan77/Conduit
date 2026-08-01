"use client";

import type { Currency } from "@conduit/sdk/lite";
import { TokenBadge } from "@/components/Shared/TokenBadge";

interface RoutePreviewProps {
  payerCurrency: Currency;
  recipientCurrency: Currency;
  recipientAmount: string;
  payerAmount?: string;
  isLoading?: boolean;
}

export function RoutePreview({
  payerCurrency,
  recipientCurrency,
  recipientAmount,
  payerAmount,
  isLoading,
}: RoutePreviewProps) {
  const isSameCurrency = payerCurrency === recipientCurrency;

  return (
    <div className="bg-surface border border-border p-4 space-y-3">
      <p className="text-xs font-mono text-ink-dim uppercase tracking-wider">
        Route Preview
      </p>

      <div className="flex items-center gap-3">
        <div className="flex-1 flex flex-col gap-1">
          <p className="text-xs text-ink-dim">You send</p>
          <div className="flex items-center gap-2">
            <TokenBadge currency={payerCurrency} />
            <span className="font-mono text-ink">
              {isLoading ? (
                <span className="inline-block w-16 h-4 bg-border animate-pulse" />
              ) : (
                payerAmount ?? recipientAmount
              )}
            </span>
          </div>
        </div>

        <div className="text-signal text-xl">→</div>

        <div className="flex-1 flex flex-col gap-1 items-end">
          <p className="text-xs text-ink-dim">They receive</p>
          <div className="flex items-center gap-2">
            <TokenBadge currency={recipientCurrency} />
            <span className="font-mono text-ink">{recipientAmount}</span>
          </div>
        </div>
      </div>

      {!isSameCurrency && (
        <div className="pt-2 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-ink-dim">
            <span className="w-1.5 h-1.5 bg-signal" />
            Routed via Circle StableFX · Rate locked for 30s
          </div>
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
