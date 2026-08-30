// Execute a Circle challenge in a real browser, from a script.
//
// Every wallet operation on a user-controlled Circle wallet ends the same way:
// the API returns a `challengeId` and stops, because the key material lives on
// the user's device and is derived there. That is the product working as
// intended — the merchant owns the key — and it is also why no server-side test
// can produce a real wallet, a real signature, or a real transfer.
//
// This closes that gap for scripts. It builds Circle's Web SDK into a one-page
// harness, serves it, drives the hosted PIN UI with Playwright, and returns
// what the SDK's callback got. Used by scripts/circle-wallet-probe.ts, and
// meant to be reused by the settlement and payout end-to-end runs, which need
// an actual provisioned wallet rather than a fixture.
//
// It drives PIN-mode users only. An SSO user's token cannot be minted from the
// API key at all (`POST /v1/w3s/users/token` answers `code 2` for one), so a
// script cannot get far enough to need the UI — see docs/circle-wallet-capability.md.

import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, mkdtempSync, copyFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";

// Circle's hosted UI is loaded into an iframe with `?origin=<this server>`.
// Keep it on a port the Circle app's allowed origins already cover; 3000 is the
// app's own dev port and is what has been verified to work.
const DEFAULT_PORT = 3000;

// Not a secret — a throwaway user's PIN, used only inside these runs. Circle
// rejects repeating (000000) and consecutive (123456) digits, hence neither.
export const HARNESS_PIN = "182937";

const HARNESS_DIR = resolve(__dirname, "circle-challenge");

export interface ChallengeResult {
  error: { code?: number; message?: string } | null;
  result: { type?: string; status?: string; data?: unknown } | null;
}

export interface ChallengeRunner {
  execute(
    challengeId: string,
    auth: { userToken: string; encryptionKey: string },
  ): Promise<ChallengeResult>;
  close(): Promise<void>;
}

// Bundle the SDK once per run, into a temp dir rather than the repo.
async function buildHarness(): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "conduit-circle-harness-"));
  const sdkEntry = resolve(
    __dirname,
    "../packages/app/node_modules/@circle-fin/w3s-pw-web-sdk/dist/src/index.js",
  );
  if (!existsSync(sdkEntry)) {
    throw new Error(`Circle Web SDK not found at ${sdkEntry} — run pnpm install`);
  }
  await build({
    entryPoints: [sdkEntry],
    bundle: true,
    format: "iife",
    globalName: "W3S",
    platform: "browser",
    outfile: join(out, "w3s.js"),
    alias: {
      // See jsonwebtoken-shim.js for why this whole subtree is cut.
      jsonwebtoken: join(HARNESS_DIR, "jsonwebtoken-shim.js"),
    },
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    logLevel: "silent",
  });
  copyFileSync(join(HARNESS_DIR, "harness.html"), join(out, "index.html"));
  return out;
}

function serve(root: string, port: number): Promise<Server> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const file = join(root, path === "/" ? "index.html" : path);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, () => ok(server));
  });
}

