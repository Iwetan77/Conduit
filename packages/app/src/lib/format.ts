import type { Currency } from "@conduit/sdk/lite";
import { toHumanAmount, fromHumanAmount, currencyDecimals } from "@conduit/sdk/lite";
import { isoToToken } from "./currencies";

// The glyph table that used to prefix every amount is gone with formatAmount's
// prefix -- see the note there. Deleted rather than kept "in case": a table of
// currency glyphs sitting in a formatting module is an invitation to put them
// back in front of a number, which is the bug.

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
// Amount and token, with no currency glyph in front.
//
// It used to prefix the glyph too, which printed the currency TWICE and broke
// outright for the tokenised FX assets: CHFAU's glyph is the three letters
// "CHF", so an amount came out as "CHF500.00 CHFAU" -- the glyph running
// straight into the digits, then repeated as the code. On a share card, which
// is the first thing anyone sees of a payment request, that reads as broken.
//
// A glyph earns its place when it is one character and universally understood.
// Half of what Conduit moves fails that, and a rule that holds for USDC and not
// for CHFAU is not a rule. The token symbol is the honest label anyway: what is
// being signed for is CHFAU, not Swiss francs.
//
// Where a visual mark is wanted -- the share cards, the pay page -- it is a
// TOKEN ICON next to this string (see TokenIcon), which is a real logo rather
// than a letter pretending to be one, and cannot collide with a number.
export function formatAmount(amount: bigint, currency: Currency): string {
  return `${formatAmountValue(amount, currency)} ${currency}`;
}

// Just the number, grouped and rounded the same way formatAmount does it.
//
// For the layouts that set the amount and its token in separate elements --
// the share cards, where the token is an icon and its own label -- so the two
// cannot drift apart in how they round.
export function formatAmountValue(amount: bigint, currency: Currency): string {
  const decimals = currencyDecimals(currency);
  const value = toHumanAmount(amount, decimals);
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, decimals),
  });
}

// The same number with a whole amount left whole: "500", not "500.00".
//
// For the share cards only, where the amount is the hero at ~150px and two
// trailing zeros are the largest thing on it while carrying no information.
// A ledger keeps its ".00" -- there the decimal column lines up between rows
// and dropping it makes a table ragged -- but a card has exactly one number on
// it and nothing to line up with.
//
// Grouping is kept regardless: "1,234,567.89" is the part that makes a large
// amount readable at a glance, and is what stops a card misrepresenting the
// size of a request.
export function formatAmountHero(amount: bigint, currency: Currency): string {
  const decimals = currencyDecimals(currency);
  const value = toHumanAmount(amount, decimals);
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(2, decimals),
  });
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
