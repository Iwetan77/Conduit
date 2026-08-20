// Dynamic Open Graph image for /pay/[declarationId] — the card that renders
// when a payment link is shared on X, WhatsApp, Telegram, etc.
//
// It is meant to look like the page it links to, and for a long time it did
// not: ImageResponse renders with a fallback sans unless it is handed font
// bytes, so the card came out in system Helvetica while the site is Barlow
// Condensed and JetBrains Mono. Same colours, same words, completely different
// object -- which is what "the card looks off" was. The fonts below are the
// site's own files, sitting beside this route.
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toHumanAmount, currencyDecimals } from "@conduit/sdk/lite";
import { isoToToken } from "@/lib/currencies";

export const alt = "Conduit payment request";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const API_BASE = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "http://localhost:8080";

// The currency's own symbol. Keyed by the ISO code the API sends, which is why
// EURAU appears as itself: it is a token symbol standing in for an ISO code,
// because EUR is already EURC's (see lib/currencies.ts).
const SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", EURAU: "€", BRL: "R$", AUD: "A$", MXN: "MX$",
  CAD: "C$", GBP: "£", ZAR: "R", KRW: "₩", CHF: "Fr",
};

// Read off disk, once per warm instance.
//
// Not via fetch(new URL("./x", import.meta.url)): that yields a file:// URL and
// fetch cannot read file:// in the Node runtime, so it threw, the catch around
// it returned null for all three, and the fonts array went out EMPTY -- which
// satori rejects outright ("No fonts are loaded. At least one font is required
// to calculate the layout"). An empty fonts array is not a fallback, it is a
// 500, so the card that was supposed to degrade to a system sans instead did
// not render at all.
//
// The path is relative to the function's working directory, and the files reach
// the deployed function only because next.config.mjs traces them in
// explicitly. Memoised as a promise so concurrent crawler hits share one read;
// deliberately NOT wrapped in a try/catch, because a card that fails loudly in
// preview is worth more than one that silently ships in Helvetica.
const ASSET_DIR = join(process.cwd(), "src", "app", "pay", "[declarationId]");

let assets: Promise<{ display: Buffer; mono: Buffer; wordmarkSrc: string }> | null = null;
function loadAssets() {
  assets ??= (async () => {
    const [display, mono, wordmark] = await Promise.all([
      readFile(join(ASSET_DIR, "display-900.woff")),
      readFile(join(ASSET_DIR, "mono-500.woff")),
      readFile(join(ASSET_DIR, "conduit-wordmark.png")),
    ]);
    return {
      display,
      mono,
      wordmarkSrc: `data:image/png;base64,${wordmark.toString("base64")}`,
    };
  })();
  return assets;
}

async function fetchInfo(id: string | undefined) {
  // Guarded, because everything below it is best-effort and this was not.
  // A throw anywhere in this module takes the whole card down -- and a card
  // that 500s is invisible: the crawler keeps the title and description from
  // generateMetadata and silently drops the image, which is indistinguishable
  // from never having built one.
  if (!id) return null;
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

// params is a PROMISE in Next 15, exactly as it is in page.tsx beside this.
//
// Typed as a plain object, `params.declarationId` reads undefined off a
// pending promise -- no type error, no build error, and a TypeError at request
// time that returned 500 for every share card in production. The page's
// generateMetadata awaited it properly, so og:title and og:description were
// correct while the image behind them did not exist, which is the worst
// possible shape for this bug: the link previewed, just without the card.
export default async function Image({
  params,
}: {
  params: Promise<{ declarationId: string }>;
}) {
  const { declarationId } = await params;
  const [info, { display, mono, wordmarkSrc }] = await Promise.all([
    fetchInfo(declarationId),
    loadAssets(),
  ]);

  const merchant = info?.display_name?.trim() || "A Conduit merchant";

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

  // The grid, drawn rather than imported. The site's background grid is a CSS
  // layer this renderer has no access to, and without it the card reads as a
  // plain black rectangle instead of as a Conduit surface.
  const gridLines: React.ReactElement[] = [];
  for (let x = 0; x <= 1200; x += 60) {
    gridLines.push(
      <div
        key={`v${x}`}
        style={{ position: "absolute", left: x, top: 0, width: 1, height: 630, background: "#111" }}
      />,
    );
  }
  for (let y = 0; y <= 630; y += 60) {
    gridLines.push(
      <div
        key={`h${y}`}
        style={{ position: "absolute", left: 0, top: y, width: 1200, height: 1, background: "#111" }}
      />,
    );
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: "#050505",
          fontFamily: "Display",
        }}
      >
        {gridLines}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: "100%",
            height: "100%",
            padding: 72,
          }}
        >
          {/* Top rail: the mark, and the network, exactly as the page heads it */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={wordmarkSrc} width={224} height={66} alt="Conduit" />
            <div
              style={{
                fontFamily: "Mono",
                color: "#6a6a6a",
                fontSize: 22,
                letterSpacing: 3,
              }}
            >
              ARC TESTNET
            </div>
          </div>

          {/* The ask. The amount is the hero here as it is on the page. */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontFamily: "Mono", color: "#8a8a8a", fontSize: 24, letterSpacing: 2 }}>
              PAYMENT REQUEST FROM
            </div>
            <div style={{ color: "#f5f5f5", fontSize: 62, lineHeight: 1.1, marginTop: 6 }}>
              {merchant}
            </div>

            {amount && token ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginTop: 10 }}>
                <div style={{ color: "#B2F55A", fontSize: 148, lineHeight: 1 }}>
                  {`${glyph}${amount}`}
                </div>
                <div style={{ color: "#f5f5f5", fontSize: 60, lineHeight: 1 }}>{token}</div>
              </div>
            ) : (
              <div style={{ color: "#B2F55A", fontSize: 96, lineHeight: 1, marginTop: 10 }}>
                Pay in any stablecoin
              </div>
            )}
          </div>

          <div style={{ fontFamily: "Mono", color: "#6a6a6a", fontSize: 22 }}>
            Pay in any currency · settles instantly on Arc
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Display", data: display, weight: 900, style: "normal" },
        { name: "Mono", data: mono, weight: 500, style: "normal" },
      ],
    },
  );
}