export async function startChallengeRunner(opts: {
  appId: string;
  port?: number;
  headless?: boolean;
  onLog?: (line: string) => void;
}): Promise<ChallengeRunner> {
  const port = opts.port ?? DEFAULT_PORT;
  const log = opts.onLog ?? (() => {});
  const root = await buildHarness();
  const server = await serve(root, port);

  // Resolved from the app by path, which is where Playwright is a dependency —
  // it is not one at the repo root, so `import "playwright"` would not resolve
  // here and typing it against the package would not either.
  const { chromium } = (await import(
    resolve(__dirname, "../packages/app/node_modules/playwright/index.mjs")
  )) as { chromium: any };
  const browser = await chromium.launch({
    headless: opts.headless ?? true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  // ONE context for every challenge in a run, not one per page.
  //
  // The SDK mints a device id on first use and registers it with Circle, and
  // keeps it in localStorage. `browser.newPage()` opens a FRESH context each
  // time, so a second challenge came up on an unregistered device and Circle
  // refused it with 155113 "Provided device ID is not found in the system" —
  // after the first challenge had succeeded, which made it look like the second
  // wallet was the thing being refused rather than the browser it was asked
  // from.
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });

  async function execute(
    challengeId: string,
    auth: { userToken: string; encryptionKey: string },
  ): Promise<ChallengeResult> {
    const page = await context.newPage();
    const url =
      `http://localhost:${port}/?appId=${encodeURIComponent(opts.appId)}` +
      `&userToken=${encodeURIComponent(auth.userToken)}` +
      `&encryptionKey=${encodeURIComponent(auth.encryptionKey)}` +
      `&challengeId=${encodeURIComponent(challengeId)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const frame = () => page.frames().find((f: any) => f.url().includes("pw-auth.circle.com"));

    // A screen is ready only once its text has stopped changing. Circle paints
    // the heading before the fields arrive, so acting on the first non-empty
    // read dispatches against a half-built page and falls through every branch
    // below — which looked exactly like "the flow got stuck".
    async function screen(): Promise<{ text: string } | null> {
      let previous: string | null = null;
      let stable = 0;
      for (let i = 0; i < 60; i++) {
        const f = frame();
        if (f) {
          const text = await f.evaluate(() => document.body?.innerText ?? "").catch(() => "");
          if (text.trim()) {
            if (text === previous) {
              stable++;
              if (stable >= 2) return { text };
            } else {
              stable = 0;
              previous = text;
            }
          }
        }
        await page.waitForTimeout(1000);
      }
      return previous ? { text: previous } : null;
    }

    try {
      for (let step = 0; step < 20; step++) {
        const done = (await page.evaluate(() => (window as any).__done)) as ChallengeResult | null;
        if (done?.result) return done;

        const s = await screen();
        if (!s) {
          const final = (await page.evaluate(() => (window as any).__done)) as ChallengeResult | null;
          return final ?? { error: { message: "challenge UI never appeared" }, result: null };
        }
        const f = frame()!;
        log(`    challenge step ${step}: ${s.text.split("\n")[0]}`);

        // PIN entry — six single-character boxes that advance on input. Covers
        // both "create your PIN" and "re-enter to confirm", which is why this
        // is keyed on the boxes rather than on the heading.
        const pins = await f.$$("input[type=password]");
        if (pins.length >= 6) {
          await pins[0]!.click();
          await page.keyboard.type(HARNESS_PIN, { delay: 60 });
          await page.waitForTimeout(2500);
          continue;
        }

        // Final acknowledgement: the words have to be typed out.
        const agree = await f.$('input[placeholder*="agree"]');
        if (agree) {
          await agree.click();
          await page.keyboard.type("I agree", { delay: 50 });
          await page.waitForTimeout(800);
          const go = await f.$('button:has-text("Continue")');
          if (go && !(await go.isDisabled())) {
            await go.click();
            await page.waitForTimeout(4000);
            continue;
          }
        }

        // Recovery questions. Two pickers, each unlocking its own answer field;
        // the answers are throwaway because the user is.
        if (/Select your 1st question/.test(s.text)) {
          for (let i = 0; i < 2; i++) {
            const pickers = await f.$$('button:has-text("Select")');
            if (!pickers[0]) break;
            await pickers[0].click();
            await page.waitForTimeout(1200);
            const options = await f.$$("[role=option], li, [role=menuitem]");
            if (options[i]) {
              await options[i]!.click();
              await page.waitForTimeout(1200);
            }
          }
          const answers = await f.$$('input[placeholder="Type your answer here"]');
          for (let i = 0; i < answers.length; i++) {
            await answers[i]!.fill(`conduit-harness-answer-${i}`);
          }
          await page.waitForTimeout(800);
        }

        const next = await f.$(
          'button:has-text("Continue"), button:has-text("Next"), button:has-text("Confirm"), button:has-text("Done")',
        );
        if (next && !(await next.isDisabled())) {
          await next.click();
          await page.waitForTimeout(2500);
          continue;
        }

        return {
          error: { message: `challenge stalled on: ${s.text.split("\n")[0]}` },
          result: null,
        };
      }
      return { error: { message: "challenge did not finish in 20 steps" }, result: null };
    } finally {
      await page.close();
    }
  }

  return {
    execute,
    async close() {
      await browser.close();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
