// Records every HTTP attempt Circle's SDK makes against /v1/transfer.
//
// Why this exists, and why it is permanent rather than a debugging session:
//
// The SDK submits the signed burn intent through its own retry loop
// (pollApiWithValidation: maxRetries 10, timeout 2000ms, retryDelay 200ms). The
// request body is built ONCE, before the loop, so every attempt resubmits
// byte-identical signed bytes -- same intents, same salt. If Circle takes longer
// than two seconds to answer, the client aborts its own request, classifies the
// abort as retryable, and posts the same spec again. Circle's replay protection
// then returns 400 "Transfer spec has already been used" -- for a transfer it
// already accepted and already debited.
//
// None of that is reachable from our code: the transfer call site passes no
// config, and spend() exposes no way to supply one. So we cannot prevent the
// duplicate POST. What we can do is see it, every time, including on a phone
// where no devtools are open -- which is what this is for.
//
// See PROGRESS.md, "Phase 12-PRE", for the SDK source this is based on.

export interface GatewayAttempt {
  attempt: number;
  at: string;
  url: string;
  method: string;
  /** HTTP status, or null when the request never completed (abort/network). */
  status: number | null;
  /** SHA-256 of the exact request body. Identical hashes across attempts = replay. */
  bodySha256: string;
  /**
   * Every `salt` found in the body.
   *
   * The salt is what makes a TransferSpec hash unique, so identical salts across
   * two POSTs is not "similar requests", it is literally the same spec twice.
   */
  salts: string[];
  /** Circle's response body, kept only for non-2xx. */
  responseBody?: unknown;
  /** Set when the request threw rather than returning a response. */
  error?: string;
  ms: number;
}

const TRANSFER_PATH = "/v1/transfer";

// Default ON. This is a money path, and the failure it watches for is
// intermittent and has already reached production once.
function enabled(): boolean {
  return process.env.NEXT_PUBLIC_GATEWAY_TRACE !== "0";
}

let attempts: GatewayAttempt[] = [];
let spendCalls = 0;
let installed = 0;
let originalFetch: typeof fetch | null = null;

/** Attempts recorded since the last reset. */
export function gatewayTrace(): { spendCalls: number; posts: GatewayAttempt[] } {
  return { spendCalls, posts: attempts.slice() };
}

/** Count one spend() invocation. Two for one payment means the duplicate is OURS. */
export function noteSpendCall() {
  spendCalls += 1;
}

export function resetGatewayTrace() {
  attempts = [];
  spendCalls = 0;
}

async function sha256Hex(text: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "unavailable";
  }
}

/** Pull every `salt` value out of an arbitrarily nested body. */
function collectSalts(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectSalts(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "salt" && (typeof v === "string" || typeof v === "number")) out.push(String(v));
      else collectSalts(v, out);
    }
  }
  return out;
}

/**
 * Install the interceptor for the duration of one spend.
 *
 * Returns an uninstall function that MUST be called in a `finally`. Nesting is
 * refcounted so two concurrent payments cannot leave `fetch` patched -- a
 * globally patched fetch that outlives its scope is a far worse bug than the one
 * being traced.
 */
export function traceGatewayCalls(): () => void {
  if (!enabled() || typeof window === "undefined") return () => {};

  installed += 1;
  if (installed === 1) {
    originalFetch = window.fetch.bind(window);
    const base = originalFetch;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes(TRANSFER_PATH) || (init?.method ?? "GET").toUpperCase() !== "POST") {
        return base(input, init);
      }

      const attempt = attempts.length + 1;
      const started = Date.now();
      const rawBody = typeof init?.body === "string" ? init.body : "";
      let salts: string[] = [];
      try {
        salts = collectSalts(JSON.parse(rawBody));
      } catch {
        // A body we cannot parse is still worth hashing.
      }
      const bodySha256 = await sha256Hex(rawBody);

      const record: GatewayAttempt = {
        attempt,
        at: new Date().toISOString(),
        url,
        method: "POST",
        status: null,
        bodySha256,
        salts,
        ms: 0,
      };
      attempts.push(record);

      try {
        const res = await base(input, init);
        record.status = res.status;
        record.ms = Date.now() - started;
        if (!res.ok) {
          // Read from a clone: the SDK still needs to consume the body itself.
          try {
            record.responseBody = await res.clone().json();
          } catch {
            record.responseBody = "<unparseable>";
          }
        }
        console.warn("[gateway-trace] POST /v1/transfer", record);
        return res;
      } catch (err) {
        record.ms = Date.now() - started;
        record.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // The interesting one. An abort here is the 2s client timeout, and the
        // NEXT attempt will resubmit this exact bodySha256.
        console.warn("[gateway-trace] POST /v1/transfer FAILED", record);
        throw err;
      }
    };
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    installed -= 1;
    if (installed === 0 && originalFetch) {
      window.fetch = originalFetch;
      originalFetch = null;
    }
  };
}
