import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { constructEvent } from "./webhooks.js";
import { ConduitSignatureVerificationError } from "./errors.js";

// Reproduces webhooks.go's Sign() exactly, independently, so this test
// doesn't just check constructEvent against itself.
function sign(secret: string, ts: number, body: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(String(ts));
  mac.update(".");
  mac.update(body);
  return `t=${ts},v1=${mac.digest("hex")}`;
}

describe("constructEvent", () => {
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ type: "settlement.succeeded", data: { intent_id: "si_abc" }, created: 1785000000 });

  it("parses a validly-signed event", () => {
    const header = sign(secret, Math.floor(Date.now() / 1000), payload);
    const event = constructEvent(payload, header, secret);
    expect(event.type).toBe("settlement.succeeded");
    expect((event.data as { intent_id: string }).intent_id).toBe("si_abc");
  });

  it("rejects a tampered body", () => {
    const header = sign(secret, Math.floor(Date.now() / 1000), payload);
    const tampered = payload.replace("si_abc", "si_evil");
    expect(() => constructEvent(tampered, header, secret)).toThrow(ConduitSignatureVerificationError);
  });

  it("rejects a signature made with the wrong secret", () => {
    const header = sign("wrong_secret", Math.floor(Date.now() / 1000), payload);
    expect(() => constructEvent(payload, header, secret)).toThrow(ConduitSignatureVerificationError);
  });

  it("rejects a timestamp outside the 300s tolerance", () => {
    const staleTs = Math.floor(Date.now() / 1000) - 301;
    const header = sign(secret, staleTs, payload);
    expect(() => constructEvent(payload, header, secret)).toThrow(/tolerance/);
  });

  it("rejects a malformed header", () => {
    expect(() => constructEvent(payload, "not-a-valid-header", secret)).toThrow(/malformed/);
  });
});
