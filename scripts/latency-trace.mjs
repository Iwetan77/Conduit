#!/usr/bin/env node
// Phase B0 — where the seconds actually go.
//
// Nothing in Track B may be changed until the current cost is written down.
// `scripts/perf-baseline.sh` measures bundle size and three endpoints, which is
// not what is slow: cross-stable settlement measures 22s on one device and 29s
// on another, and that gap between two people running the same code is the tell
// — it is not one slow step, it is a stack of round trips whose cost scales
// with network distance.
//
// So this times ONE REAL PAYMENT OF EACH KIND, span by span, against the
// DEPLOYED API. Real network, real Circle sandbox, real Arc transactions, no
// mocks. Every diagnosis in the work order is a hypothesis; this is what turns
// one of them into a fact, and the order says plainly that if the trace
// disagrees with the document, the trace wins.
//
// Usage:
//   node scripts/latency-trace.mjs --prefix=before
//   node scripts/latency-trace.mjs --prefix=before --cold
//   node scripts/latency-trace.mjs --prefix=before --only=same,payroll
//
// Writes perf/latency-<prefix>.json.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ethers } = await import(
  join(ROOT, "packages", "app", "node_modules", "ethers", "lib.commonjs", "index.js")
);

// ── Configuration ───────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const PREFIX = args.prefix ?? "run";
// The DEPLOYED API, not localhost. Measuring localhost would answer a question
// nobody has: the payer is in Lagos and the API is in Oregon, and the distance
// between them is one of the things under suspicion.
const API = (process.env.CONDUIT_API_URL ?? "https://conduit-z56x.onrender.com").replace(/\/$/, "");
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const ONLY = typeof args.only === "string" ? args.only.split(",") : ["same", "cross", "payroll"];

const deployments = JSON.parse(readFileSync(join(ROOT, "deployments", "arc-testnet.json"), "utf8"));
const ROUTER = deployments.conduitRouter;
const PAYROLL = deployments.conduitPayroll;
const USDC = deployments.usdc;
const EURC = deployments.eurc;

const keyFile = process.env.TRACE_PAYER_KEY_FILE ?? join(homedir(), ".conduit-keys", "e2e-payer.key");
if (!existsSync(keyFile)) {
  console.error(`no payer key at ${keyFile}`);
  console.error("generate one with: node ~/.conduit-keys/new-key.mjs e2e-payer");
  process.exit(1);
}
const PAYER_KEY = readFileSync(keyFile, "utf8").trim();

// ── Span recording ──────────────────────────────────────────────────────────
//
// Every span is a real measured duration. A span that did not happen is absent
// rather than zero: a zero in this file would be read as "instant" by anybody
// comparing two runs, which is the opposite of "we did not measure it".

const spans = [];
let runStartedAt;

async function span(name, fn, meta) {
  const startedAt = Date.now();
  const t0 = performance.now();
  try {
    const value = await fn();
    const ms = Math.round(performance.now() - t0);
    spans.push({ name, ms, startedAt: new Date(startedAt).toISOString(), ...(meta ?? {}) });
    return value;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    spans.push({
      name,
      ms,
      startedAt: new Date(startedAt).toISOString(),
      failed: true,
      error: String(err?.message ?? err).slice(0, 300),
      ...(meta ?? {}),
    });
    throw err;
  }
}

