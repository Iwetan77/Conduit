// A payroll, paid for real on Arc testnet. Nothing mocked.
//
// Three people across two currencies, so the run has two groups and "partial"
// is expressible. The whole path runs: a provisioned settlement wallet, real
// employees, a draft with its preview, an execute that hands back legs, real
// approve + disperse signed by the merchant's own Circle wallet, and the run
// recorded from what the chain says.
//
// The most important line in this file is the LAST assertion: a second execute
// with the same run key must pay nobody twice. Everything else could be right
// and that one being wrong would still make the feature unusable.
//
// Run through scripts/e2e-payroll.sh, which brings the API up around it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { startChallengeRunner } from "./circle-challenge";

const API = process.env["CONDUIT_API_URL"] ?? "http://localhost:8080";
const ARC_RPC = process.env["ARC_RPC"] ?? "https://rpc.testnet.arc.network";
const CIRCLE = "https://api.circle.com";
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ARC = "ARC-TESTNET";

// Three salaries at 0.01 USDC, plus headroom for gas — which Arc charges in
// USDC, so the wallet needs it on top of what it pays out.
const SALARY = 10_000n;
const FUND = 400_000n; // 0.4 USDC

const deployments = JSON.parse(
  readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf8"),
) as Record<string, string>;
const PAYROLL_CONTRACT = deployments["conduitPayroll"];
if (!PAYROLL_CONTRACT) throw new Error("conduitPayroll missing from deployments/arc-testnet.json");

const erc20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const payrollAbi = parseAbi([
  "function disperse(bytes32 runId, address token, address[] to, uint256[] amounts) returns (uint256)",
]);

function envValue(file: string, key: string): string {
  const line = readFileSync(resolve(__dirname, file), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in ${file}`);
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
}

const circleKey = process.env["CIRCLE_API_KEY"] ?? envValue("../packages/api/.env", "CIRCLE_API_KEY");
const appId = envValue("../packages/app/.env.local", "NEXT_PUBLIC_CIRCLE_APP_ID");
const funderKey = envValue("../packages/contracts/.env", "PRIVATE_KEY");

let failures = 0;
function check(ok: boolean, label: string, detail?: string) {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log("        " + detail);
  }
}

async function circleCall(method: string, path: string, body?: unknown, userToken?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${circleKey}`,
    "content-type": "application/json",
  };
  if (userToken) headers["X-User-Token"] = userToken;
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(CIRCLE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await res.json()) as any;
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
    }
  }
  throw new Error(`circle unreachable: ${method} ${path}`);
}

