// Load every important page in a real browser and fail if any of them throws.
//
// This exists because of two outages in two days that every other check passed.
// Both were hooks called below an early return -- `tsc --noEmit` clean,
// `next build` clean, server-render check clean, and the page still tore itself
// down the moment React hydrated it. None of those tools run the page. This one
// does, and it is the only check in the repo that would have caught either.
//
// Deliberately dumb: open the URL, wait for the network to settle, and fail on
// a page error, a console error, or the app's own error boundary appearing.
// It asserts nothing about what the page SAYS, so it does not break when copy
// changes -- it only asserts that the page exists rather than crashing.
//
//   node scripts/smoke.mjs http://localhost:3000
//   node scripts/smoke.mjs https://useconduit.xyz
//   SMOKE_PATHS=/,/send node scripts/smoke.mjs http://localhost:3000
//
// Exit 0 = every page rendered. Exit 1 = at least one did not.

import { chromium } from "playwright";

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");

// The surfaces where a crash costs money or credibility. /pay carries a real
// id so the payer path is exercised with data rather than an error state.
const DEFAULT_PATHS = [
  "/",
  "/send",
  "/links",
  "/history",
  "/create",
  "/docs",
  "/pay/si_mgm4bnjczybhbzgdwtgr",
];
const paths = (process.env.SMOKE_PATHS || DEFAULT_PATHS.join(",")).split(",");

// Errors that mean the page is broken, as opposed to noise a browser emits on
// any page with wallet extensions and third-party scripts.
const FATAL =
  /Minified React error|Rendered more hooks|Rendered fewer hooks|is not a function|Cannot read propert|undefined is not|Hydration failed|Text content does not match/i;

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
let failures = 0;

for (const path of paths) {
  const url = base + path;
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page
    .goto(url, { waitUntil: "networkidle", timeout: 45000 })
    .catch((e) => errors.push("NAVIGATION: " + e.message));
  // Hydration happens after load; the crashes this exists for happen there.
  await page.waitForTimeout(2500);

  const boundary = await page
    .evaluate(() => document.body.innerText.includes("SOMETHING BROKE"))
    .catch(() => false);

  const unique = [...new Set(errors)];
  const fatal = unique.filter((e) => FATAL.test(e));
  const broken = boundary || fatal.length > 0;

  if (broken) failures++;
  console.log(
    `${broken ? "FAIL" : " ok "}  ${url}${boundary ? "   [ERROR BOUNDARY RENDERED]" : ""}`,
  );
  for (const e of fatal.slice(0, 3)) console.log("        " + e.slice(0, 300));
  await page.close();
}


// Delay the destination RSC response and assert that the outgoing page is
// covered immediately. This is the regression for route flashes: loading.tsx
// alone does not start until Next begins rendering the destination tree.
{
  const page = await browser.newPage();
  await page.route("**/*", async (route) => {
    const requestURL = route.request().url();
    if (requestURL.includes("/create") && requestURL.includes("_rsc=")) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await route.continue();
  });

  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  await page.goto(base + "/send", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByRole("link", { name: "Create", exact: true }).first().click({ noWaitAfter: true });

  const cover = page.locator("[data-route-transition]");
  const covered = await cover
    .waitFor({ state: "visible", timeout: 1_000 })
    .then(() => true)
    .catch(() => false);
  const target = covered ? await cover.getAttribute("data-target-path") : null;

  await page.waitForURL("**/create", { timeout: 10_000 }).catch((error) => errors.push(String(error)));
  const cleared = await cover
    .waitFor({ state: "detached", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  const broken = !covered || target !== "/create" || !cleared || errors.some((error) => FATAL.test(error));

  if (broken) failures++;
  console.log(
    `${broken ? "FAIL" : " ok "}  ${base}/send -> /create route transition`,
  );
  if (!covered) console.log("        outgoing page was not covered while the route was pending");
  if (target !== "/create") console.log(`        transition target was ${target ?? "missing"}`);
  if (!cleared) console.log("        transition cover remained after the destination committed");
  for (const error of errors.filter((value) => FATAL.test(value)).slice(0, 3)) {
    console.log("        " + error.slice(0, 300));
  }
  await page.close();
}

await browser.close();

if (failures > 0) {
  console.log(`\n${failures} page(s) failed. Do not deploy this.`);
  process.exit(1);
}
console.log(`\nAll ${paths.length} pages rendered.`);
