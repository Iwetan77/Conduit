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

// The token's own mark, mirroring TokenIcon in components/Shared/TokenBadge.
//
// A glyph table used to sit here and print in FRONT of the amount, which put
// the currency on the card twice and welded a multi-letter code onto the first
// digit: CHF's entry rendered "Fr500.00 CHFAU". The card is what gets pasted
// into WhatsApp and X, so that was the version of a payment request most people
// would ever see.
//
// Keyed by TOKEN symbol, not the ISO code -- isoToToken has already run by the
// time these are used, and keying on ISO is what made EURAU need a special case
// (EUR is already EURC's).
const COIN_GLYPHS: Record<string, string> = { USDC: "$", EURC: "€" };
// Circle's regional stablecoins have no coin artwork, so they show the
// country's flag, exactly as the app does.
const FLAG_FOR: Record<string, string> = {
  BRLA: "BR", AUDF: "AU", MXNB: "MX", QCAD: "CA", GBPA: "GB",
  ZARU: "ZA", KRW1: "KR", CHFAU: "CH", EURAU: "EU",
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

// Flags, read from disk on demand and cached per country.
//
// Copied into this directory rather than imported from country-flag-icons:
// the app's TokenIcon uses that package's React components, which satori
// cannot render, and a node_modules path is not reliably traced into the
// deployed function. Real .svg files beside the fonts, covered by the same
// tracing rule, and small enough that all nine together are under 7 kB.
//
// Failure is non-fatal on purpose. Everything about this card is best-effort:
// a missing flag should cost the mark, never the whole image.
const flagCache = new Map<string, Promise<string | null>>();
function loadFlag(country: string) {
  let hit = flagCache.get(country);
  if (!hit) {
    hit = readFile(join(ASSET_DIR, "flags", `${country}.svg`))
      .then((buf) => `data:image/svg+xml;base64,${buf.toString("base64")}`)
      .catch(() => null);
    flagCache.set(country, hit);
  }
  return hit;
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
  if (info?.amount && info?.settle_currency) {
    try {
      token = isoToToken(info.settle_currency);
      const human = toHumanAmount(BigInt(info.amount), currencyDecimals(token));
      // A whole amount stays whole. Two trailing zeros were the largest thing
      // on the card after the number itself and said nothing; grouping stays,
      // because that is what makes a big request readable at a glance.
      amount = Number(human).toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
    } catch {
      amount = "";
      token = "";
    }
  }

  // The token's mark: a flag for the regional stablecoins, a coin for USDC and
  // EURC, and nothing at all when neither applies -- the symbol beside the
  // amount still names it, so a missing mark costs decoration rather than
  // meaning.
  const flagSrc = token && FLAG_FOR[token] ? await loadFlag(FLAG_FOR[token]) : null;
  const coinGlyph = token ? COIN_GLYPHS[token] : undefined;

  // The amount and its symbol are set at ONE size, sized to fit.
  //
  // The symbol used to be fixed at 60px next to a 148px number, which read as a
  // footnote floating beside the amount rather than as part of it -- and the
  // symbol is not a footnote, it is which asset is being asked for.
  //
  // Equal sizing only works if the pair can shrink: "1,234,567.89 KRW1" at
  // 148px is far wider than the card. So the size is derived from the line's
  // own length. Anton's digits run about 0.58em wide, and roughly 930px is left
  // once the padding and the token mark are taken out; 148px stays the ceiling
  // so a short amount still lands as hard as it did.
  const heroLine = `${amount} ${token}`;
  const heroSize = Math.max(
    56,
    Math.min(148, Math.floor((flagSrc || coinGlyph ? 930 : 1050) / (0.58 * heroLine.length))),
  );

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
              <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 10 }}>
                {/* The mark first, then the number alone, then the symbol.
                    The glyph used to be welded to the first digit, so CHFAU
                    read "Fr500.00 CHFAU" -- the currency stated twice, once as
                    letters touching the number. A mark cannot collide with a
                    digit however many letters the token's name has. */}
                {flagSrc ? (
                  // Circle-cropped so a 3:2 flag sits as an equal beside the
                  // round coin marks, matching TokenIcon in the app.
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 104,
                      height: 104,
                      borderRadius: 52,
                      overflow: "hidden",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={flagSrc} width={156} height={104} alt="" />
                  </div>
                ) : coinGlyph ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 104,
                      height: 104,
                      borderRadius: 52,
                      border: "3px solid #B2F55A",
                      color: "#B2F55A",
                      fontSize: 56,
                      lineHeight: 1,
                    }}
                  >
                    {coinGlyph}
                  </div>
                ) : null}
                {/* Same size, so the pair reads as one amount. Colour is what
                    separates them: the number in signal green, the asset in
                    grey. Equal weight without equal loudness -- the amount is
                    what someone is deciding about, and the token names it.
                    The same grey as "PAYMENT REQUEST FROM" above, so the card
                    has one voice for labels rather than a third tone. */}
                <div style={{ color: "#B2F55A", fontSize: heroSize, lineHeight: 1 }}>{amount}</div>
                <div style={{ color: "#8a8a8a", fontSize: heroSize, lineHeight: 1 }}>{token}</div>
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
