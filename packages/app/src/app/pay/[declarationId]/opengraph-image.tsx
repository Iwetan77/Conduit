// Dynamic Open Graph image for /pay/[declarationId] — the "beautiful card"
// that renders when a payment link is shared on X, WhatsApp, Telegram, etc.
// Uses Next's file-convention OG route (next/og ImageResponse). Node runtime
// (not edge) per platform guidance; no custom font load keeps it dependency-
// free and build-safe.
import { ImageResponse } from "next/og";
import { toHumanAmount, currencyDecimals } from "@conduit/sdk/lite";
import { isoToToken } from "@/lib/currencies";

export const alt = "Conduit payment request";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const API_BASE = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "http://localhost:8080";
const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", BRL: "R$", AUD: "A$", MXN: "MX$", CAD: "C$", GBP: "£", ZAR: "R", KRW: "₩" };

async function fetchInfo(id: string) {
  const path = id.startsWith("pl_")
    ? `/v1/payment_links/${id}/public`
    : id.startsWith("si_")
      ? `/v1/settlement_intents/${id}/public`
      : null;
  if (!path) return null;
  try {
    const res = await fetch(`${API_BASE}${path}`, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    return (await res.json()) as { display_name?: string; amount?: string; settle_currency?: string };
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: { declarationId: string } }) {
  const info = await fetchInfo(params.declarationId);
  const merchant = info?.display_name?.trim() || "A Conduit merchant";

  let amountLine = "Pay with any stablecoin";
  if (info?.amount && info?.settle_currency) {
    try {
      const human = toHumanAmount(BigInt(info.amount), currencyDecimals(isoToToken(info.settle_currency)));
      const pretty = Number(human).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      amountLine = `${SYMBOLS[info.settle_currency] ?? ""}${pretty} ${info.settle_currency}`;
    } catch {
      /* fall back to the default line */
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#050505",
          padding: 80,
          fontFamily: "sans-serif",
        }}
      >
        {/* Brand mark */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              border: "3px solid #B2F55A",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#B2F55A",
              fontSize: 26,
              fontWeight: 700,
            }}
          >
            D
          </div>
          <div style={{ color: "#B2F55A", fontSize: 30, fontWeight: 700, letterSpacing: 2 }}>CONDUIT</div>
        </div>

        {/* Ask */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ color: "#8a8a8a", fontSize: 34 }}>Payment request from</div>
          <div style={{ color: "#f5f5f5", fontSize: 68, fontWeight: 800, lineHeight: 1.05 }}>{merchant}</div>
          <div style={{ color: "#B2F55A", fontSize: 88, fontWeight: 800, marginTop: 12 }}>{amountLine}</div>
        </div>

        {/* Footer */}
        <div style={{ color: "#6a6a6a", fontSize: 28 }}>
          Pay with any stablecoin · settles instantly on Arc
        </div>
      </div>
    ),
    { ...size },
  );
}
