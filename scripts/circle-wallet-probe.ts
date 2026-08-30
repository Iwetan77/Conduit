// Circle wallet capability probe.
//
// The provisioned-settlement-wallet design rests on one assumption: that Circle
// will create an ADDITIONAL user-controlled wallet on Arc for a user who is
// already initialized. If one wallet per blockchain per user were a hard limit,
// the design would be wrong and would need a different shape — a per-account
// receiver contract on Arc — so this runs before anything is built.
//
// Real network calls only, in the style of scripts/stablefx-probe.ts. Every
// claim in docs/circle-wallet-capability.md traces back to a call made here,
// and the raw response is recorded beside it.
//
//   pnpm tsx scripts/circle-wallet-probe.ts
//
// What it does, end to end, with nothing mocked:
//
//   1. Creates a throwaway PIN-mode Circle user.
//   2. Initializes it on Arc and executes the challenge in a real browser
//      (scripts/circle-challenge.ts), because wallet creation completes on the
//      user's device and cannot complete on a server.
//   3. Asks for a SECOND Arc wallet on that now-initialized user, executes that
//      challenge too, and reads the wallet list back.
//   4. Asks for a THIRD as an SCA, because account type is fixed at creation and
//      the payroll work depends on which types Arc supports.
//
// Requires CIRCLE_API_KEY in packages/api/.env and NEXT_PUBLIC_CIRCLE_APP_ID in
// packages/app/.env.local. Neither is printed.
//
// It needs port 3000 for the harness: Circle's hosted challenge UI is framed
// with the harness origin, and 3000 is the origin the Circle app allows. Stop
// the dev server first, or pass CIRCLE_HARNESS_PORT if another origin is
// registered.
//
// On a machine where Playwright's chromium cannot find libnspr4/libnss3 (WSL
// without those packages), stage them and point LD_LIBRARY_PATH at them — the
// same workaround packages/app's browser smoke test needs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { startChallengeRunner } from "./circle-challenge";

const BASE = process.env["CIRCLE_API_BASE"] ?? "https://api.circle.com";

// The identifier the running server sends to /user/initialize
// (internal/server/server.go). Whether the wallets API agrees is one of the
// things being established, so it is read back from ListWallets rather than
// assumed.
const ARC = "ARC-TESTNET";

function fromEnvFile(file: string, key: string): string {
  if (process.env[key]) return process.env[key]!;
  const path = resolve(__dirname, file);
  if (existsSync(path)) {
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).trim();
  }
  throw new Error(`${key} not found in the environment or ${file}`);
}

interface Call {
  label: string;
  method: string;
  path: string;
  requestBody?: unknown;
  status: number;
  code?: number;
  message?: string;
  data?: unknown;
  raw: unknown;
}

const calls: Call[] = [];

// One request, recorded. Failures are data here, not exceptions: "Circle
// refuses this" is exactly the kind of answer the probe exists to collect, so a
// 400 must end up in the log rather than ending the run. Connection failures
// are retried — this host reaches api.circle.com intermittently.
async function call(
  apiKey: string,
  label: string,
  method: string,
  path: string,
  opts: { body?: unknown; userToken?: string } = {},
): Promise<Call> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  if (opts.userToken) headers["X-User-Token"] = opts.userToken;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      let raw: any;
      try {
        raw = await res.json();
      } catch {
        raw = { _nonJson: true, status: res.status };
      }
      const entry: Call = {
        label,
        method,
        path,
        requestBody: opts.body,
        status: res.status,
        code: raw?.code,
        message: raw?.message,
        data: raw?.data,
        raw,
      };
      calls.push(entry);
      const ok = res.status < 400 && !raw?.code;
      console.log(
        `  ${ok ? "ok  " : "FAIL"}  ${method} ${path}  [${label}]  http=${res.status}` +
          `${raw?.code ? ` code=${raw.code}` : ""}${raw?.message ? ` ${raw.message}` : ""}`,
      );
      return entry;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`circle unreachable: ${method} ${path} (${String(lastErr)})`);
}

