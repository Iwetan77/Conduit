import type { Currency } from "@conduit/sdk/lite";
import { toHumanAmount, fromHumanAmount, currencyDecimals } from "@conduit/sdk/lite";
import { isoToToken } from "./currencies";

const SYMBOLS: Record<string, string> = { USDC: "$", EURC: "€", BRLA: "R$", AUDF: "A$", MXNB: "MX$", QCAD: "C$", GBPA: "£", ZARU: "R", KRW1: "₩", CHFAU: "CHF", EURAU: "€" };

// The label to print next to an amount. Every amount Conduit moves is an
// on-chain token, so the label must be the token symbol the payer is actually
// signing for — EURC, not EUR. The API speaks ISO on settle_currency because
// that's the merchant's business-level setting, and printing it verbatim was
// telling payers they were sending 5 EUR when the transfer was 5 EURC.
// isoToToken passes an already-token symbol (pay_currency) through unchanged.
export function tokenLabel(currency: string): string {
  return isoToToken(currency);
}

// Decimals for either an on-chain token symbol (USDC, EURC…) OR a 3-letter ISO
// fiat code (USD, EUR…). Settlement/reconciliation rows mix the two:
// pay_currency arrives as a token, settle_currency as ISO. Falls back to 6 (the
// shared precision of every live stablecoin) rather than throwing in a pure
// display path.
function displayDecimals(currency: string): number {
  try {
    return currencyDecimals(isoToToken(currency) as Currency);
  } catch {
    return 6;
  }
}

// Format a raw minor-unit value (Postgres NUMERIC(78,0) returned as a decimal
// string) as a human amount in `currency`. THIS is the minor→major conversion
// the Settlements and Reconciliation tables were skipping — printing e.g.
// "11133000 USDC" for 11.133 USDC. Accepts a string or bigint.
export function formatMinorUnits(amount: string | bigint, currency: string): string {
  const decimals = displayDecimals(currency);
  const value = toHumanAmount(BigInt(amount), decimals);
  return `${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, decimals),
  })} ${tokenLabel(currency)}`;
}

// The same conversion as a Number (no currency suffix) — for summing rows into
// a total. Not for arithmetic that must stay exact; display only.
export function minorUnitsToNumber(amount: string | bigint, currency: string): number {
  return Number(toHumanAmount(BigInt(amount), displayDecimals(currency)));
}

// Format a raw bigint (in `currency`'s own minor units) as a human-readable string
export function formatAmount(amount: bigint, currency: Currency): string {
  const decimals = currencyDecimals(currency);
  const value = toHumanAmount(amount, decimals);
  const symbol = SYMBOLS[currency] ?? "";
  return `${symbol}${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, decimals),
  })} ${currency}`;
}

// Format for display without currency prefix — decimals must be supplied by
// the caller (no default: that was audit finding #14, off by 10^12 at 18dp).
export function formatAmountRaw(amount: bigint, decimals: number): string {
  return toHumanAmount(amount, decimals);
}

// Parse human input string to a raw bigint in `currency`'s own minor units
export function parseAmount(value: string, currency: Currency): bigint {
  return fromHumanAmount(value, currencyDecimals(currency));
}

// parseAmount for values that are still being typed. Live previews run on every
// keystroke, where "", "1." and "abc" are all normal intermediate states —
// throwing on them would take the page down mid-entry. Returns undefined
// instead, which callers treat as "nothing to preview yet".
export function tryParseAmount(value: string, currency: Currency): bigint | undefined {
  try {
    const parsed = parseAmount(value, currency);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Shorten an address for display
export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

// Format a unix timestamp as a readable date
export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
