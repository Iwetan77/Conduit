// Settle-currency choices offered across the dashboard (onboarding, request
// payment, locations) — kept as one shared list + flag map since it was
// previously duplicated verbatim in three places.
export const SETTLE_CURRENCIES = ["EUR", "USD", "BRL", "AUD", "MXN", "CAD", "GBP", "ZAR", "KRW"] as const;

const FLAGS: Record<string, string> = {
  EUR: "🇪🇺",
  USD: "🇺🇸",
  BRL: "🇧🇷",
  AUD: "🇦🇺",
  MXN: "🇲🇽",
  CAD: "🇨🇦",
  GBP: "🇬🇧",
  ZAR: "🇿🇦",
  KRW: "🇰🇷",
};

export function currencyFlag(iso: string): string {
  return FLAGS[iso] ?? "";
}

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
};

export function isoToToken(iso: string): string {
  return ISO_TO_TOKEN[iso] ?? iso; // already-a-token-symbol passes through
}

// The label for a settle-currency <option>.
//
// These pickers choose which STABLECOIN a merchant is paid in — there is no
// bank leg anywhere in Conduit — so listing "EUR" named a thing the product
// doesn't handle. The value stays the ISO code the API expects; only the label
// changes, so nothing about what gets submitted moves.
export function settleCurrencyLabel(iso: string): string {
  return `${currencyFlag(iso)} ${isoToToken(iso)}`.trim();
}
