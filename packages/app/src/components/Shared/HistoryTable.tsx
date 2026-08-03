"use client";

import type { Currency, PaymentReceipt } from "@conduit/sdk/lite";
import { addressToCurrency } from "@conduit/sdk/lite";
import type { WalletSettlementRow } from "@/lib/conduit-api";
import { isoToToken } from "@/lib/currencies";
import { formatAmount, shortenAddress, formatDate } from "@/lib/format";
import { TokenBadge } from "./TokenBadge";

// A single row this table can render, regardless of where it came from.
// Two genuinely different sources feed this table:
//   - same-currency payments, read straight off ConduitRouter's on-chain
//     PaymentSettled event log (no server involved at all);
//   - cross-currency payments, which Circle's maker delivers via Permit2 and
//     never touch ConduitRouter, so they can only come from Conduit's own
//     database (see lib/conduit-api's getWalletSettlements).
// Both get normalized to this shape before reaching the table, so the table
// itself never needs to know which rail a payment took.
export interface HistoryRow {
  key: string;
  direction: "sent" | "received";
  counterpartyAddress: string;
  currency: Currency;
  amount: bigint;
  settledAt: number; // unix seconds
  txHash: string;
  explorerUrl: string;
}

export function onChainReceiptsToRows(receipts: PaymentReceipt[], walletAddress?: string): HistoryRow[] {
  return receipts.map((receipt) => {
    const isSender =
      !!walletAddress && receipt.payer.toLowerCase() === walletAddress.toLowerCase();
    return {
      key: receipt.receiptId,
      direction: isSender ? "sent" : "received",
      counterpartyAddress: isSender ? receipt.recipient : receipt.payer,
      currency: addressToCurrency(isSender ? receipt.payerToken : receipt.recipientToken),
      amount: isSender ? receipt.payerAmount : receipt.recipientAmount,
      settledAt: receipt.settledAt,
      txHash: receipt.txHash,
      explorerUrl: receipt.explorerUrl,
    };
  });
}

// Cross-currency settlements are always the connected wallet PAYING (Circle's
// maker delivers to the recipient; a payer's own wallet never receives a
// StableFX settlement from this endpoint), so direction is always "sent" and
// the amount is what THEY paid, in their own currency — not what the
// recipient received.
export function walletSettlementsToRows(rows: WalletSettlementRow[]): HistoryRow[] {
  return rows.map((r) => ({
    key: r.id,
    direction: "sent" as const,
    counterpartyAddress: r.settle_address,
    currency: isoToToken(r.pay_currency) as Currency,
    amount: BigInt(r.pay_amount),
    settledAt: Number(r.settled_at),
    txHash: r.tx_hash,
    explorerUrl: r.tx_hash ? `https://testnet.arcscan.app/tx/${r.tx_hash}` : "",
  }));
}

interface HistoryTableProps {
  rows: HistoryRow[];
  isLoading?: boolean;
}

export function HistoryTable({ rows, isLoading }: HistoryTableProps) {
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

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-ink-dim">
        <p className="font-mono text-scale-2">No transactions yet.</p>
        <p className="text-scale-2 mt-1">Your settled payments will appear here.</p>
      </div>
    );
  }

  // Newest first regardless of which rail each row came from.
  const sorted = [...rows].sort((a, b) => b.settledAt - a.settledAt);

  return (
    <div className="border border-border">
      <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-2 border-b border-border">
        <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">Counterparty</span>
        <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">Date</span>
        <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider text-right">Amount</span>
        <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider text-right">Tx</span>
      </div>
      <div className="divide-y divide-border overflow-x-auto">
        {sorted.map((row) => {
          const isSender = row.direction === "sent";
          const txShort = row.txHash
            ? `${row.txHash.slice(0, 6)}…${row.txHash.slice(-4)}`
            : "—";

          const content = (
            <>
              <div className="flex items-center gap-3">
                <span className={`font-mono text-scale-2 ${isSender ? "text-ink-dim" : "text-signal"}`}>
                  {isSender ? "↑" : "↓"}
                </span>
                <div className="flex flex-col">
                  <span className="text-scale-2 font-mono text-ink">
                    {isSender
                      ? `To ${shortenAddress(row.counterpartyAddress)}`
                      : `From ${shortenAddress(row.counterpartyAddress)}`}
                  </span>
                  <TokenBadge currency={row.currency} size="sm" />
                </div>
              </div>

              <span className="text-scale-1 font-mono text-ink-dim whitespace-nowrap">
                {formatDate(row.settledAt)}
              </span>

              <span
                className={`text-scale-2 font-mono font-medium text-right whitespace-nowrap ${
                  isSender ? "text-ink" : "text-signal"
                }`}
              >
                {isSender ? "-" : "+"}
                {formatAmount(row.amount, row.currency)}
              </span>

              <span className="text-scale-1 font-mono text-ink-dim group-hover:text-ink transition-colors whitespace-nowrap">
                {txShort}
              </span>
            </>
          );

          const rowClass =
            "grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-4 py-3 " +
            "hover:bg-surface transition-colors group min-w-[560px] sm:min-w-0";

          return row.explorerUrl ? (
            <a key={row.key} href={row.explorerUrl} target="_blank" rel="noopener noreferrer" className={rowClass}>
              {content}
            </a>
          ) : (
            <div key={row.key} className={rowClass}>
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
