// Generates docs/currencies.md from a live GET /v1/currencies call — per spec,
// this page must never be hand-written, since routability changes as StableFX/AMM
// coverage changes. Requires packages/api's devserver running on localhost:8080.
//
// Usage: pnpm tsx scripts/generate-currencies-doc.ts

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Currency {
  iso: string;
  symbol: string;
  token: string;
  decimals: number;
}

async function main() {
  const res = await fetch("http://localhost:8080/v1/currencies");
  if (!res.ok) {
    throw new Error(`GET /v1/currencies failed: ${res.status}`);
  }
  const { data }: { data: Currency[] } = await res.json();

  const lines: string[] = [];
  lines.push("# Currencies");
  lines.push("");
  lines.push(
    `Generated from a live \`GET /v1/currencies\` call — this is what's actually routable ` +
    `right now (registered in \`CurrencyRegistry\` on-chain, confirmed against StableFX/AMM ` +
    `coverage), not a static list someone forgot to update. Re-run ` +
    `\`scripts/generate-currencies-doc.ts\` to refresh.`
  );
  lines.push("");
  lines.push("| ISO | Token | Address | Decimals |");
  lines.push("|---|---|---|---|");
  for (const c of data) {
    lines.push(`| ${c.iso} | ${c.symbol} | \`${c.token}\` | ${c.decimals} |`);
  }
  lines.push("");
  lines.push(
    "Not every pair above is routable against every other — see " +
    "[docs/fx-capability.md](./fx-capability.md) for the hub-and-spoke constraint " +
    "(StableFX quotes go through USDC on one leg) and current AMM fallback coverage."
  );

  const outPath = resolve(__dirname, "../docs/currencies.md");
  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`Wrote ${outPath} (${data.length} currencies)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
