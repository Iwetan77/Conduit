// StableFX institutional API (api.circle.com/v1/exchange/stablefx) — removed.
//
// That endpoint requires institutional KYB approval from Circle and is not
// usable by app developers. Swap functionality now goes through:
//
//   swap.ts → Circle stablecoinKits API (v1/stablecoinKits/swap)
//           → Circle Adapter Contract (on-chain)
//           → FxEscrow (0x867650F5eAe8df91445971f14d89fd84F0C9a9f8) settles atomically
//
// Nothing in this file is used. It is kept as a tombstone to explain the change.

export {};
