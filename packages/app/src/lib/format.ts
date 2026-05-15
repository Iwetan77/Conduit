import type { Currency } from "@conduit/sdk";

// Format a 6-decimal bigint as human-readable currency string
export function formatAmount(amount: bigint, currency: Currency): string {
  const divisor = 1_000_000n;
  const whole = amount / divisor;
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  const value = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return `${currency === "USDC" ? "$" : "€"}${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

// Format for display without currency prefix
export function formatAmountRaw(amount: bigint): string {
  const divisor = 1_000_000n;
  const whole = amount / divisor;
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

// Parse human input string to 6-decimal bigint
export function parseAmount(value: string): bigint {
  const clean = value.replace(/[^0-9.]/g, "");
  const [whole = "0", frac = ""] = clean.split(".");
  const paddedFrac = frac.slice(0, 6).padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(paddedFrac || "0");
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
