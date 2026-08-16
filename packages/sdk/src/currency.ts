// Single source of truth for currency <-> token resolution, replacing the five
// independent (and drifting) currencyToAddress/addressToCurrency implementations
// found in swap.ts, client.ts, router.ts, and declaration.ts during the Phase 0
// audit (audit/DECIMAL-AUDIT.md, finding #7).
//
// Keyed by ON-CHAIN TOKEN SYMBOL (USDC, EURC, BRLA, ...) — NOT the 3-letter ISO
// fiat code CurrencyRegistry.sol uses (USD, EUR, BRL...). Those are deliberately
// different: the SDK/app layer has always dealt in "which token", matching what
// a wallet UI shows (TokenBadge, balances, token pickers); the contract-level
// CurrencyRegistry deals in "which fiat", matching a bytes3 code and the public
// API surface (settle_currency: "EUR" in the v2 spec's example payloads). Phase 2's
// Go API is the natural place to bridge symbol <-> ISO; this file does NOT do that
// bridging — don't conflate the two.
//
// Mirrors the tokens confirmed live in Phase 0 (docs/fx-capability.md) and
// registered on-chain by packages/contracts/script/Deploy.s.sol.
// TODO(Phase 2): once packages/api exists, prefer GET /v1/currencies over this
// static list so the SDK always reflects what's actually routable right now,
// per the v2 build spec ("never a static list"). This static list is the
// necessary bootstrap before that endpoint exists.

import type { Address, Currency, CurrencyDescriptor } from "./types.js";

export const CURRENCIES: Record<Currency, CurrencyDescriptor> = {
  USDC: { iso: "USDC", token: "0x3600000000000000000000000000000000000000", decimals: 6 },
  EURC: { iso: "EURC", token: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", decimals: 6 },
  BRLA: { iso: "BRLA", token: "0x8629020763F6239643a02e664a25BF4AD7787254", decimals: 18 },
  AUDF: { iso: "AUDF", token: "0xd2a530170D71a9Cfe1651Fb468E2B98F7Ed7456b", decimals: 6 },
  MXNB: { iso: "MXNB", token: "0x836F73Fbc370A9329Ba4957E47912DfDBA6BA461", decimals: 6 },
  QCAD: { iso: "QCAD", token: "0x23d7CFFd0876f3ABb6B074287ba2aeefBc83825d", decimals: 6 },
  GBPA: { iso: "GBPA", token: "0xa42e82b5D25E84d107Cd8549CA432ef489CbaD32", decimals: 6 },
  ZARU: { iso: "ZARU", token: "0x47b025D6002234a5038bCD94767bd82b27C2b96F", decimals: 18 },
  KRW1: { iso: "KRW1", token: "0xC5bD9EBB09446F5F94E3b3D899072fC2eC5d3a1a", decimals: 18 },
  // AllUnity's Swiss franc and euro. Both 6dp, both confirmed quotable against
  // USDC on StableFX and read back from their own decimals() on Arc.
  CHFAU: { iso: "CHFAU", token: "0x74ef206336F87843485E5f3fdaEA13ba4ec309E7", decimals: 6 },
  EURAU: { iso: "EURAU", token: "0x67521a2b4b385eEB2c65695C23457e04dC8A6331", decimals: 6 },
};

export function resolveCurrency(iso: Currency): CurrencyDescriptor {
  const descriptor = CURRENCIES[iso];
  if (!descriptor) {
    throw new Error(`Unknown currency code: ${iso}. Registered: ${Object.keys(CURRENCIES).join(", ")}`);
  }
  return descriptor;
}

export function currencyToAddress(iso: Currency): Address {
  return resolveCurrency(iso).token;
}

export function currencyDecimals(iso: Currency): number {
  return resolveCurrency(iso).decimals;
}

/// @dev Throws on an unrecognized address rather than defaulting — an unknown
///      token silently mislabeled as USDC was audit finding #21.
export function addressToCurrency(address: Address): Currency {
  const lower = address.toLowerCase();
  for (const descriptor of Object.values(CURRENCIES)) {
    if (descriptor.token.toLowerCase() === lower) return descriptor.iso;
  }
  throw new Error(`Unknown token address: ${address}`);
}
