"use client";

import type { PaymentReceipt } from "@conduit/sdk/lite";
import { addressToCurrency } from "@conduit/sdk/lite";
import { formatAmount, shortenAddress, formatDate } from "@/lib/format";
import { TokenBadge } from "./TokenBadge";

interface HistoryTableProps {
  receipts: PaymentReceipt[];
  walletAddress?: string;
  isLoading?: boolean;
}

export function HistoryTable({ receipts, walletAddress, isLoading }: HistoryTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="h-16 bg-surface animate-pulse border border-border"
          />
        ))}
      </div>
    );
  }

  if (receipts.length === 0) {
    return (
      <div className="text-center py-16 text-ink-dim">
        <p className="font-mono text-scale-2">No transactions yet.</p>
        <p className="text-scale-2 mt-1">Your settled payments will appear here.</p>
      </div>
    );
  }

  return (
    <div className="border border-border">
      <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-2 border-b border-border">
        <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">Counterparty</span>
        <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">Date</span>
        <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider text-right">Amount</span>
        <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider text-right">Tx</span>
      </div>
      <div className="divide-y divide-border overflow-x-auto">
        {receipts.map((receipt) => {
          const isSender =
            walletAddress &&
            receipt.payer.toLowerCase() === walletAddress.toLowerCase();
          const currency = addressToCurrency(
            isSender ? receipt.payerToken : receipt.recipientToken
          );
          const amount = isSender ? receipt.payerAmount : receipt.recipientAmount;
          const txShort = `${receipt.txHash.slice(0, 6)}…${receipt.txHash.slice(-4)}`;

          return (
            <a
              key={receipt.receiptId}
              href={receipt.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-4 py-3
                         hover:bg-surface transition-colors group min-w-[560px] sm:min-w-0"
            >
              <div className="flex items-center gap-3">
                <span className={`font-mono text-scale-2 ${isSender ? "text-ink-dim" : "text-signal"}`}>
                  {isSender ? "↑" : "↓"}
                </span>
                <div className="flex flex-col">
                  <span className="text-scale-2 font-mono text-ink">
                    {isSender
                      ? `To ${shortenAddress(receipt.recipient)}`
                      : `From ${shortenAddress(receipt.payer)}`}
                  </span>
                  <TokenBadge currency={currency} size="sm" />
                </div>
              </div>

              <span className="text-scale-1 font-mono text-ink-dim whitespace-nowrap">
                {formatDate(receipt.settledAt)}
              </span>

              <span
                className={`text-scale-2 font-mono font-medium text-right whitespace-nowrap ${
                  isSender ? "text-ink" : "text-signal"
                }`}
              >
                {isSender ? "-" : "+"}
                {formatAmount(amount, currency)}
              </span>

              <span className="text-scale-1 font-mono text-ink-dim group-hover:text-ink transition-colors whitespace-nowrap">
                {txShort}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
