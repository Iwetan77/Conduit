// Decimal-safe amount conversion. `decimals` is always required — there is no
// default, because assuming 6 is exactly the bug that broke every 18-decimal
// currency (BRLA, KRW1) in this codebase before this file existed.
// See audit/DECIMAL-AUDIT.md.

/// @notice Convert a raw on-chain bigint amount to a human-readable decimal string.
export function toHumanAmount(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`toHumanAmount: invalid decimals ${decimals}`);
  }
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/// @notice Parse a human-readable decimal string into a raw on-chain bigint amount.
///         Truncates (does not round) any fractional precision beyond `decimals`.
export function fromHumanAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`fromHumanAmount: invalid decimals ${decimals}`);
  }
  const clean = value.trim();
  const negative = clean.startsWith("-");
  const unsigned = negative ? clean.slice(1) : clean;
  const [wholeRaw = "0", fracRaw = ""] = unsigned.replace(/[^0-9.]/g, "").split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  const paddedFrac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  const magnitude = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
  return negative ? -magnitude : magnitude;
}
