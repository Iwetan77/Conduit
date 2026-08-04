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

// Off-chain settlements (cross-currency via StableFX, and cross-chain via the
// Gateway bridge) leave no ConduitRouter event, so this endpoint is the only
// place either side can see them. The server now reports direction: a wallet
// can be the PAYER (funded the trade) or the RECIPIENT (the payout address) --
// a merchant paid this way previously saw nothing at all. Amounts follow the
// direction: what you paid in your currency, or what you received in theirs.
export function walletSettlementsToRows(rows: WalletSettlementRow[]): HistoryRow[] {
  return rows.map((r) => {
    const received = r.direction === "received";
    return {
    key: r.id,
    direction: received ? ("received" as const) : ("sent" as const),
    counterpartyAddress: r.settle_address,
    currency: isoToToken(received ? r.settle_currency : r.pay_currency) as Currency,
    amount: BigInt(received ? r.settle_amount : r.pay_amount),
    settledAt: Number(r.settled_at),
    txHash: r.tx_hash,
    explorerUrl: r.tx_hash ? `https://testnet.arcscan.app/tx/${r.tx_hash}` : "",
    };
  });
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
      <div className="divide-y divide-border">
        {sorted.map((row) => {
          const isSender = row.direction === "sent";
          const txShort = row.txHash
            ? `${row.txHash.slice(0, 6)}…${row.txHash.slice(-4)}`
            : "—";
          const amountText = `${isSender ? "-" : "+"}${formatAmount(row.amount, row.currency)}`;
          // Money leaving is red, money arriving is green -- the direction a
          // payer reads first. Outflow used to render in neutral ink, which
          // made an outgoing payment look identical to a balance line.
          const amountClass = `text-scale-2 font-mono font-medium whitespace-nowrap ${
            isSender ? "text-danger" : "text-signal"
          }`;

          // Two layouts, not one squeezed into a min-width that forced
          // horizontal scroll on mobile -- which pushed the amount and tx
          // columns off the edge of the screen entirely, unreadable without
          // scrolling sideways under each row. Below sm: two stacked lines,
          // full width, nothing clipped. From sm: the original 4-column grid.
          const content = (
            <>
              {/* Mobile: counterparty on top, date + amount below it. */}
              <div className="flex flex-col gap-1 sm:hidden min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`font-mono text-scale-2 shrink-0 ${isSender ? "text-danger" : "text-signal"}`}>
                    {isSender ? "↑" : "↓"}
                  </span>
                  <span className="text-scale-2 font-mono text-ink truncate">
                    {isSender
                      ? `To ${shortenAddress(row.counterpartyAddress)}`
                      : `From ${shortenAddress(row.counterpartyAddress)}`}
                  </span>
                  <TokenBadge currency={row.currency} size="sm" />
                </div>
                <div className="flex items-center justify-between gap-2 pl-6">
                  <span className="text-scale-1 font-mono text-ink-dim whitespace-nowrap">
                    {formatDate(row.settledAt)}
                  </span>
                  <span className={amountClass}>{amountText}</span>
                </div>
              </div>

              {/* Desktop: the original 4-column grid. */}
              <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center w-full">
                <div className="flex items-center gap-3">
                  <span className={`font-mono text-scale-2 ${isSender ? "text-danger" : "text-signal"}`}>
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

                <span className={`${amountClass} text-right`}>{amountText}</span>

                <span className="text-scale-1 font-mono text-ink-dim group-hover:text-ink transition-colors whitespace-nowrap">
                  {txShort}
                </span>
              </div>
            </>
          );

          const rowClass = "flex items-center px-4 py-3 hover:bg-surface transition-colors group";

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
