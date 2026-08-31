// End-to-end withdrawal, against a live Arc testnet. Nothing mocked.
//
// The claim this has to establish is narrow and expensive to get wrong: money
// leaves a business's settlement wallet, arrives at an address that business
// proved it controls, and does not leave for one it has not.
//
// So the run does the whole path for real —
//
//   1. provision a settlement wallet through Circle (a real challenge, executed
//      in a real browser, because that is the only way one can be created)
//   2. fund it on Arc from the e2e wallet
//   3. add a payout destination and prove control of it with a real signature
//   4. withdraw through the API, executing the transfer as the merchant would
//   5. read both balances off chain and check they moved by the right amounts
//
// and separately proves the refusal: an UNVERIFIED destination cannot be
// withdrawn to. That assertion is not a footnote — an address nobody proved is
// indistinguishable from a typo, and the transfer is final.
//
// Run through scripts/e2e-payout.sh, which brings up the API first.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createWalletClient, createPublicClient, http as viemHttp, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { startChallengeRunner } from "./circle-challenge";

const API = process.env["CONDUIT_API_URL"] ?? "http://localhost:8080";
const ARC_RPC = process.env["ARC_RPC"] ?? "https://rpc.testnet.arc.network";
const CIRCLE = "https://api.circle.com";
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ARC = "ARC-TESTNET";

// Small on purpose. This runs against a real funded wallet and there is no
// reason for a correctness test to move meaningful value.
const FUND = 3_000_000n; // 3 USDC — the withdrawal plus gas, which Arc charges in USDC
const WITHDRAW = 1_000_000n; // 1 USDC

const erc20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

function envValue(file: string, key: string): string {
  const path = resolve(__dirname, file);
  const line = readFileSync(path, "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
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
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(CIRCLE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await res.json()) as any;
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
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

async function usdcBalance(address: string): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDC,
    abi: erc20,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  })) as bigint;
}

