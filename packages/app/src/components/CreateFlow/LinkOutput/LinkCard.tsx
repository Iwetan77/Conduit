"use client";

import { useRef } from "react";
import { toPng } from "html-to-image";
import type { Currency } from "@conduit/sdk";
import { ConduitMark } from "@/components/Shared/Logo";
import { formatAmount } from "@/lib/format";

interface LinkCardProps {
  declarationId: string;
  paymentUrl: string;
  amount: bigint;
  currency: Currency;
  recipientAddress: string;
  label?: string;
}

export function LinkCard({
  declarationId,
  paymentUrl,
  amount,
  currency,
  recipientAddress,
  label,
}: LinkCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const shortRecipient = `${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}`;
  const displayAmount = amount > 0n
    ? formatAmount(amount, currency)
    : `Pay what you want · ${currency}`;

  const downloadPng = async () => {
    if (!cardRef.current) return;
    try {
      const dataUrl = await toPng(cardRef.current, {
        width: 1200,
        height: 630,
        pixelRatio: 2,
      });
      const link = document.createElement("a");
      link.download = `conduit-link-${declarationId.slice(0, 8)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error("Failed to download card:", err);
    }
  };

  const shareToX = () => {
    const text = encodeURIComponent(
      `Pay me ${amount > 0n ? formatAmount(amount, currency) : `in ${currency}`} via Conduit ⚡`
    );
    const url = encodeURIComponent(paymentUrl);
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(paymentUrl);
  };

  return (
    <div className="space-y-4">
      {/* The visual card — what gets downloaded */}
      <div
        ref={cardRef}
        style={{
          background: "#000000",
          border: "1px solid #1F1F1F",
          borderRadius: "16px",
          padding: "32px",
          fontFamily: "Barlow, sans-serif",
          minHeight: "200px",
          width: "100%",
          aspectRatio: "1200/630",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        {/* Top row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <ConduitMark size={32} />
            <span style={{ fontFamily: "Barlow Condensed, sans-serif", fontWeight: 900, fontSize: "22px" }}>
              <span style={{ color: "#B2F55A" }}>CON</span>
              <span style={{ color: "#FFFFFF" }}>DUIT</span>
            </span>
          </div>
          <span
            style={{
              fontSize: "10px",
              fontFamily: "IBM Plex Mono, monospace",
              color: "#666666",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Arc Testnet
          </span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Amount */}
        <div style={{ textAlign: "center" }}>
          {label && (
            <p style={{ color: "#666666", fontSize: "13px", marginBottom: "8px" }}>
              {label}
            </p>
          )}
          <p
            style={{
              fontFamily: "Barlow Condensed, sans-serif",
              fontWeight: 800,
              fontSize: "52px",
              color: "#FFFFFF",
              lineHeight: 1,
            }}
          >
            {displayAmount}
          </p>
          <p style={{ color: "#666666", fontSize: "14px", marginTop: "8px" }}>
            Pay in any currency
          </p>
        </div>

        <div style={{ flex: 1 }} />

        {/* Footer */}
        <div
          style={{
            borderTop: "1px solid #1F1F1F",
            paddingTop: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontFamily: "IBM Plex Mono, monospace",
                color: "#666666",
                fontSize: "12px",
              }}
            >
              {shortRecipient}
            </span>
          </div>
          <span
            style={{
              fontFamily: "IBM Plex Mono, monospace",
              color: "#B2F55A",
              fontSize: "11px",
            }}
          >
            {paymentUrl}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={copyUrl}
          className="flex-1 py-3 rounded-xl border border-brand-border
                     text-sm font-mono text-brand-muted hover:text-brand-white
                     hover:border-brand-white/20 transition-colors"
        >
          Copy URL
        </button>
        <button
          onClick={shareToX}
          className="flex-1 py-3 rounded-xl border border-brand-border
                     text-sm font-mono text-brand-muted hover:text-brand-white
                     hover:border-brand-green/30 transition-colors"
        >
          Share to X
        </button>
        <button
          onClick={downloadPng}
          className="flex-1 py-3 rounded-xl bg-brand-green/10 border border-brand-green/30
                     text-sm font-mono text-brand-green hover:bg-brand-green/20 transition-colors"
        >
          Download PNG
        </button>
      </div>
    </div>
  );
}
