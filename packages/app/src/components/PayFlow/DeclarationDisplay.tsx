"use client";

import type { PaymentDeclaration } from "@conduit/sdk";
import type { Currency } from "@conduit/sdk";
import { formatAmount, shortenAddress } from "@/lib/format";
import { TokenBadge } from "@/components/Shared/TokenBadge";

interface DeclarationDisplayProps {
  declaration: PaymentDeclaration;
}

export function DeclarationDisplay({ declaration }: DeclarationDisplayProps) {
  const isOpenAmount = declaration.amount === 0n;

  return (
    <div className="text-center space-y-4">
      {/* Amount */}
      <div>
        <p className="text-brand-muted text-sm mb-2">
          {isOpenAmount ? "Open payment request" : "Payment request"}
        </p>
        {isOpenAmount ? (
          <p className="text-4xl font-anton text-brand-white">
            Pay what you want
          </p>
        ) : (
          <p className="text-5xl font-anton text-brand-white">
            {formatAmount(declaration.amount, declaration.currency)}
          </p>
        )}
        <div className="flex justify-center mt-3">
          <TokenBadge currency={declaration.currency} size="lg" />
        </div>
      </div>

      {/* Recipient */}
      <div className="bg-brand-surface border border-brand-border rounded-xl px-4 py-3">
        <p className="text-xs text-brand-muted mb-1 font-mono uppercase tracking-wider">
          Recipient
        </p>
        <p className="font-mono text-brand-white text-sm">
          {shortenAddress(declaration.recipient, 6)}
        </p>
      </div>
    </div>
  );
}
