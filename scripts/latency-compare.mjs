#!/usr/bin/env node
// Did it actually get faster, and did anything get worse?
//
// The second question is the reason this exists. A phase that speeds one span
// up while quietly slowing another is not an improvement, and the work order's
// rule is explicit: exit non-zero if any span regressed by more than 10%. That
// threshold is a judgement about noise, not about tolerance — three runs of the
// same code vary by a few percent, so anything inside 10% is not evidence of
// anything.
//
//   node scripts/latency-compare.mjs perf/latency-before.json perf/latency-after.json

import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: node scripts/latency-compare.mjs <before.json> <after.json>");
  process.exit(1);
}

const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));

const beforeByName = new Map(before.spans.map((s) => [s.name, s]));
const afterByName = new Map(after.spans.map((s) => [s.name, s]));

const REGRESSION_THRESHOLD = 0.10;

// Spans below this are dominated by measurement noise; a 3ms span going to 6ms
// is a 100% "regression" that means nothing.
const NOISE_FLOOR_MS = 50;

const rows = [];
let regressions = 0;

for (const [name, b] of beforeByName) {
  const a = afterByName.get(name);
  if (!a) {
    // A span that no longer exists is usually the point -- a removed round
    // trip. Reported, never counted as a regression.
    rows.push({ name, before: b.ms, after: null, note: "gone" });
    continue;
  }
  const delta = a.ms - b.ms;
  const pct = b.ms === 0 ? 0 : delta / b.ms;
  const regressed = b.ms >= NOISE_FLOOR_MS && pct > REGRESSION_THRESHOLD;
  if (regressed) regressions++;
  rows.push({ name, before: b.ms, after: a.ms, delta, pct, regressed });
}

for (const [name, a] of afterByName) {
  if (!beforeByName.has(name)) rows.push({ name, before: null, after: a.ms, note: "new" });
}

const pad = (s, n) => String(s).padStart(n);
console.log(`${"span".padEnd(34)} ${pad("before", 9)} ${pad("after", 9)} ${pad("delta", 9)}`);
console.log("-".repeat(66));

for (const r of rows) {
  if (r.note === "gone") {
    console.log(`${r.name.padEnd(34)} ${pad(r.before + "ms", 9)} ${pad("—", 9)} ${pad("removed", 9)}`);
    continue;
  }
  if (r.note === "new") {
    console.log(`${r.name.padEnd(34)} ${pad("—", 9)} ${pad(r.after + "ms", 9)} ${pad("new", 9)}`);
    continue;
  }
  const sign = r.delta > 0 ? "+" : "";
  const mark = r.regressed ? "  REGRESSED" : "";
  console.log(
    `${r.name.padEnd(34)} ${pad(r.before + "ms", 9)} ${pad(r.after + "ms", 9)} ` +
      `${pad(sign + r.delta + "ms", 9)} ${(r.pct * 100).toFixed(0)}%${mark}`,
  );
}

// Totals per path, which is what a person actually feels.
console.log("");
for (const prefix of ["same", "cross", "payroll"]) {
  const sum = (spans) =>
    spans.filter((s) => s.name.startsWith(prefix + ".")).reduce((n, s) => n + s.ms, 0);
  const b = sum(before.spans);
  const a = sum(after.spans);
  if (b === 0 && a === 0) continue;
  console.log(`${prefix.padEnd(10)} total  ${pad(b + "ms", 9)} → ${pad(a + "ms", 9)}  (${a - b >= 0 ? "+" : ""}${a - b}ms)`);
}

if (regressions > 0) {
  console.error(`\n${regressions} span(s) regressed by more than ${REGRESSION_THRESHOLD * 100}%.`);
  process.exit(1);
}
console.log("\nno span regressed by more than 10%.");
