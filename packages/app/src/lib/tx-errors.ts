// Human-facing error codes for payment failures.
//
// Raw wallet / RPC / SDK errors are developer noise and frankly scary to a
// payer: "could not coalesce error ... viem@2.55.5", walls of JSON, stack
// traces, "execution reverted: TRANSFER_FROM_FAILED". classifyTxError maps
// them to a stable numeric code plus one plain sentence. The UI shows
// "Error 101 — Not enough balance…"; the code is the thing a user can quote to
// support, and every code is documented in errorcodes.md (gitignored).
//
// Ranges: 1xx funds · 2xx network/infra · 3xx FX/quote · 4xx wallet/signing ·
// 9xx unknown. Keep this table and errorcodes.md in lockstep.

export interface TxError {
  code: number;
  message: string;
}

const contains = (haystack: string, ...needles: string[]) =>
  needles.some((n) => haystack.includes(n));

export function classifyTxError(err: unknown): TxError {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  const name = err instanceof Error ? err.name : "";

  // 1xx — funds
  if (
    name === "InsufficientFundsError" ||
    contains(raw, "insufficient", "transfer_from_failed", "exceeds balance", "exceeds allowance")
  ) {
    return { code: 101, message: "Not enough balance to cover this payment." };
  }
  if (contains(raw, "insufficient funds for gas", "gas required exceeds", "out of gas")) {
    return { code: 102, message: "Not enough gas to send this transaction." };
  }

  // 4xx — wallet / signing
  if (contains(raw, "user rejected", "user denied", "action_rejected", "rejected the request", "denied transaction")) {
    return { code: 401, message: "You cancelled the request in your wallet." };
  }
  if (contains(raw, "could not be verified against the expected address", "3015")) {
    return { code: 402, message: "Your wallet signed with a different account than expected. Reconnect and try again." };
  }
  if (contains(raw, "no wallet", "no account is connected", "connect a wallet")) {
    return { code: 403, message: "No wallet connected. Connect a wallet or sign in, then try again." };
  }
  // An expired credential, not a failed payment. A Circle user token lasts 60
  // minutes, so this is what a merchant signing a payment after an hour on the
  // same tab actually hits. Untriaged it fell to 900 ("something went wrong"),
  // which sent people looking for a problem with the payment -- there is none,
  // and signing in again fixes it every time.
  if (
    contains(
      raw,
      "sign-in expired",
      "session expired",
      "missing or invalid api key",
      "x-circle-user-token"
    )
  ) {
    return { code: 404, message: "Your sign-in expired. Sign in again, then retry this payment." };
  }

  // 5xx — refused on purpose. Not a failure: the contract did what it was told.
  //
  // Kept above the 2xx network bucket, which matches on "revert" and would
  // otherwise swallow this as "the network rejected this transaction" — true
  // in the narrowest sense and useless to the payer, who can act on the real
  // reason and cannot act on that one.
  if (contains(raw, "preferencemismatch")) {
    return {
      code: 501,
      message:
        "This recipient only accepts a different currency — they've set a standing settlement preference. " +
        "Pay in that currency instead.",
    };
  }

  // 3xx — FX / quote
  if (contains(raw, "quote has expired", "fx_quote_expired", "rate kept moving", "rate moved")) {
    return { code: 301, message: "The exchange rate moved before you approved. Please try again." };
  }
  if (contains(raw, "fx provider", "stablefx", "no payload to sign", "unsigned-able")) {
    return { code: 302, message: "The currency-conversion provider is unavailable right now. Try again shortly." };
  }

  // 2xx — network / infrastructure
  if (
    contains(
      raw,
      "load failed",
      "failed to fetch",
      "could not coalesce",
      "network error",
      "networkerror",
      "timeout",
      "timed out",
      "fetch failed"
    )
  ) {
    return { code: 201, message: "Couldn't reach the network. Check your connection and try again." };
  }
  if (contains(raw, "revert", "rpc", "json-rpc")) {
    return { code: 202, message: "The network rejected this transaction. Please try again in a moment." };
  }

  // 9xx — unknown
  return { code: 900, message: "Something went wrong sending this payment. Please try again." };
}

// "Error 101 — Not enough balance to cover this payment."
export function formatTxError(err: unknown): string {
  const { code, message } = classifyTxError(err);
  return `Error ${code} — ${message}`;
}
