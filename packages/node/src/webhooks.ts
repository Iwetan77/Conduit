import { createHmac, timingSafeEqual } from "node:crypto";
import { ConduitSignatureVerificationError } from "./errors.js";

// Mirrors packages/api/internal/webhooks/webhooks.go's Sign/Verify exactly:
//   header:  "t=<unix>,v1=<hex>"
//   v1    =  HMAC-SHA256(secret, "<t>.<rawBody>")
//   tolerance: |now - t| <= 300s

const TOLERANCE_SECONDS = 300;

export interface ConduitEvent {
  type: string;
  data: unknown;
}

/// @notice Verify a webhook delivery and parse its payload. Throws
///         ConduitSignatureVerificationError on a bad signature, a malformed
///         header, or a timestamp outside the 300s tolerance — never returns
///         a partially-trusted result.
/// @param rawBody   The exact bytes Conduit sent — must be the raw request
///                  body read BEFORE any JSON parsing/framework middleware
///                  touches it, or the HMAC will not match.
/// @param sigHeader The `Conduit-Signature` header value.
/// @param secret    The webhook endpoint's secret (from
///                  `POST /v1/webhook_endpoints`'s one-time response).
export function constructEvent(rawBody: string | Buffer, sigHeader: string, secret: string): ConduitEvent {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(sigHeader);
  if (!match) {
    throw new ConduitSignatureVerificationError("malformed Conduit-Signature header");
  }
  const tsStr = match[1]!;
  const v1 = match[2]!;
  const ts = Number(tsStr);

  const age = Math.floor(Date.now() / 1000) - ts;
  if (Math.abs(age) > TOLERANCE_SECONDS) {
    throw new ConduitSignatureVerificationError(
      `signature timestamp outside ${TOLERANCE_SECONDS}s tolerance (age=${age}s)`
    );
  }

  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const mac = createHmac("sha256", secret);
  mac.update(tsStr);
  mac.update(".");
  mac.update(bodyBuf);
  const expected = mac.digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(v1, "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new ConduitSignatureVerificationError("signature mismatch");
  }

  // Wire shape from webhooks.go's dispatcher: {"type": eventType, "data": payload, "created": unixTime}
  const parsed = JSON.parse(bodyBuf.toString("utf8"));
  return { type: parsed.type, data: parsed.data };
}
