"use client";

import { useRef } from "react";
import { toPng } from "html-to-image";
import type { Currency } from "@conduit/sdk/lite";
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
      const dataUrl = await toPng(cardRef.current, { pixelRatio: 2 });
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
    <div className="flex flex-col flex-1">
      {/* Visual card — grows to fill available column height */}
      <div
        ref={cardRef}
        style={{
          flex: 1,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "16px",
          padding: "28px",
          fontFamily: "var(--font-mono), monospace",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
        }}
      >
        {/* Top row: logo + network */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {/* 2000×2000 PNG — render at fixed px, negative margin crops to center text */}
          <div style={{ overflow: "hidden", height: "22px", width: "120px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/conduit-logo.png"
              alt="Conduit"
              style={{ width: "120px", height: "120px", marginTop: "-49px", display: "block" }}
            />
          </div>
          <span style={{
            fontSize: "10px",
            fontFamily: "var(--font-mono), monospace",
            color: "var(--ink-dim)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}>
            Arc Testnet
          </span>
        </div>

        {/* Amount */}
        <div style={{ textAlign: "center", padding: "8px 0" }}>
          {label && (
            <p style={{ color: "var(--ink-dim)", fontSize: "13px", marginBottom: "8px" }}>{label}</p>
          )}
          <p style={{
            fontFamily: "Anton, sans-serif",
            fontWeight: 800,
            fontSize: "48px",
            color: "var(--ink)",
            lineHeight: 1,
          }}>
            {displayAmount}
          </p>
          <p style={{ color: "var(--ink-dim)", fontSize: "13px", marginTop: "8px" }}>
            Pay in any currency
          </p>
        </div>

        {/* Footer */}
        <div style={{
          borderTop: "1px solid var(--border)",
          paddingTop: "14px",
          display: "flex",
          flexDirection: "column",
          gap: "5px",
          marginTop: "auto",
        }}>
          <span style={{
            fontFamily: "var(--font-mono), monospace",
            color: "var(--ink-dim)",
            fontSize: "11px",
          }}>
            {shortRecipient}
          </span>
          <span style={{
            fontFamily: "var(--font-mono), monospace",
            color: "var(--signal)",
            fontSize: "10px",
            wordBreak: "break-all",
          }}>
            {paymentUrl}
          </span>
        </div>
      </div>

      {/* Actions — stacked vertically, pinned below card */}
      <div className="flex flex-col gap-2 mt-3">
        <button
          onClick={copyUrl}
          className="w-full py-3 border border-border
                     text-sm font-mono text-ink-dim hover:text-ink
                     hover:border-ink-dim/20 transition-colors"
        >
          Copy URL
        </button>
        <button
          onClick={shareToX}
          className="w-full py-3 border border-border
                     text-sm font-mono text-ink-dim hover:text-ink
                     hover:border-signal/30 transition-colors"
        >
          Share to X
        </button>
        <button
          onClick={downloadPng}
          className="w-full py-3 bg-signal/10 border border-signal/30
                     text-sm font-mono text-signal hover:bg-signal/20 transition-colors"
        >
          Download PNG
        </button>
      </div>
    </div>
  );
}
