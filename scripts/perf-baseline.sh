#!/usr/bin/env bash
# Record what the app and the API cost today, so later claims of "faster" and
# "smaller" can be checked instead of asserted.
#
# Two artefacts, both JSON so they diff cleanly:
#   perf/<prefix>-bundle.json   First Load JS per route, from the Next build
#   perf/<prefix>-api.json      response bytes + wall time per API endpoint
#
# Usage:
#   bash scripts/perf-baseline.sh                  # writes perf/baseline-*.json
#   PREFIX=after bash scripts/perf-baseline.sh     # writes perf/after-*.json
#   SKIP_BUILD=1 bash scripts/perf-baseline.sh     # reuse the last build output
#
# CONDUIT_API_URL selects the API to measure (default http://localhost:8080).
# An unreachable API is RECORDED as unreachable rather than failing the run: the
# bundle half is still worth having, and a silently missing endpoint would be
# worse than one marked "error".
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PREFIX="${PREFIX:-baseline}"
API="${CONDUIT_API_URL:-http://localhost:8080}"
# Any address works: this measures response SIZE and TIME, not correctness.
PROBE_ADDR="${PROBE_ADDR:-0x0000000000000000000000000000000000000001}"

mkdir -p perf

BUILD_LOG="$(mktemp)"
trap 'rm -f "$BUILD_LOG"' EXIT

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "==> skipping build (SKIP_BUILD=1)"
  : > "$BUILD_LOG"
else
  echo "==> building @conduit/app"
  # Tee so the operator sees progress AND we can parse the route table.
  if ! pnpm --filter @conduit/app build 2>&1 | tee "$BUILD_LOG"; then
    echo "!! build failed — see output above" >&2
    exit 1
  fi
fi

echo "==> parsing route sizes -> perf/${PREFIX}-bundle.json"
BUILD_LOG="$BUILD_LOG" PREFIX="$PREFIX" node -e '
const fs = require("fs");
const text = fs.readFileSync(process.env.BUILD_LOG, "utf8");

// Next prints a box-drawing table:
//   ├ ƒ /pay/[declarationId]      13 kB    223 kB
//   └ ○ /send                    5.5 kB    222 kB
// and a summary line:
//   + First Load JS shared by all           105 kB
const toKb = (n, unit) => {
  const v = parseFloat(n);
  return unit === "MB" ? v * 1024 : unit === "B" ? v / 1024 : v;
};

const routes = {};
for (const line of text.split("\n")) {
  const m = line.match(
    /^[\s│├└─┌┐┘]*[○●ƒλ◐]\s+(\/\S*)\s+([\d.]+)\s*(B|kB|MB)\s+([\d.]+)\s*(B|kB|MB)/
  );
  if (m) routes[m[1]] = { routeKb: toKb(m[2], m[3]), firstLoadKb: toKb(m[4], m[5]) };
}

let sharedKb = null;
const s = text.match(/First Load JS shared by all\s+([\d.]+)\s*(B|kB|MB)/);
if (s) sharedKb = toKb(s[1], s[2]);

const out = {
  recordedAt: new Date().toISOString(),
  // Absent when SKIP_BUILD reused an old build; the routes map is then empty
  // and that is visible rather than silently zero.
  sharedFirstLoadKb: sharedKb,
  routeCount: Object.keys(routes).length,
  routes,
};
fs.writeFileSync(`perf/${process.env.PREFIX}-bundle.json`, JSON.stringify(out, null, 2) + "\n");
console.log(`    ${out.routeCount} routes, shared ${sharedKb ?? "?"} kB`);
'

echo "==> measuring API at $API -> perf/${PREFIX}-api.json"
{
  printf '{\n'
  printf '  "recordedAt": %s,\n' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  printf '  "apiBase": "%s",\n' "$API"
  printf '  "endpoints": {\n'

  first=1
  for path in "/healthz" "/v1/currencies" "/v1/balances?address=$PROBE_ADDR"; do
    [ $first -eq 1 ] || printf ',\n'
    first=0
    # -s so a failure is quiet; the status code carries the news.
    read -r code bytes secs < <(
      curl -s -o /dev/null \
        -w '%{http_code} %{size_download} %{time_total}\n' \
        --max-time 30 "$API$path" 2>/dev/null || echo "000 0 0"
    )
    # Measured again asking for compression, because `bytes` above does NOT
    # capture it: curl sends no Accept-Encoding unless told to, so a server that
    # gzips everything scores identically to one that gzips nothing. Recorded as
    # a SEPARATE field rather than replacing `bytes`, so an old baseline taken
    # before this existed still compares like-for-like against a new run.
    read -r gzbytes < <(
      curl -s -o /dev/null --compressed \
        -w '%{size_download}\n' \
        --max-time 30 "$API$path" 2>/dev/null || echo "0"
    )
    printf '    "%s": { "status": %s, "bytes": %s, "bytesGzip": %s, "seconds": %s }' \
      "$path" "${code:-0}" "${bytes:-0}" "${gzbytes:-0}" "${secs:-0}"
  done

  printf '\n  }\n}\n'
} > "perf/${PREFIX}-api.json"

node -e '
const f = `perf/${process.env.PREFIX}-api.json`;
const d = JSON.parse(require("fs").readFileSync(f, "utf8"));
for (const [k, v] of Object.entries(d.endpoints)) {
  const note = v.status === 0 ? "  (unreachable)" : v.status >= 400 ? "  (error)" : "";
  const gz =
    v.bytesGzip && v.bytes
      ? `  gzip ${String(v.bytesGzip).padStart(7)} B (${Math.round((1 - v.bytesGzip / v.bytes) * 100)}% off)`
      : "";
  console.log(
    `    ${String(v.status).padEnd(4)} ${String(v.bytes).padStart(8)} B${gz}  ${v.seconds}s  ${k}${note}`,
  );
}
' PREFIX="$PREFIX" 2>/dev/null || true

echo "==> wrote perf/${PREFIX}-bundle.json and perf/${PREFIX}-api.json"