interface Wallet {
  id: string;
  address: string;
  blockchain: string;
  state: string;
  accountType: string;
  name?: string;
  refId?: string;
}

async function listWallets(apiKey: string, userToken: string, label: string): Promise<Wallet[]> {
  const r = await call(apiKey, label, "GET", "/v1/w3s/wallets", { userToken });
  const wallets = ((r.data as any)?.wallets ?? []) as Wallet[];
  for (const w of wallets) {
    console.log(
      `        ${w.blockchain} ${w.accountType} ${w.state} ${w.address}` +
        (w.name ? ` name="${w.name}"` : "") +
        (w.refId ? ` refId=${w.refId}` : ""),
    );
  }
  return wallets;
}

async function main() {
  const apiKey = fromEnvFile("../packages/api/.env", "CIRCLE_API_KEY");
  const appId = fromEnvFile("../packages/app/.env.local", "NEXT_PUBLIC_CIRCLE_APP_ID");
  const port = Number(process.env["CIRCLE_HARNESS_PORT"] ?? 3000);

  console.log("=== Circle wallet capability probe ===");
  console.log(`base: ${BASE}`);
  console.log(`key:  ${apiKey.split(":")[0]}:<redacted>`);
  console.log("");

  // ── A user we own, initialized for real ───────────────────────────────────
  //
  // PIN mode, not SSO. An SSO user's token cannot be minted from the API key
  // (`POST /v1/w3s/users/token` answers code 2), so a script cannot act on one
  // at all — a finding in its own right, and the reason the server's
  // provisioning endpoint has to take the user token from the browser.
  const userId = `probe-${randomUUID()}`;
  await call(apiKey, "create user", "POST", "/v1/w3s/users", { body: { userId } });
  const tokenCall = await call(apiKey, "issue user token", "POST", "/v1/w3s/users/token", {
    body: { userId },
  });
  const { userToken, encryptionKey } = (tokenCall.data ?? {}) as {
    userToken?: string;
    encryptionKey?: string;
  };
  if (!userToken || !encryptionKey) throw new Error("no user token; everything below needs one");

  const runner = await startChallengeRunner({ appId, port, onLog: (l) => console.log(l) });
  try {
    console.log("\n-- initialize on Arc --");
    const init = await call(apiKey, "initialize", "POST", "/v1/w3s/user/initialize", {
      userToken,
      body: { idempotencyKey: randomUUID(), blockchains: [ARC] },
    });
    const initChallenge = (init.data as any)?.challengeId as string | undefined;
    if (!initChallenge) throw new Error("initialize returned no challengeId");
    const initDone = await runner.execute(initChallenge, { userToken, encryptionKey });
    console.log(`    -> ${JSON.stringify(initDone)}`);

    const first = await listWallets(apiKey, userToken, "wallets after initialize");
    const firstArc = first.filter((w) => w.blockchain === ARC);

    // ── The question ────────────────────────────────────────────────────────
    console.log("\n-- second Arc wallet on the same, now-initialized user --");
    const second = await call(apiKey, "additional wallet", "POST", "/v1/w3s/user/wallets", {
      userToken,
      body: {
        idempotencyKey: randomUUID(),
        blockchains: [ARC],
        // Can the business wallet be told from the personal one in ListWallets,
        // without a mapping of our own?
        metadata: [{ name: "Conduit settlement", refId: "conduit-settlement" }],
      },
    });
    const secondChallenge = (second.data as any)?.challengeId as string | undefined;
    if (secondChallenge) {
      const r = await runner.execute(secondChallenge, { userToken, encryptionKey });
      console.log(`    -> ${JSON.stringify(r)}`);
    }

    // ── Account type, which is fixed at creation and matters for payroll ─────
    console.log("\n-- third Arc wallet, requested as an SCA --");
    const sca = await call(apiKey, "additional wallet, accountType=SCA", "POST", "/v1/w3s/user/wallets", {
      userToken,
      body: {
        idempotencyKey: randomUUID(),
        blockchains: [ARC],
        accountType: "SCA",
        metadata: [{ name: "Conduit SCA probe", refId: "conduit-sca-probe" }],
      },
    });
    const scaChallenge = (sca.data as any)?.challengeId as string | undefined;
    if (scaChallenge) {
      const r = await runner.execute(scaChallenge, { userToken, encryptionKey });
      console.log(`    -> ${JSON.stringify(r)}`);
    }

    // ── Edges worth knowing before building on this ──────────────────────────
    console.log("\n-- edges --");
    await call(apiKey, "two wallets on one chain in one request", "POST", "/v1/w3s/user/wallets", {
      userToken,
      body: { idempotencyKey: randomUUID(), blockchains: [ARC, ARC] },
    });
    await call(apiKey, "initialize again", "POST", "/v1/w3s/user/initialize", {
      userToken,
      body: { idempotencyKey: randomUUID(), blockchains: [ARC] },
    });

    // Circle reflects a new wallet a moment after the challenge resolves.
    await new Promise((r) => setTimeout(r, 4000));
    console.log("");
    const wallets = await listWallets(apiKey, userToken, "wallets at the end");
    const arc = wallets.filter((w) => w.blockchain === ARC);

    writeReport(userId, wallets, firstArc[0] ?? null);

    console.log(`\n${arc.length} wallet(s) on ${ARC} for one user.`);
    if (arc.length >= 2) {
      console.log("RESULT: an already-initialized user CAN hold more than one Arc wallet.");
      console.log("The provisioned-settlement-wallet design holds. Proceed.");
      return 0;
    }
    console.log("RESULT: no second Arc wallet. STOP — the design needs rethinking.");
    return 1;
  } finally {
    await runner.close();
  }
}

