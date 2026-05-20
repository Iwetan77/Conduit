"use client";

import { useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toPng } from "html-to-image";
import jsPDF from "jspdf";
import type { Currency } from "@conduit/sdk";
import { formatAmount } from "@/lib/format";

interface QRDisplayProps {
  declarationId: string;
  paymentUrl: string;
  amount: bigint;
  currency: Currency;
  label?: string;
}

export function QRDisplay({
  declarationId,
  paymentUrl,
  amount,
  currency,
  label,
}: QRDisplayProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const displayAmount =
    amount > 0n
      ? formatAmount(amount, currency)
      : `Pay what you want · ${currency}`;

  const downloadPng = async () => {
    if (!cardRef.current) return;
    try {
      const dataUrl = await toPng(cardRef.current, {
        width: 1200,
        height: 1200,
        pixelRatio: 2,
      });
      const link = document.createElement("a");
      link.download = `conduit-qr-${declarationId.slice(0, 8)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error("Failed to generate PNG:", err);
    }
  };

  const downloadPdf = async () => {
    if (!cardRef.current) return;
    try {
      const dataUrl = await toPng(cardRef.current, { pixelRatio: 3 });
      const pdf = new jsPDF({ format: "a5", unit: "mm", orientation: "portrait" });
      pdf.addImage(dataUrl, "PNG", 0, 0, 148, 148);
      pdf.save(`conduit-qr-${declarationId.slice(0, 8)}.pdf`);
    } catch (err) {
      console.error("Failed to generate PDF:", err);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="flex flex-col flex-1">
      {/* QR Card — grows to fill column height, designed for physical printing */}
      <div
        ref={cardRef}
        className="bg-brand-black border border-brand-border rounded-2xl overflow-hidden"
        style={{ flex: 1 }}
      >
        <div
          style={{
            background: "#000000",
            padding: "32px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "20px",
            height: "100%",
            boxSizing: "border-box",
          }}
        >
          {/* 2000×2000 PNG — fixed px dimensions, negative margin crops to center text */}
          <div style={{ overflow: "hidden", height: "22px", width: "130px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/conduit-logo.png"
              alt="Conduit"
              style={{ width: "130px", height: "130px", marginTop: "-54px", display: "block" }}
            />
          </div>

          {/* QR Code */}
          <div
            style={{
              background: "#000000",
              padding: "12px",
              borderRadius: "12px",
              border: "2px solid #1F1F1F",
            }}
          >
            <QRCodeSVG
              value={paymentUrl}
              size={220}
              bgColor="#000000"
              fgColor="#B2F55A"
              level="H"
              includeMargin={false}
            />
          </div>

          {/* Amount */}
          <div style={{ textAlign: "center" }}>
            {label && (
              <p style={{ color: "#666666", fontSize: "13px", marginBottom: "6px", fontFamily: "Barlow, sans-serif" }}>
                {label}
              </p>
            )}
            <p style={{ fontFamily: "Anton, sans-serif", fontWeight: 800, fontSize: "32px", color: "#FFFFFF", lineHeight: 1 }}>
              {displayAmount}
            </p>
            <p style={{ color: "#666666", fontSize: "12px", marginTop: "6px", fontFamily: "Barlow, sans-serif" }}>
              Scan to pay · Any currency accepted
            </p>
          </div>

          {/* Footer */}
          <div style={{ borderTop: "1px solid #1F1F1F", paddingTop: "12px", width: "100%", textAlign: "center", marginTop: "auto" }}>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", color: "#666666", fontSize: "10px", letterSpacing: "0.05em" }}>
              — Powered by Conduit —
            </span>
          </div>
        </div>
      </div>

      {/* Actions — stacked vertically, pinned below card */}
      <div className="flex flex-col gap-2 mt-3">
        <button
          onClick={downloadPng}
          className="w-full py-3 rounded-xl border border-brand-border
                     text-sm font-mono text-brand-muted hover:text-brand-white
                     hover:border-brand-white/20 transition-colors"
        >
          Download PNG
        </button>
        <button
          onClick={downloadPdf}
          className="w-full py-3 rounded-xl bg-brand-green/10 border border-brand-green/30
                     text-sm font-mono text-brand-green hover:bg-brand-green/20 transition-colors"
        >
          Download PDF (A5)
        </button>
        <button
          onClick={handlePrint}
          className="w-full py-3 rounded-xl border border-brand-border
                     text-sm font-mono text-brand-muted hover:text-brand-white
                     hover:border-brand-white/20 transition-colors no-print"
        >
          Print
        </button>
      </div>

    </div>
  );
}
