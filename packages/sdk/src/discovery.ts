import type { PaymentDeclaration } from "./types.js";
import type { DeclarationClient } from "./declaration.js";

export const CONDUIT_PAYMENT_HEADER = "conduit-payment";
export const CONDUIT_WELL_KNOWN_PATH = "/.well-known/conduit";

export interface DiscoveryResult {
  found: boolean;
  declaration?: PaymentDeclaration;
  source?: "header" | "well-known";
  url?: string;
}

/**
 * Discover a payment declaration from a service endpoint.
 *
 * Checks two places in order:
 *   1. HTTP response header: Conduit-Payment: https://app.conduit.xyz/pay/0xABC
 *   2. Well-known file:      https://service.xyz/.well-known/conduit
 *                            { "paymentUrl": "https://app.conduit.xyz/pay/0xABC" }
 *
 * If found, resolves the declaration from the chain and returns it.
 * If not found, returns { found: false }.
 *
 * Usage:
 *   const result = await discover("https://dataservice.xyz/api", declarationClient)
 *   if (result.found) await conduit.fulfill(result.declaration!)
 */
export async function discover(
  url: string,
  declarationClient: DeclarationClient
): Promise<DiscoveryResult> {
  // Step 1: Check HTTP header via HEAD request
  try {
    const headRes = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000), // 5s timeout
    });
    const headerValue = headRes.headers.get(CONDUIT_PAYMENT_HEADER);
    if (headerValue) {
      const declaration = await declarationClient.parseUrl(headerValue.trim());
      return {
        found: true,
        declaration,
        source: "header",
        url: headerValue.trim(),
      };
    }
  } catch {
    // HEAD failed — fall through to well-known check
  }

  // Step 2: Check well-known file
  try {
    const base = new URL(url).origin;
    const wellKnownUrl = `${base}${CONDUIT_WELL_KNOWN_PATH}`;
    const res = await fetch(wellKnownUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { paymentUrl?: string; version?: string };
      if (data.paymentUrl) {
        const declaration = await declarationClient.parseUrl(data.paymentUrl);
        return {
          found: true,
          declaration,
          source: "well-known",
          url: data.paymentUrl,
        };
      }
    }
  } catch {
    // Well-known check failed — not found
  }

  return { found: false };
}
