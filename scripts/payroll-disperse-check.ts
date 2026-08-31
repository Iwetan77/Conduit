// A real disperse, on Arc testnet, to three real addresses.
//
// Foundry proves the contract's logic against mocks. This proves the deployed
// bytecode does the same thing with the actual USDC on the actual chain — which
// is not the same claim, and is the one that matters before a payroll runs
// through it.
//
// Asserts what the phase asks for: all three balances moved by exactly their
// amounts, and the runId in the emitted event is the one that was passed.
//
//   pnpm tsx scripts/payroll-disperse-check.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  parseAbi,
  keccak256,
  toHex,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const ARC_RPC = process.env["ARC_RPC"] ?? "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000" as const;

// Small: three recipients at 0.01 USDC each. The assertions are relative, so
// nothing is bought by moving more, and every run strands what it sends.
const EACH = 10_000n; // 0.01 USDC

const deployments = JSON.parse(
  readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf8"),
) as Record<string, string>;
const PAYROLL = deployments["conduitPayroll"] as `0x${string}`;
if (!PAYROLL) throw new Error("conduitPayroll is not in deployments/arc-testnet.json — deploy it first");

const payrollAbi = parseAbi([
  "function disperse(bytes32 runId, address token, address[] to, uint256[] amounts) returns (uint256)",
  "event PayrollPaid(bytes32 indexed runId, address indexed token, address indexed to, uint256 amount)",
  "event PayrollRun(bytes32 indexed runId, address indexed token, address indexed payer, uint256 recipients, uint256 total)",
]);
const erc20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

function envValue(file: string, key: string): string {
  const line = readFileSync(resolve(__dirname, file), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in ${file}`);
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
}

let failures = 0;
function check(ok: boolean, label: string, detail?: string) {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log("        " + detail);
  }
}

async function main() {
  const raw = envValue("../packages/contracts/.env", "PRIVATE_KEY");
  const payer = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
  const publicClient = createPublicClient({ transport: viemHttp(ARC_RPC) });
  const wallet = createWalletClient({ account: payer, transport: viemHttp(ARC_RPC) });

  console.log("=== live disperse on Arc testnet ===");
  console.log(`contract: ${PAYROLL}\npayer:    ${payer.address}\n`);

  // Fresh addresses, so the balance deltas are unambiguous — a recipient with a
  // prior balance would make "rose by exactly" a weaker claim than it reads as.
  const recipients = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()].map((k) =>
    privateKeyToAccount(k).address,
  );
  const amounts = [EACH, EACH * 2n, EACH * 3n];
  const total = amounts.reduce((a, b) => a + b, 0n);
  const runId = keccak256(toHex(`pr_live_${Date.now()}`));

  const before = await Promise.all(
    recipients.map((r) =>
      publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [r] }),
    ),
  );
  check(
    before.every((b) => b === 0n),
    "recipients start empty, so the deltas are unambiguous",
  );

  // One approve for the run's total, which is the whole point of pulling once.
  const approveHash = await wallet.writeContract({
    address: USDC,
    abi: erc20,
    functionName: "approve",
    args: [PAYROLL, total],
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const hash = await wallet.writeContract({
    address: PAYROLL,
    abi: payrollAbi,
    functionName: "disperse",
    args: [runId, USDC, recipients, amounts],
    chain: null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  check(receipt.status === "success", "the disperse transaction succeeded", `status ${receipt.status}`);
  console.log(`        tx ${hash}`);
  console.log(`        gas ${receipt.gasUsed} for 3 recipients`);

  const after = await Promise.all(
    recipients.map((r) =>
      publicClient.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [r] }),
    ),
  );
  recipients.forEach((r, i) => {
    check(
      after[i]! - before[i]! === amounts[i],
      `recipient ${i + 1} received exactly ${amounts[i]}`,
      `${r} moved by ${after[i]! - before[i]!}`,
    );
  });

  // The contract keeps nothing between calls, which is why it needs no owner
  // and no rescue function.
  const stranded = await publicClient.readContract({
    address: USDC,
    abi: erc20,
    functionName: "balanceOf",
    args: [PAYROLL],
  });
  check(stranded === 0n, "the contract kept nothing", `holds ${stranded}`);

  // The runId is how the indexer ties a transaction back to a payroll run
  // without guessing which of several in a block it belongs to.
  let paid = 0;
  let runSeen = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== PAYROLL.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: payrollAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "PayrollPaid") {
        check((ev.args as any).runId === runId, `PayrollPaid ${paid + 1} carries the run id`);
        paid++;
      } else if (ev.eventName === "PayrollRun") {
        runSeen = true;
        check((ev.args as any).runId === runId, "PayrollRun carries the run id");
        check((ev.args as any).total === total, "PayrollRun reports the right total");
      }
    } catch {
      // Not one of ours.
    }
  }
  check(paid === 3, "one PayrollPaid per recipient", `saw ${paid}`);
  check(runSeen, "a run-level event was emitted");

  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    return 1;
  }
  console.log("Deployed bytecode disperses correctly on chain.");
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
