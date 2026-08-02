"use client";

import type { Currency } from "@conduit/sdk/lite";
import { shortenAddress } from "@/lib/format";
import { TokenBadge } from "./TokenBadge";

// The cross-currency twin of ReceiptCard.
//
// A StableFX settlement has no on-chain PaymentReceipt to render — Circle's
// maker delivers via Permit2, so there's no ConduitRouter receiptId and no
// PaymentSettled log to parse. That's why this couldn't just reuse
// ReceiptCard. But a payer shouldn't be able to tell which rail carried their
// money from how the confirmation looks, so the anatomy here is deliberately
// identical: same header, same centred amount, same detail rows, same
// full-width explorer link.
interface FxReceiptCardProps {
  payAmount: string;
  payCurrency: Currency;
  receiveAmount: string;
  receiveCurrency: Currency;
  recipient: string;
  rate: string;
  txHash?: string;
  onClose?: () => void;
}

export function FxReceiptCard({
  payAmount,
  payCurrency,
  receiveAmount,
  receiveCurrency,
  recipient,
  rate,
  txHash,
  onClose,
}: FxReceiptCardProps) {
  return (
    <div className="bg-surface border border-border">
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
          <p className="text-scale-6 font-anton text-ink break-all">
            {payAmount} {payCurrency}
          </p>
          <p className="text-ink-dim text-scale-2 mt-2">
            Recipient received {receiveAmount} {receiveCurrency} ·{" "}
            <span className="text-signal">Rate {rate}</span>
          </p>
        </div>
      </div>

      <div className="p-6 space-y-3">
        <DetailRow label="To" value={shortenAddress(recipient)} mono />
        <DetailRow label="Token" value={<TokenBadge currency={receiveCurrency} size="sm" />} />
        <DetailRow label="Route" value="Circle StableFX" />
        <DetailRow label="Rate" value={rate} mono />
      </div>

      {/* Only rendered with a hash: Circle's maker submits the settling
          transaction, and a link that might 404 is worse than no link. */}
      {txHash && (
        <div className="px-6 pb-6">
          <a
            href={`https://testnet.arcscan.app/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-3 text-center text-scale-2 font-mono
                       border border-border text-ink-dim
                       hover:text-ink hover:border-ink-dim transition-colors"
          >
            View on ArcScan →
          </a>
        </div>
      )}
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
    <div className="flex items-center justify-between py-1 gap-3">
      <span className="text-scale-2 text-ink-dim shrink-0">{label}</span>
      {typeof value === "string" ? (
        <span className={`text-scale-2 text-ink truncate ${mono ? "font-mono" : ""}`}>{value}</span>
      ) : (
        value
      )}
    </div>
  );
}
