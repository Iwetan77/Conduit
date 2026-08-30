// Settle-currency choices offered across the dashboard (onboarding, request
// payment, locations) — kept as one shared list since it was previously
// duplicated verbatim in three places.
// EURAU is listed by its token symbol rather than an ISO code, because EUR is
// already EURC's. Two euro tokens from different issuers cannot share one code
// (see packages/api/internal/currency/currency.go), so they are offered as two
// choices.
export const SETTLE_CURRENCIES = ["EUR", "EURAU", "USD", "BRL", "AUD", "MXN", "CAD", "GBP", "ZAR", "KRW", "CHF"] as const;

// ISO fiat code (what the API speaks: settle_currency "EUR") → on-chain
// token symbol (what the SDK/wallet layer speaks: "EURC"). The SDK
// deliberately doesn't do this bridging (see sdk/src/currency.ts header);
// the app is the natural place for it on the payer surface.
const ISO_TO_TOKEN: Record<string, string> = {
  USD: "USDC",
  EUR: "EURC",
  BRL: "BRLA",
  AUD: "AUDF",
  MXN: "MXNB",
  CAD: "QCAD",
  GBP: "GBPA",
  ZAR: "ZARU",
  KRW: "KRW1",
  CHF: "CHFAU",
  // EURAU is already the token symbol; isoToToken passes it through unchanged.
};

export function isoToToken(iso: string): string {
  return ISO_TO_TOKEN[iso] ?? iso; // already-a-token-symbol passes through
}

// Every token whose issuer artwork ships in packages/app/public/tokens.
//
// Keyed by TOKEN symbol, never the ISO code — run isoToToken first. Keying on
// ISO is what made EURAU need a special case previously, since EUR already
// belongs to EURC.
//
// One list, two very different consumers: TokenIcon serves these to the browser
// as /tokens/X.svg, and the share card (app/pay/[declarationId]/opengraph-image)
// reads the same files off disk and inlines them as data URIs for satori. They
// must agree on which tokens have art, so the list lives here rather than in
// either of them.
//
// An allowlist, not a directory glob: an unrecognised currency has to fall
// through to a monogram rather than request a file that is not there.
export const TOKEN_LOGOS = new Set<string>([
  "USDC", "EURC", "BRLA", "AUDF", "MXNB", "QCAD",
  "GBPA", "ZARU", "KRW1", "CHFAU", "EURAU",
]);

// Public URL of a token's logo, or null when we have no artwork for it.
export function tokenLogoPath(token: string): string | null {
  return TOKEN_LOGOS.has(token) ? `/tokens/${token}.svg` : null;
}

// The label for a settle-currency choice.
//
// These pickers choose which STABLECOIN a merchant is paid in — there is no
// bank leg anywhere in Conduit — so listing "EUR" named a thing the product
// doesn't handle. The value stays the ISO code the API expects; only the label
// changes, so nothing about what gets submitted moves.
//
// It used to carry a flag emoji too. The token's own logo now sits beside it
// (SettleCurrencySelect), which says the same thing without claiming that
// EURAU and EURC are the same asset because they share a country.
export function settleCurrencyLabel(iso: string): string {
  return isoToToken(iso);
}