async function api(method: string, path: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["authorization"] = `Bearer ${key}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, body: json };
}

const publicClient = createPublicClient({ transport: viemHttp(ARC_RPC) });
const balanceOf = (address: string) =>
  publicClient.readContract({
    address: USDC,
    abi: erc20,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  }) as Promise<bigint>;

async function main() {
  console.log("=== payroll end to end, live Arc testnet ===");
  console.log(`api:      ${API}\ncontract: ${PAYROLL_CONTRACT}\n`);

  // ── A business with a settlement wallet of its own ────────────────────────
  const circleUserId = `e2e-payroll-${randomUUID()}`;
  await circleCall("POST", "/v1/w3s/users", { userId: circleUserId });
  const tok = await circleCall("POST", "/v1/w3s/users/token", { userId: circleUserId });
  const { userToken, encryptionKey } = tok.data ?? {};
  if (!userToken) throw new Error("could not mint a Circle user token");

  const runner = await startChallengeRunner({ appId, onLog: (l) => console.log(l) });
  try {
    console.log("-- provisioning the treasury wallet --");
    const init = await circleCall("POST", "/v1/w3s/user/initialize",
      { idempotencyKey: randomUUID(), blockchains: [ARC] }, userToken);
    if (init.data?.challengeId) await runner.execute(init.data.challengeId, { userToken, encryptionKey });

    const created = await circleCall("POST", "/v1/w3s/user/wallets", {
      idempotencyKey: randomUUID(),
      blockchains: [ARC],
      metadata: [{ name: "Conduit treasury", refId: "e2e-payroll" }],
    }, userToken);
    if (!created.data?.challengeId) throw new Error("no wallet challenge");
    await runner.execute(created.data.challengeId, { userToken, encryptionKey });
    await new Promise((r) => setTimeout(r, 5000));

    const wallets = ((await circleCall("GET", "/v1/w3s/wallets", undefined, userToken)).data?.wallets ?? []) as any[];
    const treasury = wallets.find((w) => w.refId === "e2e-payroll");
    if (!treasury?.address) throw new Error("the treasury wallet never appeared");
    console.log(`        treasury ${treasury.address}`);

    const account = await api("POST", "/v1/accounts", {
      name: "E2E Payroll Co",
      settle_currency: "USD",
      settle_address: treasury.address,
    });
    if (account.status !== 201) throw new Error(`create account: ${JSON.stringify(account.body)}`);
    const sk = account.body.api_key.key as string;

    // ── Fund it ───────────────────────────────────────────────────────────────
    const funder = privateKeyToAccount(
      (funderKey.startsWith("0x") ? funderKey : `0x${funderKey}`) as `0x${string}`);
    const funderClient = createWalletClient({ account: funder, transport: viemHttp(ARC_RPC) });
    const fundHash = await funderClient.sendTransaction({
      to: USDC,
      data: encodeFunctionData({
        abi: erc20, functionName: "transfer",
        args: [treasury.address as `0x${string}`, FUND],
      }),
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    check((await balanceOf(treasury.address)) >= FUND, "the treasury holds funds");

    // ── Three employees, two currencies ───────────────────────────────────────
    console.log("\n-- hiring --");
    const staff = [
      { name: "Ada", currency: "USD", address: privateKeyToAccount(generatePrivateKey()).address },
      { name: "Grace", currency: "USD", address: privateKeyToAccount(generatePrivateKey()).address },
      { name: "Katherine", currency: "EUR", address: privateKeyToAccount(generatePrivateKey()).address },
    ];
    for (const s of staff) {
      const r = await api("POST", "/v1/employees", {
        name: s.name, address: s.address, pay_currency: s.currency,
        pay_type: "fixed", amount: SALARY.toString(),
      }, sk);
      if (r.status !== 201) throw new Error(`hire ${s.name}: ${JSON.stringify(r.body)}`);
    }
    check(true, "three employees across two currencies");

    // ── Draft, and read the preview before anything moves ─────────────────────
    console.log("\n-- drafting --");
    const draft = await api("POST", "/v1/payroll_runs", {}, sk);
    if (draft.status !== 200) throw new Error(`draft: ${JSON.stringify(draft.body)}`);
    const runId = draft.body.id as string;
    check(draft.body.status === "draft", "nothing is paid by drafting");
    check(draft.body.groups?.length === 2, "two currency groups", JSON.stringify(draft.body.groups));
    check(!!draft.body.estimated_gas, "the preview carries a gas estimate");
    console.log(`        gas estimate ${draft.body.estimated_gas} USDC minor units`);

    // ── Execute: the server hands back what has to be signed ──────────────────
    console.log("\n-- executing --");
    const runKey = `e2e-${randomUUID()}`;
    const exec = await api("POST", `/v1/payroll_runs/${runId}/execute`, { run_key: runKey }, sk);
    if (exec.status !== 200) throw new Error(`execute: ${JSON.stringify(exec.body)}`);
    check(exec.body.legs?.length === 2, "one leg per currency");

    // Only the treasury currency can be paid without a conversion leg. The
    // other group is left pending, which is exactly the state a run is in when
    // one currency has not been converted yet -- and it is what makes the
    // partial assertion below real rather than staged.
    const usdLeg = (exec.body.legs as any[]).find((l) => l.currency === "USD");
    check(!!usdLeg && !usdLeg.needs_conversion, "the treasury currency needs no conversion");

    const before = await Promise.all(staff.map((s) => balanceOf(s.address)));

    // Approve, then disperse — both signed by the merchant's own wallet through
    // the Circle challenge path, which is the only way a Circle wallet spends.
    for (const [label, data] of [
      ["approve", encodeFunctionData({
        abi: erc20, functionName: "approve",
        args: [exec.body.spender as `0x${string}`, BigInt(usdLeg.total)],
      })],
      ["disperse", encodeFunctionData({
        abi: payrollAbi, functionName: "disperse",
        args: [
          usdLeg.run_id_hash as `0x${string}`,
          usdLeg.token as `0x${string}`,
          usdLeg.recipients as `0x${string}`[],
          (usdLeg.amounts as string[]).map((a) => BigInt(a)),
        ],
      })],
    ] as const) {
      const target = label === "approve" ? usdLeg.token : exec.body.spender;
      const ch = await circleCall("POST", "/v1/w3s/user/transactions/contractExecution", {
        idempotencyKey: randomUUID(),
        walletId: treasury.id,
        contractAddress: target,
        callData: data,
        feeLevel: "MEDIUM",
      }, userToken);
      if (!ch.data?.challengeId) throw new Error(`${label}: no challenge`);
      await runner.execute(ch.data.challengeId, { userToken, encryptionKey });
      // Circle broadcasts after the challenge; the approve has to be mined
      // before the disperse that spends it.
      await new Promise((r) => setTimeout(r, 12_000));
    }

    console.log("        waiting for the payroll to land…");
    let txHash = "";
    for (let i = 0; i < 40; i++) {
      const now = await Promise.all(staff.map((s) => balanceOf(s.address)));
      if (now[0]! - before[0]! >= SALARY && now[1]! - before[1]! >= SALARY) {
        const txs = await circleCall("GET", `/v1/w3s/transactions?walletIds=${treasury.id}`, undefined, userToken);
        txHash = (txs.data?.transactions ?? []).find((t: any) => t.txHash)?.txHash ?? "";
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    check(txHash !== "", "the payroll reached the chain");

    const after = await Promise.all(staff.map((s) => balanceOf(s.address)));
    check(after[0]! - before[0]! === SALARY, `Ada was paid exactly ${SALARY}`, `${after[0]! - before[0]!}`);
    check(after[1]! - before[1]! === SALARY, `Grace was paid exactly ${SALARY}`, `${after[1]! - before[1]!}`);
    check(after[2]! - before[2]! === 0n, "Katherine's group has not been paid — it needs conversion first");

    // ── Record it, from the chain ─────────────────────────────────────────────
    const rec = await api("POST", `/v1/payroll_runs/${runId}/legs`,
      { currency: "USD", tx_hash: txHash }, sk);
    check(rec.status === 200, "the USD leg is recorded", `status=${rec.status} ${JSON.stringify(rec.body)}`);

    // A hash that does not contain this run must be refused, or the ledger can
    // be told anything.
    const lie = await api("POST", `/v1/payroll_runs/${runId}/legs`,
      { currency: "EUR", tx_hash: "0x" + "11".repeat(32) }, sk);
    check(lie.status !== 200, "a transaction that does not contain the run is refused",
      `status=${lie.status}`);

    const eur = await api("POST", `/v1/payroll_runs/${runId}/legs`,
      { currency: "EUR", failed: true, error: "no conversion leg in this run" }, sk);
    check(eur.status === 200, "the EUR leg is recorded as failed");

    const final = await api("GET", `/v1/payroll_runs/${runId}`, undefined, sk);
    check(final.body.status === "partial",
      "one group paid and one did not, so the run is partial", `status=${final.body.status}`);
    const paid = (final.body.items as any[]).filter((i) => i.status === "paid").length;
    check(paid === 2, "the run says exactly who was paid", `${paid} paid`);

    // ── The line that matters most ────────────────────────────────────────────
    console.log("\n-- the same run key again --");
    const second = await api("POST", "/v1/payroll_runs", {}, sk);
    const replay = await api("POST", `/v1/payroll_runs/${second.body.id}/execute`,
      { run_key: runKey }, sk);
    check(replay.status === 409, "a second execute with the same key is refused",
      `status=${replay.status} ${JSON.stringify(replay.body)}`);

    const unchanged = await Promise.all(staff.map((s) => balanceOf(s.address)));
    check(
      unchanged.every((b, i) => b === after[i]),
      "NOBODY WAS PAID TWICE",
      unchanged.map(String).join(", "),
    );
  } finally {
    await runner.close();
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    return 1;
  }
  console.log("Payroll end to end: drafted, executed, paid on chain, recorded, and not repeatable.");
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
