// Does signing out actually sign you out?
//
// Reported: four Google accounts on one phone. Set a username on the first,
// then sign into the second and third and the first account's name is still
// there. The name was the visible edge of the real fault -- Conduit's own
// session token survived a sign-out, so /accounts/me kept answering with the
// previous account and every cached read under it was that account's too.
//
// There were two sign-out paths. The dashboard's button did the whole job; the
// nav's button -- the one reachable from every other page, and the one anyone
// on a phone actually presses -- disconnected the wallet and cleared the Circle
// session while leaving the cs_ token in localStorage.
//
// So this asserts the one thing that was untrue: after a sign-out, nothing that
// authenticates as the previous account is left in the browser. It drives the
// real page and the real event, not a mock of either.
//
//   node scripts/session-isolation.mjs http://localhost:3000
//
// Exit 0 = the browser is clean afterwards. Exit 1 = something survived.

import { chromium } from "playwright";

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");

// The keys the app actually uses. Kept as literals on purpose: if one is
// renamed in lib/conduit-api and not here, this test starts passing for the
// wrong reason, and a test that cannot fail is worse than no test.
const SESSION_KEY = "conduit_dashboard_session_token";
const CIRCLE_KEY = "conduit.circleSession";
const SIGN_OUT_EVENT = "conduit:sign-out";

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
let failures = 0;

const check = (ok, label, detail) => {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("        " + detail);
  }
};

await page.goto(base + "/send", { waitUntil: "networkidle", timeout: 45000 });

// Somebody is signed in. Seeded rather than driven through Google, because the
// question here is what sign-out removes, not what sign-in creates.
await page.evaluate(
  ([sessionKey, circleKey]) => {
    localStorage.setItem(sessionKey, "cs_account_a_token");
    localStorage.setItem(circleKey, JSON.stringify({ userToken: "ut_a", encryptionKey: "ek_a" }));
    localStorage.setItem("conduit.lastMerchant", "acct_a");
  },
  [SESSION_KEY, CIRCLE_KEY],
);

const before = await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY);
check(before === "cs_account_a_token", "a session is present to begin with", `got ${before}`);

// The nav's sign-out, exactly as the button fires it.
await page.evaluate((evt) => window.dispatchEvent(new Event(evt)), SIGN_OUT_EVENT);
await page.waitForTimeout(2500);

const after = await page.evaluate(
  ([sessionKey, circleKey]) => ({
    session: localStorage.getItem(sessionKey),
    circle: localStorage.getItem(circleKey),
    lastMerchant: localStorage.getItem("conduit.lastMerchant"),
  }),
  [SESSION_KEY, CIRCLE_KEY],
);

// The one that was broken, and the whole reason a second account saw the
// first's name: this token authenticates /accounts/me.
check(
  after.session === null,
  "the Conduit session token is gone after sign-out",
  `still present: ${after.session}`,
);
check(after.circle === null, "the Circle session is gone after sign-out", `still present: ${after.circle}`);
check(
  after.lastMerchant === null,
  "no leftover pointer to the previous account",
  `still present: ${after.lastMerchant}`,
);

await browser.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed — a signed-out browser still carries the previous account.`);
  process.exit(1);
}
console.log("\nSign-out leaves nothing behind.");
