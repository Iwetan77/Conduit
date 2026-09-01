#!/usr/bin/env node
// Phase A0 — what is ACTUALLY deployed, read from the chain.
//
// Every number in docs/onchain-state.md comes from a real eth_call against Arc
// testnet. Nothing here reads deployments/arc-testnet.json for a fact it can
// ask the chain for; that file is used only for the ADDRESSES to interrogate,
// and where it makes a claim (the deployer, the owner) this script confirms or
// refutes it rather than repeating it.
//
// The reason that distinction matters: the remediation plan this feeds is about
// to delete functions and redeploy a router. Both decisions turn on facts —
// who owns what, whether a preference registry was ever wired up, whether fees
// are stranded, whether a forged settlement has already happened — that the
// repository asserts and has never verified. A plan built on a stale JSON file
// is a plan built on nothing.
//
// No mocks, and no fallbacks that invent a value. A call that fails is recorded
// as a failure and the script exits non-zero, because "unknown" in this document
// is the one outcome that must not be quietly rendered as an answer.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const OUT = join(ROOT, "docs", "onchain-state.md");

const deployments = JSON.parse(
  readFileSync(join(ROOT, "deployments", "arc-testnet.json"), "utf8"),
);

// ── JSON-RPC ────────────────────────────────────────────────────────────────

