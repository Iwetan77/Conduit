"use client";

import type { Currency } from "@conduit/sdk";

interface QuotePreviewProps {
  payerCurrency: Currency;
  recipientCurrency: Currency;
  recipientAmount: string;
  payerAmount?: string;
  isLoading?: boolean;
}

export function QuotePreview({
  payerCurrency,
  recipientCurrency,
  recipientAmount,
  payerAmount,
  isLoading,
}: QuotePreviewProps) {
  const isSame = payerCurrency === recipientCurrency;

  return (
    <div className="bg-brand-surface border border-brand-border rounded-xl p-4 space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-xs font-mono text-brand-muted uppercase tracking-wider">
          You&apos;ll use
        </span>
        {isLoading ? (
          <div className="h-5 w-24 bg-brand-border rounded animate-pulse" />
        ) : (
          <span className="font-mono text-brand-white font-medium">
            {isSame
              ? `${recipientAmount} ${payerCurrency}`
              : payerAmount
              ? `${payerAmount} ${payerCurrency}`
              : "Fetching rate..."}
          </span>
        )}
      </div>

      {!isSame && (
        <div className="flex items-center gap-2 text-xs text-brand-muted pt-1 border-t border-brand-border">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-green" />
          Converted via Circle StableFX · Rate valid 30s
        </div>
      )}
    </div>
  );
}
