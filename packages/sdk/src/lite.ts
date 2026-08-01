// Ethers-free entry point.
//
// The main barrel (`index.ts`) re-exports ConduitClient, which imports ethers
// at module scope. That meant `import { CURRENCIES } from "@conduit/sdk"` —
// a handful of constants — pulled a ~15 MB library into the bundle of every
// page that did it, which was most of the app.
//
// This module exposes only the parts that touch no chain library: currency
// metadata, amount conversion, addresses, chain config, and types. Anything
// that needs a provider or signer still lives in the main entry point.
export {
  resolveCurrency,
  currencyToAddress,
  currencyDecimals,
  addressToCurrency,
  CURRENCIES,
} from "./currency.js";
export { toHumanAmount, fromHumanAmount } from "./amount.js";
export { ARC_TESTNET, ERC20_ABI, ROUTER_ABI, REGISTRY_ABI } from "./constants.js";
export { arcTestnet } from "./chains.js";
export type {
  Address,
  Bytes32,
  Currency,
  PaymentInstruction,
  PaymentReceipt,
  PaymentDeclaration,
  CurrencyDescriptor,
  Quote,
  GetHistoryOptions,
} from "./types.js";
