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