/** Record a duration measured some other way (a poll loop, a sub-step). */
function record(name, ms, meta) {
  spans.push({ name, ms: Math.round(ms), ...(meta ?? {}) });
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function api(path, { method = "GET", body, key } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path}: non-JSON (${res.status}) ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`);
  return json;
}

// ── Providers ───────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
// Untuned by DEFAULT, on purpose: the baseline has to measure what a payer
// experiences today, and ethers' 4000ms polling is the thing under suspicion.
// Setting it unconditionally would hide the very cost this exists to expose.
//
// --polling=<ms> opts in, so the same script can measure the app AFTER Phase
// B2 tuned it — the app sets 500ms in lib/arc-provider, and an "after" trace
// still polling at 4000 would report no improvement that a user will see.
if (args.polling) provider.pollingInterval = Number(args.polling);
const payer = new ethers.Wallet(PAYER_KEY, provider);

const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ROUTER_ABI = [
  "function execute((address payer,address recipient,address payerToken,address recipientToken,uint256 amount,uint256 deadline,bytes32 declarationId)) returns (bytes32)",
];
const PAYROLL_ABI = [
  "function disperse(bytes32,address,address[],uint256[]) returns (uint256)",
];

// ── The floor ───────────────────────────────────────────────────────────────

/**
 * What one round trip to the API costs when the API does nothing.
 *
 * The single most useful number here. /healthz performs no work, so its
 * duration IS the floor — TLS plus distance — under every other API span
 * below. If a payment makes three sequential calls, it has already spent three
 * of these before any work happens, and no amount of optimising the handlers
 * recovers that.
 */
async function measureFloor() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await fetch(`${API}/healthz`);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  record("floor.healthz_median", median, {
    samples: samples.map((s) => Math.round(s)),
    note: "API round-trip floor: /healthz does no work, so this is TLS + distance alone",
  });
  return median;
}

/** The same, for the chain. Every browser read pays this. */
async function measureRpcFloor() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    // NOT getBlockNumber: ethers caches it for ~4s, so five calls in a row
    // measured the cache and reported 0ms. An eth_call against a real contract
    // is not cached and is what every balance read actually costs.
    await provider.call({ to: USDC, data: "0x70a08231" + payer.address.slice(2).padStart(64, "0") });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  record("floor.arc_rpc_median", samples[Math.floor(samples.length / 2)], {
    samples: samples.map((s) => Math.round(s)),
    note: "Arc RPC round-trip floor, measured directly rather than proxied",
  });
}

// ── Account ─────────────────────────────────────────────────────────────────

async function createAccount() {
  return span("setup.create_account", () =>
    api("/v1/accounts", {
      method: "POST",
      body: {
        name: `Latency Trace ${new Date().toISOString()}`,
        settle_currency: "USDC",
        settle_address: payer.address,
      },
    }),
  );
}

// ── Same-currency ───────────────────────────────────────────────────────────

async function traceSameCurrency(key) {
  const amount = 100000n; // 0.10 USDC — small enough to repeat, real enough to settle

  const intent = await span("same.create_intent", () =>
    api("/v1/settlement_intents", {
      method: "POST",
      key,
      body: { amount: amount.toString(), settle_currency: "USD", reference: "latency-trace" },
    }),
  );

  const signer = await span("same.get_signer", async () => payer);
  const usdc = new ethers.Contract(USDC, ERC20, signer);

  const allowance = await span("same.allowance_read", () => usdc.allowance(payer.address, ROUTER));

  if (allowance < amount) {
    const tx = await span("same.approve_broadcast", () => usdc.approve(ROUTER, amount));
    await span("same.approve_receipt", () => tx.wait(), {
      note: "ethers polls at its 4000ms default; Phase B2 is about this number",
    });
  } else {
    record("same.approve_skipped", 0, { note: "allowance already sufficient" });
  }

  const router = new ethers.Contract(ROUTER, ROUTER_ABI, signer);
  const instruction = {
    payer: payer.address,
    recipient: payer.address,
    payerToken: USDC,
    recipientToken: USDC,
    amount,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    declarationId: ethers.ZeroHash,
  };

  const execTx = await span("same.execute_broadcast", () => router.execute(instruction));
  const receipt = await span("same.execute_receipt", () => execTx.wait());

  await span("same.post_record", () =>
    api(`/v1/settlement_intents/${intent.id}/record`, {
      method: "POST",
      key,
      body: { tx_hash: receipt.hash },
    }),
  ).catch((e) => record("same.post_record_failed", 0, { error: String(e.message).slice(0, 200) }));

  return receipt.hash;
}

// ── Cross-stable ────────────────────────────────────────────────────────────

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

async function traceCrossStable(key) {
  const usdc = new ethers.Contract(USDC, ERC20, payer);

  const permitAllowance = await span("cross.permit2_allowance_read", () =>
    usdc.allowance(payer.address, PERMIT2),
  );
  if (permitAllowance < 10n ** 12n) {
    const tx = await span("cross.permit2_approve_broadcast", () =>
      usdc.approve(PERMIT2, ethers.MaxUint256),
    );
    await span("cross.permit2_approve_receipt", () => tx.wait());
  } else {
    record("cross.permit2_approve_skipped", 0, { note: "already approved" });
  }

  const intent = await span("cross.create_intent", () =>
    api("/v1/settlement_intents", {
      method: "POST",
      key,
      body: { amount: "2000000", settle_currency: "EUR", reference: "latency-trace-fx" },
    }),
  );

  // The quote is where the API talks to Circle. Its total is measured here; the
  // split between browser→API and API→Circle is inferred from the floor above,
  // because the API does not report its own upstream timing.
  const quote = await span("cross.post_quote", () =>
    api(`/v1/settlement_intents/${intent.id}/quote`, {
      method: "POST",
      key,
      body: { pay_currency: "USDC" },
    }),
  );

  await span("cross.balance_read", () => usdc.balanceOf(payer.address));

  // "Signature 1 (human)" in the work order. Signed with a key here, so this
  // span is the CRYPTOGRAPHY only — a real payer adds however long it takes to
  // read a wallet prompt, which is exactly why the quote's ~3.5s TTL is tight.
  const sig1 = await span("cross.sign_quote", async () => {
    const td = quote.typed_data;
    return payer.signTypedData(td.domain, stripEIP712Domain(td.types), td.message);
  }, { note: "key-signed; a human wallet prompt adds seconds on top" });

  const prepare = await span("cross.post_prepare", () =>
    api(`/v1/settlement_intents/${intent.id}/prepare`, {
      method: "POST",
      key,
      body: { quote_message: quote.typed_data.message, quote_signature: sig1 },
    }),
    { note: "server-side: trade POST + contractTradeId poll + presign POST" },
  );

  const sig2 = await span("cross.sign_funding", async () => {
    const td = prepare.funding_typed_data;
    return payer.signTypedData(td.domain, stripEIP712Domain(td.types), td.message);
  });

  // The span this whole phase is about. Confirm holds the socket while the API
  // polls Circle to completion — up to 60s against a 30s server WriteTimeout.
  const confirm = await span("cross.post_confirm", () =>
    api(`/v1/settlement_intents/${intent.id}/confirm`, {
      method: "POST",
      key,
      body: { funding_signature: sig2 },
    }),
    { note: "browser-visible wait: fund POST + status polling + makerDeliver" },
  );

  return confirm.tx_hash;
}

/** ethers derives EIP712Domain itself and rejects it being supplied. */
function stripEIP712Domain(types) {
  const out = { ...types };
  delete out.EIP712Domain;
  return out;
}

// ── Payroll leg ─────────────────────────────────────────────────────────────

async function tracePayrollLeg(key) {
  const employee = await span("payroll.add_employee", () =>
    api("/v1/employees", {
      method: "POST",
      key,
      body: {
        name: "Latency Trace Employee",
        address: ethers.Wallet.createRandom().address,
        pay_currency: "USD",
        pay_type: "fixed",
        amount: "100000",
      },
    }),
  );

  const run = await span("payroll.create_run", () =>
    api("/v1/payroll_runs", { method: "POST", key, body: { employee_ids: [employee.id] } }),
  );

  const exec = await span("payroll.post_execute", () =>
    api(`/v1/payroll_runs/${run.id}/execute`, {
      method: "POST",
      key,
      body: { run_key: `trace-${Date.now()}` },
    }),
  );

  const leg = exec.legs?.[0];
  if (!leg) throw new Error("execute returned no legs");

  const token = new ethers.Contract(leg.token, ERC20, payer);
  const approveTx = await span("payroll.approve_broadcast", () =>
    token.approve(exec.spender, BigInt(leg.total)),
  );
  await span("payroll.approve_receipt", () => approveTx.wait());

  const payroll = new ethers.Contract(exec.spender, PAYROLL_ABI, payer);
  const disperseTx = await span("payroll.disperse_broadcast", () =>
    payroll.disperse(leg.run_id_hash, leg.token, leg.recipients, leg.amounts.map(BigInt)),
  );
  const receipt = await span("payroll.disperse_receipt", () => disperseTx.wait());

  await span("payroll.post_legs", () =>
    api(`/v1/payroll_runs/${run.id}/legs`, {
      method: "POST",
      key,
      body: { currency: leg.currency, tx_hash: receipt.hash },
    }),
  );

  return receipt.hash;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (args.cold) {
    // Render spins an idle instance down. Averaging a cold start into the
    // warm numbers hides both, so it is measured deliberately or not at all.
    const wait = Number(process.env.COLD_WAIT_SECONDS ?? 960);
    console.error(`--cold: sleeping ${wait}s past the spin-down window…`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    const t0 = performance.now();
    await fetch(`${API}/healthz`);
    record("cold.first_request", performance.now() - t0, {
      note: "first request after the instance was allowed to spin down",
    });
  }

  runStartedAt = new Date().toISOString();
  console.error(`API:   ${API}`);
  console.error(`RPC:   ${RPC}`);
  console.error(`payer: ${payer.address}`);
  console.error("");

  await measureFloor();
  await measureRpcFloor();

  const account = await createAccount();
  const key = account.api_key.key;

  for (const kind of ONLY) {
    try {
      if (kind === "same") {
        console.error("tracing same-currency…");
        await traceSameCurrency(key);
      } else if (kind === "cross") {
        console.error("tracing cross-stable…");
        await traceCrossStable(key);
      } else if (kind === "payroll") {
        console.error("tracing payroll leg…");
        await tracePayrollLeg(key);
      }
    } catch (err) {
      // Recorded, not swallowed, and not fatal: a cross-stable failure must not
      // cost the same-currency numbers that already succeeded.
      console.error(`  ${kind} FAILED: ${err.message}`);
      record(`${kind}.aborted`, 0, { error: String(err.message).slice(0, 300) });
    }
  }

  const out = {
    prefix: PREFIX,
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    api: API,
    rpc: RPC,
    router: ROUTER,
    payer: payer.address,
    cold: !!args.cold,
    spans,
  };

  mkdirSync(join(ROOT, "perf"), { recursive: true });
  const path = join(ROOT, "perf", `latency-${PREFIX}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");

  console.error("");
  for (const s of spans) {
    console.error(
      `${String(s.ms).padStart(7)}ms  ${s.name}${s.failed ? "  [FAILED]" : ""}`,
    );
  }
  console.error(`\nwrote ${path}`);

  if (spans.some((s) => s.failed)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
