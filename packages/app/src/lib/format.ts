import type { Currency } from "@conduit/sdk";
import { toHumanAmount, fromHumanAmount, currencyDecimals } from "@conduit/sdk";

const SYMBOLS: Record<string, string> = { USDC: "$", EURC: "€", BRLA: "R$", AUDF: "A$", MXNB: "MX$", QCAD: "C$" };

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
