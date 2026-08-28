"use client";

import { useRef } from "react";
import { toPng } from "html-to-image";
import type { Currency } from "@conduit/sdk/lite";
import { formatAmount, formatAmountHero } from "@/lib/format";
import { TokenIcon } from "@/components/Shared/TokenBadge";
import { useCopy } from "@/lib/use-copy";

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
  const { copied, copy } = useCopy();

  const shortRecipient = `${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}`;
  const hasAmount = amount > 0n;
  const heroAmount = hasAmount ? formatAmountHero(amount, currency) : "";
  // ~250px of card width for the text once padding and the 34px mark are out,
  // and Anton's digits run about 0.58em. 48px ceiling, 20px floor so a very
  // long amount stays legible rather than vanishing.
  const heroSize = Math.max(
    20,
    Math.min(48, Math.floor(250 / (0.58 * `${heroAmount} ${currency}`.length))),
  );

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

  const copyUrl = () => copy(paymentUrl);

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
          {/* Token MARK, amount, then the symbol as a label.
              This was one string from formatAmount, which meant the currency
              appeared twice -- as a glyph welded to the first digit and again
              as a code. For CHFAU that rendered "CHF500.00 CHFAU", and the card
              is the first thing anyone sees of a payment request.
              The icon carries the currency visually (a real coin mark or the
              country's flag, never a letter pretending to be a logo), and the
              number and symbol sit beside it at equal weight -- so nothing
              collides no matter how many letters the token's name has. */}
          {hasAmount ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              <TokenIcon currency={currency} px={34} />
              {/* Amount and asset at ONE size, sized to fit.
                  The symbol used to be a 20px label beside a 48px number,
                  which read as a footnote floating next to the amount -- but
                  which asset is being asked for is not a footnote. Equal
                  sizing needs the pair to be able to shrink, so the size comes
                  from the line's own length; 48px stays the ceiling so a short
                  amount lands exactly as it did. */}
              <span
                style={{
                  fontFamily: "Anton, sans-serif",
                  fontWeight: 800,
                  fontSize: `${heroSize}px`,
                  color: "var(--ink)",
                  lineHeight: 1,
                }}
              >
                {heroAmount}
              </span>
              <span
                style={{
                  fontFamily: "Anton, sans-serif",
                  fontWeight: 800,
                  fontSize: `${heroSize}px`,
                  color: "var(--ink-dim)",
                  lineHeight: 1,
                }}
              >
                {currency}
              </span>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
              }}
            >
              <TokenIcon currency={currency} px={28} />
              <span
                style={{
                  fontFamily: "Anton, sans-serif",
                  fontWeight: 800,
                  fontSize: "28px",
                  color: "var(--ink)",
                  lineHeight: 1.1,
                }}
              >
                Pay what you want
              </span>
            </div>
          )}
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
          className={`w-full py-3 border text-sm font-mono transition-colors ${
            copied
              ? "border-signal/40 text-signal"
              : "border-border text-ink-dim hover:text-ink hover:border-ink-dim/20"
          }`}
        >
          {copied ? "Copied!" : "Copy URL"}
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
