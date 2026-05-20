"use client";

import type { PaymentReceipt } from "@conduit/sdk";
import { formatAmount, shortenAddress, formatDate } from "@/lib/format";
import { TokenBadge } from "./TokenBadge";
import type { Currency } from "@conduit/sdk";

function addressToCurrency(address: string): Currency {
  const lower = address.toLowerCase();
  if (lower === "0x3600000000000000000000000000000000000000") return "USDC";
  if (lower === "0x89b50855aa3be2f677cd6303cec089b5f319d72a") return "EURC";
  return "USDC";
}

interface ReceiptCardProps {
  receipt: PaymentReceipt;
  onClose?: () => void;
}

export function ReceiptCard({ receipt, onClose }: ReceiptCardProps) {
  const payerCurrency = addressToCurrency(receipt.payerToken);
  const recipientCurrency = addressToCurrency(receipt.recipientToken);
  const isCrossChain = payerCurrency !== recipientCurrency;

  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-brand-border">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-brand-green" />
            <span className="text-sm font-mono text-brand-green uppercase tracking-wider">
              Payment Settled
            </span>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="text-brand-muted hover:text-brand-white transition-colors text-xl"
            >
              ×
            </button>
          )}
        </div>

        <div className="text-center py-4">
          <p className="text-brand-muted text-sm mb-1">Amount sent</p>
          <p className="text-4xl font-anton text-brand-white">
            {formatAmount(receipt.payerAmount, payerCurrency)}
          </p>
          {isCrossChain && (
            <p className="text-brand-muted text-sm mt-2">
              Recipient received {formatAmount(receipt.recipientAmount, recipientCurrency)} ·{" "}
              <span className="text-brand-green">Rate secured</span>
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
          className="block w-full py-3 text-center text-sm font-mono
                     border border-brand-border rounded-xl text-brand-muted
                     hover:text-brand-white hover:border-brand-white/20 transition-colors"
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
      <span className="text-sm text-brand-muted">{label}</span>
      {typeof value === "string" ? (
        <span className={`text-sm text-brand-white ${mono ? "font-mono" : ""}`}>
          {value}
        </span>
      ) : (
        value
      )}
    </div>
  );
}
