#!/usr/bin/env node
// Collapse several trace runs into one median file.
//
// A single run is an anecdote. Network latency is noisy, Arc block times vary,
// and Render's instance is shared — so the phase asks for three runs and the
// median, which is what this produces. The median rather than the mean because
// one 30-second outlier from a dropped connection should not move the number
// everything afterwards is compared against.
//
//   node scripts/latency-median.mjs before perf/latency-before-r1.json ...

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [prefix, ...files] = process.argv.slice(2);

if (!prefix || files.length === 0) {
  console.error("usage: node scripts/latency-median.mjs <prefix> <file.json>...");
  process.exit(1);
}

const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));

// Grouped by span name across runs. A span missing from one run is simply not
// counted there rather than treated as zero — a step that was skipped because
// an allowance already existed is not a step that took no time.
const byName = new Map();
for (const run of runs) {
  for (const s of run.spans) {
    if (!byName.has(s.name)) byName.set(s.name, { samples: [], meta: s });
    byName.get(s.name).samples.push(s.ms);
  }
}

const spans = [];
for (const [name, { samples, meta }] of byName) {
  const sorted = [...samples].sort((a, b) => a - b);
  spans.push({
    name,
    ms: sorted[Math.floor(sorted.length / 2)],
    runs: samples.length,
    samples: sorted,
    ...(meta.note ? { note: meta.note } : {}),
  });
}

const out = {
  prefix,
  medianOf: files.length,
  sources: files,
  generatedAt: new Date().toISOString(),
  api: runs[0].api,
  rpc: runs[0].rpc,
  router: runs[0].router,
  payer: runs[0].payer,
  spans,
};

const path = join(ROOT, "perf", `latency-${prefix}.json`);
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");

for (const s of spans) {
  console.error(`${String(s.ms).padStart(7)}ms  ${s.name}  [${s.samples.join(", ")}]`);
}
console.error(`\nwrote ${path}`);