async function main() {
  console.log("=== end-to-end payout, live Arc testnet ===");
  console.log(`api: ${API}\nrpc: ${ARC_RPC}\n`);

  // ── A merchant, with a Circle identity ────────────────────────────────────
  //
  // PIN mode, because an SSO user's token cannot be minted from an API key at
  // all (docs/circle-wallet-capability.md) and a script has no browser to sign
  // in with Google. The wallet operations are identical either way.
  const circleUserId = `e2e-payout-${randomUUID()}`;
  await circleCall("POST", "/v1/w3s/users", { userId: circleUserId });
  const tok = await circleCall("POST", "/v1/w3s/users/token", { userId: circleUserId });
  const { userToken, encryptionKey } = tok.data ?? {};
  if (!userToken) throw new Error("could not mint a Circle user token");

  const runner = await startChallengeRunner({ appId, onLog: (l) => console.log(l) });
  try {
    console.log("-- provisioning a settlement wallet --");
    const init = await circleCall(
      "POST",
      "/v1/w3s/user/initialize",
      { idempotencyKey: randomUUID(), blockchains: [ARC] },
      userToken,
    );
    if (init.data?.challengeId) {
      await runner.execute(init.data.challengeId, { userToken, encryptionKey });
    }
    // The SECOND wallet is the settlement wallet -- the first is the one the
    // merchant signs in with, and the whole point is that they are not the same.
    const created = await circleCall(
      "POST",
      "/v1/w3s/user/wallets",
      {
        idempotencyKey: randomUUID(),
        blockchains: [ARC],
        metadata: [{ name: "Conduit settlement", refId: "e2e-payout" }],
      },
      userToken,
    );
    if (!created.data?.challengeId) throw new Error(`no challenge for the settlement wallet: ${JSON.stringify(created)}`);
    await runner.execute(created.data.challengeId, { userToken, encryptionKey });
    await new Promise((r) => setTimeout(r, 5000));

    const wallets = ((await circleCall("GET", "/v1/w3s/wallets", undefined, userToken)).data?.wallets ??
      []) as any[];
    const settlement = wallets.find((w) => w.refId === "e2e-payout");
    const signIn = wallets.find((w) => w.blockchain === ARC && w.id !== settlement?.id);
    if (!settlement?.address) throw new Error("the settlement wallet never appeared");
    check(
      settlement.address.toLowerCase() !== signIn?.address?.toLowerCase(),
      "the settlement wallet is not the sign-in wallet",
      `${settlement.address} vs ${signIn?.address}`,
    );
    console.log(`        settlement wallet ${settlement.address}`);

    // ── An account on the API, bound to that Circle identity ────────────────
    const account = await api("POST", "/v1/accounts", {
      name: "E2E Payout Co",
      settle_currency: "USD",
      settle_address: settlement.address,
    });
    if (account.status !== 201) throw new Error(`create account: ${JSON.stringify(account.body)}`);
    const sk = account.body.api_key.key as string;

    // ── Fund it on chain ────────────────────────────────────────────────────
    //
    // The gate asks for a payment settled INTO the wallet. A direct transfer is
    // the same fact for this test's purposes -- what the withdrawal needs is a
    // balance, and how it arrived is proven by scripts/e2e.sh, not here.
    console.log("\n-- funding the settlement wallet --");
    const funder = privateKeyToAccount(
      (funderKey.startsWith("0x") ? funderKey : `0x${funderKey}`) as `0x${string}`,
    );
    const funderClient = createWalletClient({ account: funder, transport: viemHttp(ARC_RPC) });
    const fundHash = await funderClient.sendTransaction({
      to: USDC,
      data: encodeFunctionData({
        abi: erc20,
        functionName: "transfer",
        args: [settlement.address as `0x${string}`, FUND],
      }),
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    const funded = await usdcBalance(settlement.address);
    check(funded >= FUND, "the settlement wallet holds funds", `balance ${funded}`);

    // ── A destination, and the refusal before it is proven ──────────────────
    console.log("\n-- payout destination --");
    const destKey = generatePrivateKey();
    const dest = privateKeyToAccount(destKey);

    const addedResp = await api("POST", "/v1/payout_destinations", { address: dest.address, label: "Treasury" }, sk);
    if (addedResp.status !== 201) throw new Error(`add destination: ${JSON.stringify(addedResp.body)}`);
    const destinationId = addedResp.body.id as string;
    check(addedResp.body.verified === false, "a new destination is unverified");

    // THE refusal. An unproven address is indistinguishable from a typo and the
    // transfer is final, so this must not be possible.
    const refused = await api(
      "POST",
      "/v1/payouts",
      { destination_id: destinationId, currency: "USD", amount: WITHDRAW.toString() },
      sk,
    );
    check(
      refused.status === 409 && refused.body?.error?.code === "payout_destination_unverified",
      "withdrawing to an UNVERIFIED destination is refused",
      `status=${refused.status} body=${JSON.stringify(refused.body)}`,
    );

    const challenge = await api("POST", `/v1/payout_destinations/${destinationId}/challenge`, {}, sk);
    const signature = await dest.signMessage({ message: challenge.body.message as string });
    const verified = await api("POST", `/v1/payout_destinations/${destinationId}/verify`, { signature }, sk);
    check(verified.status === 200 && verified.body.verified === true, "control of the destination is proven");

    // ── The withdrawal ──────────────────────────────────────────────────────
    console.log("\n-- withdrawing --");
    const beforeFrom = await usdcBalance(settlement.address);
    const beforeTo = await usdcBalance(dest.address);

    const payout = await api(
      "POST",
      "/v1/payouts",
      { destination_id: destinationId, currency: "USD", amount: WITHDRAW.toString() },
      sk,
    );
    if (payout.status !== 201) throw new Error(`authorise payout: ${JSON.stringify(payout.body)}`);
    check(payout.body.status === "pending", "authorising moves nothing yet");
    check(
      payout.body.transfer?.to?.toLowerCase() === dest.address.toLowerCase(),
      "the server chose the recipient, not the caller",
    );

    // The merchant's own wallet signs it, through the same Circle path the send
    // page uses. This is the step no server can do on their behalf.
    const exec = await circleCall(
      "POST",
      "/v1/w3s/user/transactions/contractExecution",
      {
        idempotencyKey: randomUUID(),
        walletId: settlement.id,
        contractAddress: payout.body.transfer.token,
        callData: encodeFunctionData({
          abi: erc20,
          functionName: "transfer",
          args: [payout.body.transfer.to as `0x${string}`, BigInt(payout.body.transfer.amount)],
        }),
        feeLevel: "MEDIUM",
      },
      userToken,
    );
    if (!exec.data?.challengeId) throw new Error(`no execution challenge: ${JSON.stringify(exec)}`);
    await runner.execute(exec.data.challengeId, { userToken, encryptionKey });

    // Circle broadcasts after the challenge; wait for the transfer to land.
    console.log("        waiting for the transfer to land…");
    let txHash = "";
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const now = await usdcBalance(dest.address);
      if (now - beforeTo >= WITHDRAW) {
        const txs = await circleCall(
          "GET",
          `/v1/w3s/transactions?walletIds=${settlement.id}`,
          undefined,
          userToken,
        );
        txHash =
          (txs.data?.transactions ?? []).find((t: any) => t.txHash)?.txHash ?? "";
        break;
      }
    }
    check(txHash !== "", "the transfer reached the chain", "no transaction hash appeared in 2 minutes");

    // ── The ledger, from what the chain says ────────────────────────────────
    const confirmed = await api("POST", `/v1/payouts/${payout.body.id}/confirm`, { tx_hash: txHash }, sk);
    check(
      confirmed.status === 200 && confirmed.body.status === "paid",
      "the payout is recorded as paid",
      `status=${confirmed.status} body=${JSON.stringify(confirmed.body)}`,
    );

    // ── Balances, read off chain ────────────────────────────────────────────
    const afterFrom = await usdcBalance(settlement.address);
    const afterTo = await usdcBalance(dest.address);

    check(
      afterTo - beforeTo === WITHDRAW,
      "the destination's balance rose by exactly the amount",
      `rose by ${afterTo - beforeTo}, expected ${WITHDRAW}`,
    );
    // Amount PLUS gas: Arc charges gas in USDC, so the sender loses more than
    // it sent. Asserting "more than" rather than an exact figure, because the
    // gas price is not ours to predict.
    const spent = beforeFrom - afterFrom;
    check(
      spent > WITHDRAW,
      "the settlement wallet fell by the amount plus gas",
      `fell by ${spent}, expected more than ${WITHDRAW}`,
    );
    console.log(`        gas cost ${spent - WITHDRAW} (USDC minor units)`);
  } finally {
    await runner.close();
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    return 1;
  }
  console.log("Payout end to end: authorised, signed by the merchant, landed on chain, recorded.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
