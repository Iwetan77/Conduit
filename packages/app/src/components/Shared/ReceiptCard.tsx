"use client";

import type { PaymentReceipt, Address } from "@conduit/sdk";
import { addressToCurrency } from "@conduit/sdk";
import { formatAmount, shortenAddress, formatDate } from "@/lib/format";
import { TokenBadge } from "./TokenBadge";

interface ReceiptCardProps {
  receipt: PaymentReceipt;
  onClose?: () => void;
}

export function ReceiptCard({ receipt, onClose }: ReceiptCardProps) {
  const payerCurrency = addressToCurrency(receipt.payerToken);
  const recipientCurrency = addressToCurrency(receipt.recipientToken);
  const isCrossChain = payerCurrency !== recipientCurrency;

  return (
    <div className="bg-surface border border-border">
      {/* Header */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 bg-signal" />
            <span className="text-scale-2 font-mono text-signal uppercase tracking-wider">
              Payment Settled
            </span>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="text-ink-dim hover:text-ink transition-colors text-xl"
            >
              ×
            </button>
          )}
        </div>

        <div className="text-center py-4">
          <p className="text-ink-dim text-scale-2 mb-1">Amount sent</p>
          <p className="text-scale-6 font-anton text-ink">
            {formatAmount(receipt.payerAmount, payerCurrency)}
          </p>
          {isCrossChain && (
            <p className="text-ink-dim text-scale-2 mt-2">
              Recipient received {formatAmount(receipt.recipientAmount, recipientCurrency)} ·{" "}
              <span className="text-signal">Rate secured</span>
            </p>
          )}
        </div>
      </div>

      {/* Details */}
      <div className="p-6 space-y-3">
        <DetailRow label="From" value={shortenAddress(receipt.payer)} mono />
        <DetailRow label="To" value={shortenAddress(receipt.recipient)} mono />
        <DetailRow
          label="Token"
          value={<TokenBadge currency={recipientCurrency} size="sm" />}
        />
        <DetailRow label="Settled" value={formatDate(receipt.settledAt)} />
        <DetailRow
          label="Receipt"
          value={`${receipt.receiptId.slice(0, 10)}...`}
          mono
        />
      </div>

      {/* Explorer link */}
      <div className="px-6 pb-6">
        <a
          href={receipt.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full py-3 text-center text-scale-2 font-mono
                     border border-border text-ink-dim
                     hover:text-ink hover:border-ink-dim transition-colors"
        >
          View on ArcScan →
        </a>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-scale-2 text-ink-dim">{label}</span>
      {typeof value === "string" ? (
        <span className={`text-scale-2 text-ink ${mono ? "font-mono" : ""}`}>
          {value}
        </span>
      ) : (
        value
      )}
    </div>
  );
}
