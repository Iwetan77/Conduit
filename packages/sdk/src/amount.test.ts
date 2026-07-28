import { describe, it, expect } from "vitest";
import { toHumanAmount, fromHumanAmount } from "./amount.js";

function randomBigInt(maxDigits: number): bigint {
  const digits = 1 + Math.floor(Math.random() * maxDigits);
  let s = "";
  for (let i = 0; i < digits; i++) s += Math.floor(Math.random() * 10).toString();
  s = s.replace(/^0+(?=\d)/, "");
  return BigInt(s || "0");
}

describe("toHumanAmount / fromHumanAmount round-trip", () => {
  const decimalsToTest = [6, 8, 18];

  for (const decimals of decimalsToTest) {
    it(`round-trips random values at decimals=${decimals}`, () => {
      for (let i = 0; i < 500; i++) {
        const x = randomBigInt(24);
        const human = toHumanAmount(x, decimals);
        const back = fromHumanAmount(human, decimals);
        expect(back).toBe(x);
      }
    });

    it(`round-trips sub-minor-unit and edge values at decimals=${decimals}`, () => {
      const edgeCases = [0n, 1n, 9n, 10n ** BigInt(decimals) - 1n, 10n ** BigInt(decimals), 10n ** BigInt(decimals) + 1n];
      for (const x of edgeCases) {
        const human = toHumanAmount(x, decimals);
        const back = fromHumanAmount(human, decimals);
        expect(back).toBe(x);
      }
    });

    it(`handles the full range for decimals=${decimals} (18dp doesn't overflow Number)`, () => {
      // A large 18dp value that would exceed Number.MAX_SAFE_INTEGER if ever
      // coerced through `Number()` — this is exactly the class of bug found in
      // audit/DECIMAL-AUDIT.md (e.g. PayConfirm.tsx's `Number(amount) / 1e6`).
      const large = 123_456_789_012_345_678_901n;
      const human = toHumanAmount(large, decimals);
      const back = fromHumanAmount(human, decimals);
      expect(back).toBe(large);
    });
  }

  it("throws on missing/invalid decimals rather than silently defaulting", () => {
    // @ts-expect-error - intentionally omitting the required param
    expect(() => toHumanAmount(100n)).toThrow();
    expect(() => toHumanAmount(100n, -1)).toThrow();
    expect(() => toHumanAmount(100n, 1.5)).toThrow();
  });

  it("formats known values correctly at 18 decimals (BRLA-shaped)", () => {
    // 507.356671 BRLA as returned by a real StableFX quote in Phase 0 (docs/fx-capability.md)
    const raw = 507356671000000000000n;
    expect(toHumanAmount(raw, 18)).toBe("507.356671");
    expect(fromHumanAmount("507.356671", 18)).toBe(raw);
  });

  it("truncates (does not round) precision beyond `decimals`", () => {
    expect(fromHumanAmount("1.9999999", 6)).toBe(fromHumanAmount("1.999999", 6));
  });

  it("handles negative amounts symmetrically", () => {
    const x = -123456789n;
    expect(fromHumanAmount(toHumanAmount(x, 6), 6)).toBe(x);
  });
});
