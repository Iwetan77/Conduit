"use client";

import type { PaymentReceipt } from "@conduit/sdk";
import { formatAmount, shortenAddress, formatDate } from "@/lib/format";
import type { Currency } from "@conduit/sdk";
import { TokenBadge } from "./TokenBadge";

function addressToCurrency(address: string): Currency {
  return address.toLowerCase() === "0x3600000000000000000000000000000000000000"
    ? "USDC"
    : "EURC";
}

interface HistoryTableProps {
  receipts: PaymentReceipt[];
  walletAddress?: string;
  isLoading?: boolean;
}

export function HistoryTable({ receipts, walletAddress, isLoading }: HistoryTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="h-16 rounded-xl bg-brand-surface animate-pulse border border-brand-border"
          />
        ))}
      </div>
    );
  }

  if (receipts.length === 0) {
    return (
      <div className="text-center py-16 text-brand-muted">
        <p className="text-brand-muted font-mono text-sm">No transactions yet.</p>
        <p className="text-brand-muted text-sm mt-1">Your settled payments will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {receipts.map((receipt) => {
        const isSender =
          walletAddress &&
          receipt.payer.toLowerCase() === walletAddress.toLowerCase();
        const currency = addressToCurrency(
          isSender ? receipt.payerToken : receipt.recipientToken
        );
        const amount = isSender ? receipt.payerAmount : receipt.recipientAmount;

        return (
          <a
            key={receipt.receiptId}
            href={receipt.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between p-4 rounded-xl
                       bg-brand-surface border border-brand-border
                       hover:border-brand-green/30 transition-all group"
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm
                             ${isSender ? "bg-red-500/10 text-red-400" : "bg-brand-green/10 text-brand-green"}`}
              >
                {isSender ? "↑" : "↓"}
              </div>
              <div>
                <p className="text-sm font-anton text-brand-white">
                  {isSender
                    ? `To ${shortenAddress(receipt.recipient)}`
                    : `From ${shortenAddress(receipt.payer)}`}
                </p>
                <p className="text-xs text-brand-muted font-mono">
                  {formatDate(receipt.settledAt)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <TokenBadge currency={currency} size="sm" />
              <span
                className={`text-sm font-mono font-medium ${
                  isSender ? "text-red-400" : "text-brand-green"
                }`}
              >
                {isSender ? "-" : "+"}
                {formatAmount(amount, currency)}
              </span>
              <span className="text-brand-border group-hover:text-brand-muted transition-colors text-xs">
                →
              </span>
            </div>
          </a>
        );
      })}
    </div>
  );
}
