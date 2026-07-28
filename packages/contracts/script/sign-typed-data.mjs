#!/usr/bin/env node
// Generic EIP-712 signer used by scripts/e2e.sh to play the role of "the
// payer's wallet" — in production this signing happens client-side in a
// browser wallet (Phase 3 dashboard/checkout); this script exists only so
// the e2e test can exercise the full real flow without a browser.
//
// Usage: node sign-typed-data.mjs <privateKey> < typedData.json
// typedData.json: { "domain": {...}, "types": {...}, "message": {...} }
// Prints the signature (0x...) to stdout.

import { ethers } from "ethers";

async function main() {
  const [privateKey] = process.argv.slice(2);
  const input = JSON.parse(await readStdin());
  const wallet = new ethers.Wallet(privateKey);
  const { EIP712Domain, ...types } = input.types;
  const sig = await wallet.signTypedData(input.domain, types, input.message);
  process.stdout.write(sig);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