let rpcId = 0;
const failures = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Arc's public RPC rate-limits hard, and the full-history log scan below is a
// couple of hundred requests. A 429 is back-pressure, not an answer, so it is
// retried rather than recorded as "could not be read" -- reporting an unknown
// because we asked too fast would be the audit lying about the chain.
async function rpc(method, params, attempt = 0) {
  let res;
  try {
    res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
  } catch (err) {
    // fetch THROWS on a dropped connection or DNS blip -- it does not come back
    // as a status. Over a two-minute serial scan that will happen, and it is
    // the same kind of event as a 429: transport, not an answer about the
    // chain. It has to be retried here or a single dropped socket reports
    // itself as "we could not determine whether a settlement was forged".
    if (attempt >= 8) throw err;
    await sleep(500 * 2 ** attempt);
    return rpc(method, params, attempt + 1);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 8) throw new Error(`${method}: HTTP ${res.status} after ${attempt} retries`);
    await sleep(500 * 2 ** attempt);
    return rpc(method, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) {
    // Same treatment for a rate limit expressed as a JSON-RPC error rather
    // than an HTTP status, which this node does inconsistently.
    if (/rate|limit|too many/i.test(json.error.message ?? "") && attempt < 8) {
      await sleep(500 * 2 ** attempt);
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${json.error.message}`);
  }
  return json.result;
}

// A call that reverts is a FACT, not an error: "this function does not exist on
// the deployed bytecode" is exactly what the audit is here to discover. It is
// recorded as `reverted` and does not fail the run. A transport failure does.
async function call(to, data, label) {
  try {
    return await rpc("eth_call", [{ to, data }, "latest"]);
  } catch (err) {
    if (/execution reverted|invalid opcode|out of gas/i.test(err.message)) {
      return null;
    }
    failures.push(`${label}: ${err.message}`);
    return undefined;
  }
}

// ── ABI ─────────────────────────────────────────────────────────────────────
//
// Selectors and the event topic are COMPUTED, never written down. An audit that
// hardcodes a 4-byte selector and gets one wrong reports "reverted" for a
// function that exists, or silently reads the wrong slot — and this document's
// entire value is that it can be trusted about production. ethers resolves from
// packages/app, which is where the repo already keeps it.

const { ethers } = await import(
  join(ROOT, "packages", "app", "node_modules", "ethers", "lib.commonjs", "index.js")
);

const iface = new ethers.Interface([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function protocolFeeBps() view returns (uint256)",
  "function atomicSettler() view returns (address)",
  "function settlementPreferenceRegistry() view returns (address)",
  "function declarationRegistry() view returns (address)",
  "function allCodes() view returns (bytes3[])",
  "function balanceOf(address) view returns (uint256)",
  "function accumulatedFees(address) view returns (uint256)",
  "function authorizedRouters(address) view returns (bool)",
  "function authorizedCallers(address) view returns (bool)",
  "event PaymentSettled(bytes32 indexed receiptId, address indexed payer, address indexed recipient, address payerToken, address recipientToken, uint256 payerAmount, uint256 recipientAmount, bytes32 declarationId, uint256 settledAt)",
]);

const enc = (fn, args = []) => iface.encodeFunctionData(fn, args);
const dec = (fn, data) =>
  data === null || data === undefined || data === "0x"
    ? null
    : iface.decodeFunctionResult(fn, data)[0];

const TOPIC_PAYMENT_SETTLED = iface.getEvent("PaymentSettled").topicHash;

// The two functions that emit PaymentSettled, with their REAL signatures.
//
// PaymentInstruction has SEVEN fields (interfaces/IConduitRouter.sol). An
// earlier version of this file invented an eighth, `maxPayerAmount`, so every
// selector it computed was wrong, every settlement came back "unrecognised" —
// and the summary underneath still printed "no forged settlement has occurred",
// because it only counted positive matches for the forgery path and treated
// everything it could not read as fine. That is the one way this document could
// do harm, and it is fixed in both places: the signatures are right, and an
// unclassified row now fails the gate instead of being reassured over.
const iface2 = new ethers.Interface([
  "function execute((address payer,address recipient,address payerToken,address recipientToken,uint256 amount,uint256 deadline,bytes32 declarationId) instruction) returns (bytes32)",
  "function executeWithFX((address payer,address recipient,address payerToken,address recipientToken,uint256 amount,uint256 deadline,bytes32 declarationId) instruction,((address,uint256) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,bytes32 witness,string witnessTypeString,bytes fundingSignature) returns (bytes32)",
]);

// ── The report ──────────────────────────────────────────────────────────────

const lines = [];
const say = (s = "") => lines.push(s);

async function codeSize(addr) {
  const code = await rpc("eth_getCode", [addr, "latest"]);
  return code && code !== "0x" ? (code.length - 2) / 2 : 0;
}

/** An address is an EOA or a contract, and which one decides the whole plan. */
async function describeAccount(addr) {
  if (!addr || /^0x0{40}$/.test(addr)) return "the zero address";
  const size = await codeSize(addr);
  return size > 0 ? `a CONTRACT (${size} bytes of code)` : "an EOA (no code)";
}

async function ownership(name, addr) {
  const ownerRaw = await call(addr, enc("owner"), `${name}.owner()`);
  const pendingRaw = await call(addr, enc("pendingOwner"), `${name}.pendingOwner()`);
  const owner = dec("owner", ownerRaw);
  const pending = dec("pendingOwner", pendingRaw);
  return {
    owner,
    pending,
    ownerKind: owner ? await describeAccount(owner) : "no owner() — not Ownable",
  };
}

async function main() {
  const chainId = BigInt(await rpc("eth_chainId", []));
  const block = BigInt(await rpc("eth_blockNumber", []));

  say("# Arc testnet — what is actually deployed");
  say();
  say("Generated by `scripts/onchain-audit.mjs`. Every value below is a real");
  say("`eth_call` against Arc testnet, not a reading of");
  say("`deployments/arc-testnet.json`. Where that file makes a claim, this");
  say("document confirms or refutes it.");
  say();
  say(`- RPC: \`${RPC}\``);
  say(`- Chain id: \`${chainId}\` (deployments file says \`${deployments.chainId}\`)`);
  say(`- Block at audit: \`${block}\``);
  say(`- Generated: ${new Date().toISOString()}`);
  say();

  // ── Ownership ─────────────────────────────────────────────────────────────
  say("## Ownership");
  say();
  say("`ConduitRouter.sol`'s header claims protocol params are owned by a");
  say("2-of-3 multisig. A multisig is a contract; an EOA is a single key. The");
  say("`Kind` column is what settles that claim.");
  say();
  say("| Contract | Address | owner() | Kind | pendingOwner() |");
  say("|---|---|---|---|---|");

  // Only what the deployments file still names. AtomicSettler and
  // StableFXAdapter were deleted in Phases A1 and A3 and their keys removed --
  // but the OLD instances are still deployed on chain until A6 abandons the
  // router, so an operator auditing a pre-A6 deployment still wants them.
  // Filtered rather than hardcoded, so this reports what is actually tracked.
  const owned = Object.fromEntries(
    [
      ["ConduitRouter", deployments.conduitRouter],
      ["AtomicSettler", deployments.atomicSettler],
      ["StableFXAdapter", deployments.stableFXAdapter],
      ["DeclarationRegistry", deployments.declarationRegistry],
      ["CurrencyRegistry", deployments.currencyRegistry],
      ["SettlementPreferenceRegistry", deployments.settlementPreferenceRegistry],
    ].filter(([, addr]) => !!addr),
  );
  const owners = {};
  for (const [name, addr] of Object.entries(owned)) {
    const o = await ownership(name, addr);
    owners[name] = o;
    say(
      `| ${name} | \`${addr}\` | ${o.owner ? "`" + o.owner + "`" : "—"} | ${o.ownerKind} | ${
        o.pending ? "`" + o.pending + "`" : "`0x0` (none pending)"
      } |`,
    );
  }
  say();
  const claimed = deployments.deployer;
  say(`The deployments file names \`${claimed}\` as both deployer and owner.`);
  const matches = Object.entries(owners).filter(
    ([, o]) => o.owner && o.owner.toLowerCase() === claimed.toLowerCase(),
  );
  say(
    matches.length === 0
      ? "**Refuted:** no audited contract reports that address as its owner."
      : `**Confirmed for ${matches.length} of ${Object.keys(owned).length}:** ` +
          matches.map(([n]) => n).join(", ") + ".",
  );
  say(`That address is ${await describeAccount(claimed)}.`);
  say();

  // ── The preference registry ───────────────────────────────────────────────
  say("## Is recipient-preference enforcement real?");
  say();
  say("`ConduitRouter`'s constructor never sets `settlementPreferenceRegistry`;");
  say("only `setSettlementPreferenceRegistry` does. If it reads as the zero");
  say("address, the enforcement `_validateInstruction` documents **does not");
  say("exist in production**.");
  say();
  const prefRaw = await call(
    deployments.conduitRouter,
    enc("settlementPreferenceRegistry"),
    "router.settlementPreferenceRegistry()",
  );
  const pref = dec("settlementPreferenceRegistry", prefRaw);
  if (pref === null) {
    say("`settlementPreferenceRegistry()` **reverted** — the selector is not on");
    say("the deployed bytecode.");
  } else if (/^0x0{40}$/.test(pref)) {
    say("**It is `address(0)`.** The enforcement described in the doc comment is");
    say("NOT active on the live router. Phase A6 step 4 applies: either set it,");
    say("or delete the comment claiming it exists. Not both.");
  } else {
    say(`Set to \`${pref}\`.`);
    say(
      pref.toLowerCase() === deployments.settlementPreferenceRegistry.toLowerCase()
        ? "Matches the deployments file — the enforcement is live."
        : `**Does not match** the deployments file (\`${deployments.settlementPreferenceRegistry}\`).`,
    );
  }
  say();

  // ── Fees ──────────────────────────────────────────────────────────────────
  say("## Fees — what must be withdrawn before the redeploy");
  say();
  const feeRaw = await call(deployments.conduitRouter, enc("protocolFeeBps"), "router.protocolFeeBps()");
  const feeBps = dec("protocolFeeBps", feeRaw);
  say(
    feeBps === null
      ? "`protocolFeeBps()` reverted."
      : `\`protocolFeeBps()\` = **${feeBps}** (${Number(feeBps) / 100}%).`,
  );
  say();
  say("`accumulatedFees` for every token in the deployments file. Anything");
  say("non-zero must be withdrawn BEFORE the router is abandoned, not after.");
  say();
  say("| Token | Address | accumulatedFees | Router balance |");
  say("|---|---|---|---|");

  const tokenKeys = Object.keys(deployments).filter(
    (k) =>
      /^(usdc|eurc|audf|brla|chfau|eurau|gbpa|krw1|mxnb|qcad|zaru)$/.test(k),
  );
  let strandedFees = 0n;
  for (const key of tokenKeys) {
    const token = deployments[key];
    const fees = dec(
      "accumulatedFees",
      await call(
        deployments.conduitRouter,
        enc("accumulatedFees", [token]),
        `accumulatedFees(${key})`,
      ),
    );
    const bal = dec(
      "balanceOf",
      await call(token, enc("balanceOf", [deployments.conduitRouter]), `balanceOf router ${key}`),
    );
    if (fees) strandedFees += fees;
    say(
      `| ${key.toUpperCase()} | \`${token}\` | ${fees === null ? "reverted" : fees} | ${
        bal === null ? "reverted" : bal
      } |`,
    );
  }
  say();
  say(
    strandedFees === 0n
      ? "**No fees are stranded.** The redeploy does not have to withdraw first."
      : `**${strandedFees} minor units of fees are stranded** and must be withdrawn before the redeploy.`,
  );
  say();

  // ── Custody between transactions ──────────────────────────────────────────
  say("## Custody between transactions");
  say();
  say("`AtomicSettler` and `ConduitPayroll` should both hold nothing between");
  say("calls. Anything here is a balance somebody can be paid out of, or lose.");
  say();
  say("| Contract | Token | Balance |");
  say("|---|---|---|");
  for (const [name, addr] of [
    ["AtomicSettler", deployments.atomicSettler],
    ["ConduitPayroll", deployments.conduitPayroll],
  ].filter(([, a]) => !!a)) {
    for (const key of tokenKeys) {
      const bal = dec(
        "balanceOf",
        await call(deployments[key], enc("balanceOf", [addr]), `balanceOf ${name} ${key}`),
      );
      if (bal && bal > 0n) say(`| ${name} | ${key.toUpperCase()} | **${bal}** |`);
    }
  }
  say(`| — | — | (only non-zero balances are listed) |`);
  say();

  // ── The authorization graph ───────────────────────────────────────────────
  say("## The authorization graph, as deployed");
  say();
  const routerAuthed = deployments.atomicSettler === undefined ? null : dec(
    "authorizedRouters",
    await call(
      deployments.atomicSettler,
      enc("authorizedRouters", [deployments.conduitRouter]),
      "settler.authorizedRouters(router)",
    ),
  );
  const settlerAuthed = deployments.stableFXAdapter === undefined ? null : dec(
    "authorizedCallers",
    await call(
      deployments.stableFXAdapter,
      enc("authorizedCallers", [deployments.atomicSettler]),
      "adapter.authorizedCallers(settler)",
    ),
  );
  say(
    `- \`AtomicSettler.authorizedRouters(${deployments.conduitRouter})\` = **${
      routerAuthed === null ? "reverted" : routerAuthed
    }**`,
  );
  say(
    `- \`StableFXAdapter.authorizedCallers(${deployments.atomicSettler})\` = **${
      settlerAuthed === null ? "reverted" : settlerAuthed
    }**`,
  );
  say();
  say("Both true means the forgery path described in Phase A0 is wired end to");
  say("end on the live deployment.");
  say();

  // ── Code sizes ────────────────────────────────────────────────────────────
  say("## Deployed code");
  say();
  say("| Contract | Address | Code size |");
  say("|---|---|---|");
  for (const [name, key] of [
    ["ConduitRouter", "conduitRouter"],
    ["AtomicSettler", "atomicSettler"],
    ["StableFXAdapter", "stableFXAdapter"],
    ["DeclarationRegistry", "declarationRegistry"],
    ["CurrencyRegistry", "currencyRegistry"],
    ["SettlementPreferenceRegistry", "settlementPreferenceRegistry"],
    ["ConduitPayroll", "conduitPayroll"],
  ].filter(([, k]) => !!deployments[k])) {
    const size = await codeSize(deployments[key]);
    say(
      `| ${name} | \`${deployments[key]}\` | ${size === 0 ? "**NOT DEPLOYED**" : size + " bytes"} |`,
    );
  }
  say();

  // ── Has a forgery already happened? ───────────────────────────────────────
  say("## Has `PaymentSettled` ever been emitted?");
  say();
  say("This is the question that decides whether Phase A1 is remediation or");
  say("incident response. `execute()` and `executeWithFX` emit the SAME event,");
  say("so the log alone cannot separate them — the transaction's input");
  say("selector can, and that is what is decoded below.");
  say();

  say(`Filtering on \`${TOPIC_PAYMENT_SETTLED}\`, computed from the event`);
  say("signature rather than written down, so a zero result means zero logs and");
  say("not a mistyped topic.");
  say();

  // Scanning from block 0 is refused ("pruned history unavailable") and the
  // node caps a range at well under 50k blocks. Neither is a reason to leave
  // this question open: historical eth_getCode still works, so the deployment
  // block can be found exactly, and everything from there to head can be walked
  // in chunks the node will serve. That covers the router's ENTIRE life, which
  // is the only range the question was ever about.
  const CHUNK = 20_000;

  async function deploymentBlock(addr) {
    let lo = 0n;
    let hi = block;
    // Invariant: no code at lo, code at hi.
    if ((await rpc("eth_getCode", [addr, "0x" + hi.toString(16)])) === "0x") return null;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      const code = await rpc("eth_getCode", [addr, "0x" + mid.toString(16)]);
      if (code === "0x") lo = mid;
      else hi = mid;
    }
    return hi;
  }

  let logs = [];
  let scanned = true;
  let from;
  try {
    from = await deploymentBlock(deployments.conduitRouter);
    if (from === null) throw new Error("the router has no code at head");
    say(`Router deployed at block **${from}**, found by binary search on`);
    say(`\`eth_getCode\`. Scanning ${from} → ${block} in ${CHUNK}-block chunks —`);
    say("the router's entire history, not a recent window.");
    say();
    for (let start = from; start <= block; start += BigInt(CHUNK)) {
      const end = start + BigInt(CHUNK) - 1n > block ? block : start + BigInt(CHUNK) - 1n;
      const chunk = await rpc("eth_getLogs", [
        {
          address: deployments.conduitRouter,
          topics: [TOPIC_PAYMENT_SETTLED],
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
        },
      ]);
      logs.push(...chunk);
      // One second between chunks, measured rather than guessed.
      //
      // The public endpoint enforces a SUSTAINED quota, not a burst allowance:
      // at 120ms it 429s and then keeps 429ing through six exponential
      // retries, while at 1s a long serial run does not fail once. Backing off
      // after the fact cannot recover from a quota that is already spent, so
      // the scan is paced to stay inside it. ~130 chunks, a little over two
      // minutes, and a complete answer.
      await sleep(1000);
    }
  } catch (err) {
    scanned = false;
    say(`**The scan failed:** \`${err.message}\``);
    say();
    say("Re-run against an archive endpoint (`ARC_RPC_URL=...`) before treating");
    say("this section as answered.");
    failures.push(`PaymentSettled scan: ${err.message}`);
  }

  if (scanned) {
    say(`Logs found: **${logs.length}**`);
    say();
    if (logs.length === 0) {
      say("No `PaymentSettled` has ever been emitted by this router, across its");
      say("whole history. **No forged settlement has occurred** — and no genuine");
      say("one either, which is consistent with `RecordDirectSettlement` being");
      say("the path the browser actually uses.");
      say();
      say("Phase A1 is therefore **prevention, not incident response**.");
    } else {
      // Classified from the EVENT, corroborated by the transaction.
      //
      // The tokens are the reliable discriminator and they are in the log
      // itself: `execute` requires payerToken == recipientToken, and
      // `executeWithFX` requires them to differ — both enforced by a `require`
      // in the function body, so neither can emit outside its own shape. That
      // means a settlement classifies itself even when its transaction is no
      // longer retrievable, which matters here: the node has pruned the older
      // ones, and an audit that cannot read a transaction must not therefore
      // call it safe.
      const EXECUTE = iface2.getFunction("execute").selector;
      const EXECUTE_FX = iface2.getFunction("executeWithFX").selector;
      say("| Block | Tx | Tokens | Selector | Verdict |");
      say("|---|---|---|---|---|");
      let forged = 0;
      let unclassified = 0;
      for (const log of logs) {
        const ev = iface.decodeEventLog("PaymentSettled", log.data, log.topics);
        const same = ev.payerToken.toLowerCase() === ev.recipientToken.toLowerCase();

        let tx = null;
        try {
          tx = await rpc("eth_getTransactionByHash", [log.transactionHash]);
        } catch {
          // Pruned. The event still classifies it.
        }
        const selector = tx?.input ? tx.input.slice(0, 10) : null;

        let verdict;
        if (selector === EXECUTE_FX || (!selector && !same)) {
          verdict = "**`executeWithFX` — THE FORGERY PATH**";
          forged++;
        } else if (selector === EXECUTE || (!selector && same)) {
          verdict = "`execute()` — moves tokens in the same call";
        } else {
          verdict = "**UNCLASSIFIED**";
          unclassified++;
        }
        say(
          `| ${BigInt(log.blockNumber)} | \`${log.transactionHash}\` | ${
            same ? "same" : "**differ**"
          } | \`${selector ?? "pruned"}\` | ${verdict} |`,
        );
        await sleep(200);
      }
      say();
      if (forged > 0) {
        say(`**${forged} settlement(s) came from \`executeWithFX\`.** This is`);
        say("incident response, not remediation. Cross-reference each against the");
        say("`settlements` table and check whether the transaction moved tokens.");
        failures.push(`${forged} settlement(s) emitted by executeWithFX`);
      } else if (unclassified > 0) {
        say(`**${unclassified} settlement(s) could not be classified.** No`);
        say("conclusion is drawn about them, and the gate fails until one can be.");
        failures.push(`${unclassified} PaymentSettled log(s) unclassified`);
      } else {
        say("Every emission came from `execute()`, which performs its own");
        say("transfer in the same call. **No forged settlement has occurred.**");
        say();
        say("Phase A1 is therefore **prevention, not incident response**.");
      }
    }
  }
  say();

  // ── Currencies ────────────────────────────────────────────────────────────
  say("## Does CurrencyRegistry match what the API serves?");
  say();
  const codesRaw = await call(deployments.currencyRegistry, enc("allCodes"), "registry.allCodes()");
  const codesDecoded = dec("allCodes", codesRaw);
  if (!codesDecoded) {
    say("`allCodes()` reverted or could not be read.");
  } else {
    // bytes3 comes back as hex; the codes are ASCII ("USD", "EUR", ...).
    const codes = [...codesDecoded].map((c) =>
      Buffer.from(c.replace(/^0x/, ""), "hex").toString("ascii"),
    );
    say(`On-chain codes (${codes.length}): ${codes.map((c) => `\`${c}\``).join(", ")}`);
    say();
    say("Compare against `packages/api/internal/currency`. A currency the API");
    say("serves and the registry does not know becomes a hard failure the");
    say("moment Phase A4 makes `isEnabledToken` load-bearing in `execute()`.");
  }
  say();

  // ── Verdict ───────────────────────────────────────────────────────────────
  say("## Unresolved");
  say();
  if (failures.length === 0) {
    say("None. Every field above was filled from a real call.");
  } else {
    for (const f of failures) say(`- ${f}`);
  }
  say();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.error(`\nWrote ${OUT}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} field(s) could not be read. Exiting non-zero.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