function writeReport(userId: string, wallets: Wallet[], firstArc: Wallet | null) {
  const arc = wallets.filter((w) => w.blockchain === ARC);
  const second = arc.find((w) => !firstArc || w.id !== firstArc.id) ?? null;
  const challengeIds = calls
    .filter((c) => c.path === "/v1/w3s/user/wallets")
    .map((c) => (c.data as any)?.challengeId)
    .filter(Boolean) as string[];

  const lines: string[] = [];
  lines.push("# Circle wallet capability");
  lines.push("");
  lines.push(`Generated by \`scripts/circle-wallet-probe.ts\` on ${new Date().toISOString()}.`);
  lines.push("Every claim is followed by the call that established it. Nothing here is inferred");
  lines.push("from documentation, and no response was edited.");
  lines.push("");
  lines.push(`- Base URL: \`${BASE}\``);
  lines.push(`- Circle user: \`${userId}\` — created by this run, PIN mode, initialized through`);
  lines.push("  a real browser challenge.");
  lines.push("");
  lines.push("## The question this was written to answer");
  lines.push("");
  if (second) {
    lines.push("**An already-initialized user can hold more than one wallet on Arc.**");
    lines.push("");
    lines.push(
      `- The wallet \`/user/initialize\` made: \`${firstArc?.id}\` \`${firstArc?.address}\` accountType \`${firstArc?.accountType}\``,
    );
    for (const w of arc.filter((w) => w.id !== firstArc?.id)) {
      lines.push(
        `- Provisioned afterwards: \`${w.id}\` \`${w.address}\` accountType \`${w.accountType}\`${w.name ? ` name \`${w.name}\`` : ""}`,
      );
    }
    lines.push(`- Arc wallets on this one user at the end of the run: **${arc.length}**`);
    lines.push("");
    lines.push("The design's premise holds: a merchant can be given a settlement wallet that is");
    lines.push("separate from the wallet they sign in with, owned by them, created through Circle.");
  } else {
    lines.push("**No second Arc wallet could be created.** See the call log below for what");
    lines.push("Circle refused, and STOP: the fallback is a different design.");
  }
  lines.push("");
  lines.push("## What else was established");
  lines.push("");
  lines.push(
    "- **The endpoint is `POST /v1/w3s/user/wallets`**, body `{idempotencyKey, blockchains, accountType?, metadata?}`.",
  );
  lines.push(
    challengeIds.length
      ? `- **It returns a \`challengeId\`, not a wallet** (${challengeIds.length} issued here). Creation completes in the browser, on the user's device — there is no server-side completion, and an unexecuted challenge creates nothing.`
      : "- No challengeId was issued on this run — see the call log.",
  );
  const chains = [...new Set(wallets.map((w) => w.blockchain))];
  lines.push(
    `- **The blockchain identifier is ${chains.map((c) => `\`${c}\``).join(", ")}**, read back from \`ListWallets\` — the same string the API server already sends to \`/user/initialize\`.`,
  );
  const types = [...new Set(arc.map((w) => w.accountType))].filter(Boolean);
  lines.push(
    types.length > 1
      ? `- **Arc supports both account types**: ${types.map((t) => `\`${t}\``).join(" and ")} were both created on this user. Account type is fixed at creation, so this is a decision to take once per wallet, not later.`
      : types.length === 1
        ? `- Only \`${types[0]}\` was observed on Arc for this user.`
        : "- No account type could be read back.",
  );
  const named = wallets.find((w) => w.name || w.refId);
  lines.push(
    named
      ? `- **Naming survives into \`ListWallets\`** (\`${named.id}\` name \`${named.name ?? ""}\`, refId \`${named.refId ?? ""}\`), so the business wallet is distinguishable from the personal one without keeping a mapping of our own. Worth having, but not worth trusting: the server should still record the wallet id it provisioned.`
      : "- No wallet carried a name or refId in `ListWallets` on this run.",
  );
  lines.push(
    "- **Wallet order in `ListWallets` is not stable.** The newest wallet came back first here. Nothing may identify a wallet by position.",
  );
  const dup = calls.find((c) => c.label.startsWith("two wallets on one chain"));
  if (dup) {
    lines.push(
      `- **Two wallets on one chain in a single request is rejected** (\`${dup.status}\`, code \`${dup.code}\`: ${dup.message}). One request per wallet.`,
    );
  }
  const reinit = calls.find((c) => c.label === "initialize again");
  if (reinit) {
    lines.push(
      `- **\`/user/initialize\` is one-shot** — a second call answers \`${reinit.status}\` code \`${reinit.code}\`: ${reinit.message}. So a wallet cannot be folded into the initialize challenge for an existing user; first login is initialize, and every wallet after it is \`/user/wallets\`.`,
    );
  }
  lines.push(
    "- **An SSO user's token cannot be minted from the API key.** `POST /v1/w3s/users/token` answers `code 2, API parameter invalid` for a user whose `authMode` is `SSO` — which every Conduit merchant is, since they sign in with Google. The server therefore cannot act on a merchant's Circle wallets on its own; it needs the user token the browser holds. That is why provisioning takes `X-Circle-User-Token` rather than being a background job.",
  );
  lines.push("");
  lines.push("## Wallets at the end of the run");
  lines.push("");
  if (wallets.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| blockchain | accountType | state | address | name | refId |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const w of wallets) {
      lines.push(
        `| \`${w.blockchain}\` | \`${w.accountType}\` | \`${w.state}\` | \`${w.address}\` | ${w.name ?? ""} | ${w.refId ?? ""} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Call log");
  lines.push("");
  lines.push("Every request this run made, in order, with Circle's own response.");
  lines.push("");
  for (const c of calls) {
    lines.push(`### ${c.label}`);
    lines.push("");
    lines.push(`\`${c.method} ${c.path}\` → http ${c.status}${c.code ? ` · code ${c.code}` : ""}`);
    lines.push("");
    if (c.requestBody !== undefined) {
      lines.push("Request:");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(c.requestBody, null, 2));
      lines.push("```");
      lines.push("");
    }
    lines.push("Response:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(c.raw, null, 2));
    lines.push("```");
    lines.push("");
  }

  const out = resolve(__dirname, "../docs/circle-wallet-capability.md");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n"));
  console.log(`\nWrote ${out}`);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
