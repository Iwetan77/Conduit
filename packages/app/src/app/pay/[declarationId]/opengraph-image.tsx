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

// The currency's own symbol, shown inside the coin mark beside the amount.
// Keyed by the ISO code the API sends, which is why EURAU appears here as
// itself: it is a token symbol standing in for an ISO code, because EUR is
// already EURC's (see lib/currencies.ts).
const SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", EURAU: "€", BRL: "R$", AUD: "A$", MXN: "MX$",
  CAD: "C$", GBP: "£", ZAR: "R", KRW: "₩", CHF: "Fr",
};

// The wordmark lockup, not a drawing of it.
//
// Two earlier attempts were wrong in instructive ways. The first drew a green
// circle with a letter in it, which is not the logo. The second used the ⊙D
// mark, whose bar and counter are BLACK -- fine on a light page, half invisible
// on this one. The wordmark is the variant built for dark backgrounds: CON in
// signal green, DUIT in white, the bar cutting through both.
//
// Cropped to its content (1628x480) and otherwise untouched. Nothing is
// recoloured: the white here is the DUIT letterforms, not a background.
//
// Loaded through import.meta.url rather than out of public/ so Next traces it
// into the serverless bundle. public/ is not guaranteed to be readable at
// render time, and a missing file would mean no logo at all on the one surface
// whose whole job is being seen by strangers.
async function wordmarkDataUri(): Promise<string | null> {
  try {
    const res = await fetch(new URL("./conduit-wordmark.png", import.meta.url));
    const buf = await res.arrayBuffer();
    return `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}

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
  const [info, wordmark] = await Promise.all([fetchInfo(params.declarationId), wordmarkDataUri()]);
  const merchant = info?.display_name?.trim() || "A Conduit merchant";

  // Amount and token are kept apart so the token can carry its own coin mark,
  // the way TokenBadge does everywhere else in the app. Rendering them as one
  // string is what left the asset as bare text on the card.
  let amount = "";
  let token = "";
  let glyph = "";
  if (info?.amount && info?.settle_currency) {
    try {
      token = isoToToken(info.settle_currency);
      const human = toHumanAmount(BigInt(info.amount), currencyDecimals(token));
      amount = Number(human).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      glyph = SYMBOLS[info.settle_currency] ?? "";
    } catch {
      amount = "";
      token = "";
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
        {/* Brand. The wordmark carries the name and the ™ itself, so there is
            no text beside it to drift out of sync with the artwork. */}
        <div style={{ display: "flex", alignItems: "center" }}>
          {wordmark ? (
            <img src={wordmark} width={244} height={72} alt="Conduit" />
          ) : (
            <div style={{ color: "#B2F55A", fontSize: 30, fontWeight: 700, letterSpacing: 2 }}>CONDUIT™</div>
          )}
        </div>

        {/* Ask */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ color: "#8a8a8a", fontSize: 34 }}>Payment request from</div>
          <div style={{ color: "#f5f5f5", fontSize: 68, fontWeight: 800, lineHeight: 1.05 }}>{merchant}</div>

          {amount && token ? (
            <div style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 16 }}>
              {/* One interpolated child, not two. Satori throws on any div
                  with multiple children that is not explicitly flex, and
                  `{glyph}{amount}` counts as two -- which would have failed
                  the render for every link that carries an amount. */}
              <div style={{ color: "#B2F55A", fontSize: 88, fontWeight: 800 }}>{`${glyph}${amount}`}</div>
              {/* The asset, as a badge rather than trailing text -- same coin
                  mark and border the app uses next to every amount. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  border: "2px solid #2a2a2a",
                  padding: "10px 20px 10px 12px",
                }}
              >
                <div
                  style={{
                    width: 52,
                    height: 52,
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
                  {glyph}
                </div>
                <div style={{ color: "#f5f5f5", fontSize: 38, fontWeight: 600, letterSpacing: 1 }}>{token}</div>
              </div>
            </div>
          ) : (
            <div style={{ color: "#B2F55A", fontSize: 72, fontWeight: 800, marginTop: 12 }}>
              Pay with any stablecoin
            </div>
          )}
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
