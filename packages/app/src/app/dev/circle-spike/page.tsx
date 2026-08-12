"use client";

// Phase 1 spike for the Privy → Circle Wallets migration. Not linked from
// anywhere and not part of the product.
//
// It answers one question, and the whole migration depends on the answer:
//
//   Can a Circle user-controlled wallet, created by signing in with Google,
//   produce an EIP-712 signature that recovers to its own address?
//
// If yes, StableFX works, and the rest is adapter plumbing. If no, the
// migration stops here — Circle rejects a trade whose signature recovers to an
// address other than the registered one (error 3015), and this exact failure
// has already been seen once with Privy's embedded wallet (see
// lib/sign-typed-data.ts). Better to find it on a page nobody uses.
//
// The recover step runs locally rather than trusting what the wallet reports
// as its address: what a provider *says* it signed with and what it *actually*
// signed with are not guaranteed to agree, which is precisely the bug class.

import { useEffect, useRef, useState } from "react";
import { buildSpikePayload } from "@/lib/circle/spike-payload";

const API_BASE = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "http://localhost:8080";
const APP_ID = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? "";
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

// The device id is NOT ours to invent.
//
// This page used to mint a crypto.randomUUID() and keep it in localStorage,
// which read as reasonable and was wrong: Circle only accepts a device it
// registered itself. A made-up id verifies the Google token fine and is then
// refused at the final step with 155140 "Provided device ID is not found in
// the system" -- the failure lands one step away from its cause, which is why
// it looked like the login was broken. sdk.getDeviceId() asks Circle's own
// iframe for the id; it lives under pw-auth.circle.com's origin, so it is
// already stable per browser and needs no storage from us.
// Google performs a full-page redirect, so the spike must come back to ITSELF.
// Pointing this at the origin sent the browser to the landing page, where the
// run's state no longer existed and steps 3-6 simply never happened.
const SPIKE_PATH = "/dev/circle-spike";
// The device token/key were minted before the redirect and cannot be re-derived
// after it, so the resumed page has to find them where the outgoing page left
// them. sessionStorage, not localStorage: this is one run, not a preference.
const RESUME_KEY = "conduit_circle_spike_resume";

// Snapshot of the OAuth callback, taken at module scope — i.e. before React
// mounts and before any SDK instance can run history.replaceState over it.
// Reading this inside an effect is too late: the SDK strips the hash as soon as
// it consumes it, so an effect that finds nothing cannot tell "Google never
// came back" apart from "something already ate the answer". Those need very
// different fixes, which is why this is captured rather than inferred.
const CALLBACK_AT_LOAD =
  typeof window === "undefined"
    ? ""
    : window.location.hash && window.location.hash.length > 1
      ? window.location.hash.slice(1)
      : "";

// The stash is read and cleared HERE, at module scope, for the same reason as
// the hash above: it is a one-shot value and the effect that consumes it is not
// run once. React StrictMode (on by default in Next dev) mounts every component
// twice, so an effect that did `getItem` then `removeItem` would succeed on the
// first pass and then, on the second, find nothing and report "no run waiting
// to resume" -- overwriting the diagnostics of the run it had just started.
// That is exactly what made a working redirect look like a dead end. Module
// scope runs once per page load, which is precisely the lifetime this value has.
const RESUME_AT_LOAD: { deviceToken: string; deviceEncryptionKey: string } | null = (() => {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(RESUME_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(RESUME_KEY); // never loop on a failed resume
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
})();

type Status = "pending" | "running" | "pass" | "fail";
interface Step {
  name: string;
  status: Status;
  detail?: string;
}

const STEPS = [
  "Get device token",
  "Google sign-in",
  "Create wallet on Arc",
  "Load wallet",
  "Sign StableFX payload",
  "Recover signer",
] as const;

export default function CircleSpikePage() {
  const [steps, setSteps] = useState<Step[]>(
    STEPS.map((name) => ({ name, status: "pending" as Status }))
  );
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<string>("");
  // What the page knows about how it got here. Shown on screen so a failed run
  // reports its own cause instead of being described second-hand.
  const [diag, setDiag] = useState<string[]>([]);
  const sdkRef = useRef<unknown>(null);
  const resumedRef = useRef(false);
  // Whoever is currently waiting for a login to complete. Settled by either the
  // SDK's callback or the verify-token message, whichever arrives — the second
  // one to arrive finds this null and does nothing.
  const loginWaiterRef = useRef<{
    resolve: (s: { userToken: string; encryptionKey: string }) => void;
    reject: (e: Error) => void;
  } | null>(null);

  // Mark the step that was in flight as failed. Shared by both entry paths so
  // a failure is always attributed to the step that actually raised it.
  const failRunningStep = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.status === "running");
      if (i === -1) return prev;
      return prev.map((s, idx) => (idx === i ? { ...s, status: "fail", detail: msg } : s));
    });
    setVerdict(`Stopped: ${msg}`);
  };

  const note = (line: string) =>
    setDiag((prev) => (prev.includes(line) ? prev : [...prev, line]));

  // Watch Circle's iframe handshake.
  //
  // onLoginComplete only ever fires from a postMessage: the SDK appends a
  // hidden iframe at pw-auth.circle.com/social/verify-token, that frame posts
  // `onFrameReady`, the SDK posts the id_token and device token back into it,
  // and the frame answers `onSocialLoginVerified`. Break any link in that chain
  // and NOTHING is reported -- the SDK's own 10s guard calls this.onComplete,
  // which is the *challenge* callback and is undefined during login, so the
  // failure is swallowed whole. That silence is what we have been staring at.
  //
  // Two known ways it breaks, which this tells apart:
  //   - the frame never loads or never answers (blocked origin, network), so
  //     no message with this origin ever arrives;
  //   - `this.iframe` is undefined, because W3SSdk is a singleton whose
  //     constructor, on a SECOND construction, runs setup on a throwaway object
  //     that skipped createElement and then returns the first instance. The
  //     resulting TypeError surfaces only as an unhandled rejection.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== "https://pw-auth.circle.com") return;
      const data = (e.data ?? {}) as Record<string, unknown>;
      note(`iframe → page: ${Object.keys(data).join(",") || "(empty)"}`);

      // The verified login result, straight from Circle's service.
      //
      // Taking it here rather than waiting for the SDK's onLoginComplete is
      // not a shortcut around the real flow -- it IS the real flow. This is
      // the same postMessage, from Circle's own origin, carrying the same
      // payload the SDK would have forwarded. The SDK receives it and then
      // fails to hand it on, so the run stalls holding a completed login.
      const verified = data.onSocialLoginVerified as
        | { error?: { code?: number; message?: string }; result?: Record<string, unknown> }
        | undefined;
      if (!verified) return;

      note(
        `onSocialLoginVerified: error=${
          verified.error ? `${verified.error.code} ${verified.error.message}` : "none"
        } result keys=${Object.keys(verified.result ?? {}).join(",") || "(none)"}`
      );

      const waiting = loginWaiterRef.current;
      if (!waiting) {
        note("…but no run was waiting for it");
        return;
      }
      loginWaiterRef.current = null;
      if (verified.error) {
        waiting.reject(
          new Error(`Circle rejected the login: ${verified.error.code} ${verified.error.message}`)
        );
        return;
      }
      const r = verified.result as
        | { userToken?: string; encryptionKey?: string }
        | undefined;
      if (!r?.userToken || !r?.encryptionKey) {
        waiting.reject(new Error("Circle verified the login but returned no user token"));
        return;
      }
      note("login completed from the verify-token message");
      waiting.resolve({ userToken: r.userToken, encryptionKey: r.encryptionKey });
    };
    const onRej = (e: PromiseRejectionEvent) =>
      note(`unhandled rejection: ${String(e.reason?.message ?? e.reason)}`);
    window.addEventListener("message", onMsg);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("unhandledrejection", onRej);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build the SDK without ever constructing a second one in a page load.
  //
  // W3SSdk keeps a static singleton. Its constructor, when one already exists,
  // runs setupInstance on the NEW object -- which skipped `this.iframe =
  // createElement` -- and then returns the old instance. So the setup path
  // (including the whole social-login hash check) executes against an object
  // whose iframe is undefined, and `this.iframe.src = …` throws inside an async
  // method nobody awaits. The callback you passed is attached to the throwaway;
  // the instance you get back still has the old one. Everything after that is
  // silence. updateConfigs is the supported way to re-point the live instance.
  const makeSdk = async (
    configs: ConstructorParameters<typeof import("@circle-fin/w3s-pw-web-sdk").W3SSdk>[0],
    cb: (err: unknown, result: unknown) => void
  ) => {
    const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
    const existing = sdkRef.current as
      | import("@circle-fin/w3s-pw-web-sdk").W3SSdk
      | null;
    if (existing) {
      note("reusing the existing W3SSdk (a second construction would break it)");
      existing.updateConfigs(configs, cb);
      return existing;
    }
    const sdk = new W3SSdk(configs, cb);
    sdkRef.current = sdk;
    return sdk;
  };

  // Did the SDK actually get an iframe into the document, and did it load?
  const watchIframe = () => {
    let tries = 0;
    const t = setInterval(() => {
      const f = document.getElementById("sdkIframe") as HTMLIFrameElement | null;
      if (f) {
        clearInterval(t);
        note(`sdk iframe appended: ${f.src}`);
        f.addEventListener("load", () => note("sdk iframe: loaded"));
        f.addEventListener("error", () => note("sdk iframe: FAILED to load"));
      } else if (++tries > 20) {
        clearInterval(t);
        note("sdk iframe: never appended — the SDK never reached verifyTokenViaService");
      }
    }, 250);
  };

  const set = (i: number, status: Status, detail?: string) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, status, detail } : s)));

  // Resume after Google's redirect.
  //
  // performLogin navigates the whole page away, so the run that started the
  // sign-in no longer exists when the browser comes back. Without this the
  // spike stopped dead at step 2 with nothing on screen to say why. Rebuilding
  // the SDK with the SAME device token is what lets its onLoginComplete fire
  // for the callback now in the URL; from there the flow re-enters at step 3.
  useEffect(() => {
    const provider = localStorage.getItem("socialLoginProvider");
    // Show what Google actually sent back. Long opaque values are truncated --
    // an id_token is a credential, and this is the one place tempted to print
    // one. The KEYS are what identify the failure: `error` means Google
    // refused, `state`/`nonce` alone means it answered something else entirely.
    const hashDetail = CALLBACK_AT_LOAD
      ? Array.from(new URLSearchParams(CALLBACK_AT_LOAD).entries())
          .map(([k, v]) => `${k}=${v.length > 24 ? v.slice(0, 24) + "…" : v}`)
          .join("  ")
      : "(none)";
    const notes = [
      `callback hash at load: ${CALLBACK_AT_LOAD ? `present (${CALLBACK_AT_LOAD.length} chars)` : "ABSENT"}`,
      `hash contents: ${hashDetail}`,
      `has id_token: ${CALLBACK_AT_LOAD.includes("id_token") ? "yes" : "no"}`,
      `pending run to resume: ${RESUME_AT_LOAD ? "yes" : "no"}`,
      `sessionStorage survived redirect: ${sessionStorage.length > 0 ? `yes (${sessionStorage.length} keys)` : "NO — empty"}`,
      `SDK socialLoginProvider: ${provider || "(unset)"}`,
    ];
    // Merge, don't replace: StrictMode runs this effect twice, and a plain
    // replace on the second pass would erase the handshake lines the listeners
    // had already appended -- losing exactly the evidence they exist to collect.
    setDiag((prev) => [...notes, ...prev.filter((p) => !notes.includes(p))]);

    // Came back from Google but nothing was waiting to resume: the run that
    // started the sign-in is gone and its device token with it, so there is
    // nothing to continue and starting over silently would just loop.
    if (!RESUME_AT_LOAD) {
      if (CALLBACK_AT_LOAD.includes("id_token")) {
        setVerdict(
          "Google came back with a token, but this page had no run waiting for it. " +
            "Press Run spike to start a fresh attempt."
        );
      }
      return;
    }
    // StrictMode's second mount must not build a second SDK over the same
    // one-shot callback hash: the first instance has already consumed it.
    if (resumedRef.current) return;
    resumedRef.current = true;

    (async () => {
      setBusy(true);
      set(0, "pass", "restored after redirect");
      set(1, "running", "completing sign-in…");
      try {
        const { deviceToken, deviceEncryptionKey } = RESUME_AT_LOAD;
        const session = await new Promise<{ userToken: string; encryptionKey: string }>(
          (resolve, reject) => {
            // Register BEFORE the SDK is built: its constructor consumes the
            // callback hash and starts the verify-token exchange immediately,
            // so a waiter installed afterwards can miss the answer.
            loginWaiterRef.current = { resolve, reject };
            void makeSdk(
              {
                appSettings: { appId: APP_ID },
                loginConfigs: {
                  deviceToken,
                  deviceEncryptionKey,
                  google: {
                    clientId: GOOGLE_CLIENT_ID,
                    redirectUri: window.location.origin + SPIKE_PATH,
                    selectAccountPrompt: true,
                  },
                },
              },
              // Kept wired even though the verify-token message is what
              // actually settles this today: if a later SDK release starts
              // delivering the callback, this is the path that should win.
              (err: unknown, result: unknown) => {
                const waiting = loginWaiterRef.current;
                if (!waiting) return; // already settled by the message
                loginWaiterRef.current = null;
                note("login completed from the SDK callback");
                if (err) return waiting.reject(err instanceof Error ? err : new Error(String(err)));
                const r = result as { userToken?: string; encryptionKey?: string } | undefined;
                if (!r?.userToken || !r?.encryptionKey) {
                  return waiting.reject(new Error("login returned no user token"));
                }
                waiting.resolve({ userToken: r.userToken, encryptionKey: r.encryptionKey });
              }
            ).catch(reject);
            watchIframe();
            // The SDK consumes the hash in its constructor and calls back
            // asynchronously. If it never does, the page would sit on step 2
            // forever looking like a hang -- so fail loudly with the state that
            // explains why instead.
            setTimeout(() => {
              if (!loginWaiterRef.current) return; // already settled
              loginWaiterRef.current = null;
              reject(
                new Error("Circle's SDK never completed the login. " + notes.join(" · "))
              );
            }, 20_000);
          }
        );
        await finish(session);
      } catch (err) {
        // Blame whichever step was actually running, not step 2. Hardcoding
        // step 2 here reported a step 3 network failure as a failed Google
        // sign-in -- on a run whose own log showed the login had completed.
        failRunningStep(err);
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const api = async (path: string, init?: RequestInit & { userToken?: string }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init?.userToken) headers["X-Circle-User-Token"] = init.userToken;
    // "Failed to fetch" is what the browser says for a blocked CORS preflight
    // and for a dead server alike, with nothing in the API log either way
    // because the request never arrives. Name both so the next one is one
    // check, not an investigation.
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers }).catch(() => {
      throw new Error(
        `could not reach ${API_BASE}${path} — the API is down, or CORS refused the request` +
          (init?.userToken ? " (this call sends X-Circle-User-Token)" : "")
      );
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    // `param` carries the cause on a 500: the API renders CodeInternal as the
    // registry's "An internal error occurred." and puts what actually went
    // wrong in `param`. Reading only `message` turned every upstream Circle
    // failure into the same six words with nothing to act on.
    if (!res.ok) {
      const e = json?.error as { message?: string; param?: string } | undefined;
      throw new Error(
        [e?.message ?? `HTTP ${res.status}`, e?.param].filter(Boolean).join(" — ")
      );
    }
    return json;
  };


  // Steps 3-6. Split out of run() because there are two ways to arrive here:
  // straight through on a first attempt, or on a fresh page after Google's
  // redirect. Both must execute identically -- the redirect is a detour, not a
  // different flow.
  const finish = async (session: { userToken: string; encryptionKey: string }) => {
    set(1, "pass");

    // 3 — wallet on Arc. An empty challenge means it already existed.
    set(2, "running");
    const init = await api("/v1/auth/circle/initialize", {
      method: "POST",
      userToken: session.userToken,
    });
    const sdk = sdkRef.current as import("@circle-fin/w3s-pw-web-sdk").W3SSdk;
    sdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });

    if (init.challenge_id) {
      await new Promise<void>((resolve, reject) => {
        sdk.execute(init.challenge_id, (e: unknown) =>
          e ? reject(e instanceof Error ? e : new Error(String(e))) : resolve()
        );
      });
      set(2, "pass", "created");
    } else {
      set(2, "pass", "already existed");
    }

    // 4 — the wallet itself.
    //
    // Poll, don't read once. The challenge completing means Circle ACCEPTED
    // the creation, not that the wallet exists: it is provisioned
    // asynchronously, so an immediate GET legitimately returns zero wallets.
    // Reading once turned that normal gap into "no wallet returned" on a run
    // where the wallet was on its way.
    set(3, "running", "waiting for Circle to provision it…");
    type CircleWallet = { id?: string; address?: string; blockchain?: string };
    const deadline = Date.now() + 60_000;
    let wallet: CircleWallet | undefined;
    let attempts = 0;
    for (;;) {
      attempts++;
      const wallets = await api("/v1/auth/circle/wallets", { userToken: session.userToken });
      const list = (wallets.data ?? []) as CircleWallet[];
      // Prefer Arc — that is where Conduit settles — but take anything rather
      // than report nothing: a wallet on the wrong chain is a different and
      // much more useful failure than an absent one.
      wallet = list.find((w) => w.blockchain === "ARC-TESTNET") ?? list[0];
      if (wallet?.address) {
        if (attempts > 1) note(`wallet appeared after ${attempts} polls`);
        if (list.length > 1) note(`chains returned: ${list.map((w) => w.blockchain).join(",")}`);
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Circle returned no wallets after ${attempts} polls over 60s. The create-wallet ` +
            `challenge succeeded, so this is provisioning or a chain Circle did not accept ` +
            `(asked for ARC-TESTNET).`
        );
      }
      set(3, "running", `waiting for Circle to provision it… (poll ${attempts})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    set(3, "pass", `${wallet.address} (${wallet.blockchain})`);

    // 5 — sign a real StableFX-shaped payload.
    set(4, "running", "approve in the Circle dialog…");
    const payload = buildSpikePayload(wallet.address);
    const challenge = await api("/v1/auth/circle/sign_typed_data", {
      method: "POST",
      userToken: session.userToken,
      body: JSON.stringify({ wallet_id: wallet.id, data: payload }),
    });
    const signature = await new Promise<string>((resolve, reject) => {
      sdk.execute(challenge.challenge_id, (e: unknown, result: unknown) => {
        if (e) return reject(e instanceof Error ? e : new Error(String(e)));
        const sig = (result as { data?: { signature?: string } })?.data?.signature;
        if (!sig) return reject(new Error("challenge returned no signature"));
        resolve(sig);
      });
    });
    set(4, "pass", `${signature.slice(0, 20)}…`);

    // 6 — the actual gate. Recover locally; don't take the wallet's word.
    set(5, "running");
    const { ethers } = await import("ethers");
    const { EIP712Domain: _omit, ...types } = payload.types;
    const recovered = ethers.verifyTypedData(payload.domain, types, payload.message, signature);
    const matches = recovered.toLowerCase() === wallet.address.toLowerCase();
    set(5, matches ? "pass" : "fail", `recovered ${recovered}`);

    setVerdict(
      matches
        ? "PASS — the signature recovers to the wallet's own address. StableFX will accept this wallet."
        : `FAIL — recovered ${recovered} but the wallet is ${wallet.address}. Circle would reject this trade (3015). Do not migrate on this.`
    );
  };

  const run = async () => {
    setBusy(true);
    setVerdict("");
    setSteps(STEPS.map((name) => ({ name, status: "pending" as Status })));

    try {
      if (!APP_ID || !GOOGLE_CLIENT_ID) {
        throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID / NEXT_PUBLIC_GOOGLE_CLIENT_ID not set");
      }

      // 1 — the device, then its token.
      //
      // Order matters and is not interchangeable: Circle issues the device id
      // from its own iframe, and the token is minted FOR that id. Asking our
      // API first, with an id Circle has never seen, is what produced 155140.
      // The token itself is minted server-side; the API key never reaches here.
      set(0, "running", "asking Circle for a device id…");
      const sdk = await makeSdk({ appSettings: { appId: APP_ID } }, () => {});
      watchIframe();
      const device = await sdk.getDeviceId();
      const dev = await api("/v1/auth/circle/device", {
        method: "POST",
        body: JSON.stringify({ device_id: device }),
      });
      set(0, "pass", `device ${device.slice(0, 8)}… (from Circle)`);

      // 2 — Google sign-in through Circle's SDK.
      set(1, "running", "waiting for Google…");
      const session = await new Promise<{ userToken: string; encryptionKey: string }>(
        (resolve, reject) => {
          void makeSdk(
            {
              appSettings: { appId: APP_ID },
              loginConfigs: {
                deviceToken: dev.device_token,
                deviceEncryptionKey: dev.device_encryption_key,
                google: {
                  clientId: GOOGLE_CLIENT_ID,
                  redirectUri: window.location.origin + SPIKE_PATH,
                  // MUST be true. The SDK builds the Google URL as
                  //   prompt=${selectAccountPrompt ? 'select_account' : 'none'}
                  // so omitting it asks Google to authenticate with NO user
                  // interaction at all. Google cannot, and bounces straight
                  // back with error=interaction_required — which looks exactly
                  // like the page reloading itself for no reason.
                  selectAccountPrompt: true,
                },
              },
            },
            (err: unknown, result: unknown) => {
              if (err) return reject(err instanceof Error ? err : new Error(String(err)));
              const r = result as { userToken?: string; encryptionKey?: string } | undefined;
              if (!r?.userToken || !r?.encryptionKey) {
                return reject(new Error("login returned no user token"));
              }
              resolve({ userToken: r.userToken, encryptionKey: r.encryptionKey });
            }
          ).then((sdk) => {
            // Stash before leaving: the redirect discards everything in memory.
            sessionStorage.setItem(
              RESUME_KEY,
              JSON.stringify({
                deviceToken: dev.device_token,
                deviceEncryptionKey: dev.device_encryption_key,
              })
            );
            // performLogin takes SocialLoginProvider, which the package imports
            // but never re-exports — it is unreachable from the package root, so
            // it cannot be named here. It is a STRING enum whose GOOGLE member is
            // literally "Google", so the value passed is exactly what the enum
            // holds; only the compile-time name is missing.
            void (sdk as unknown as { performLogin: (p: string) => Promise<void> })
              .performLogin("Google");
          }, reject);
        }
      );
      set(1, "pass");

      await finish(session);
    } catch (err) {
      failRunningStep(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-ink">Circle Wallets — Phase 1 spike</h1>
      <p className="text-ink-dim text-sm mt-2">
        Signs a StableFX-shaped EIP-712 payload with a Google-provisioned Circle wallet and checks
        the signature recovers to that wallet&apos;s own address. Not part of the product.
      </p>

      <button
        onClick={run}
        disabled={busy}
        className="mt-6 bg-signal text-signal-ink font-mono px-5 py-2.5 text-sm disabled:opacity-50"
      >
        {busy ? "Running…" : "Run spike"}
      </button>

      <ol className="mt-8 space-y-2">
        {steps.map((s, i) => (
          <li key={s.name} className="border border-border bg-surface p-3">
            <div className="flex items-center gap-3">
              <span
                className={`w-2 h-2 shrink-0 ${
                  s.status === "pass"
                    ? "bg-signal"
                    : s.status === "fail"
                      ? "bg-danger"
                      : s.status === "running"
                        ? "bg-signal animate-pulse"
                        : "bg-border"
                }`}
              />
              <span className="text-ink text-sm font-mono">
                {i + 1}. {s.name}
              </span>
            </div>
            {s.detail && (
              <p className="text-ink-dim text-xs font-mono mt-1.5 pl-5 break-all">{s.detail}</p>
            )}
          </li>
        ))}
      </ol>

      {diag.length > 0 && (
        <div className="mt-6 border border-border bg-surface p-4">
          <p className="text-[10px] font-mono text-ink-dim uppercase tracking-wider mb-2">
            How this page loaded
          </p>
          {diag.map((d) => (
            <p key={d} className="text-ink-dim text-xs font-mono">
              {d}
            </p>
          ))}
        </div>
      )}

      {verdict && (
        <p
          className={`mt-6 p-4 border text-sm ${
            verdict.startsWith("PASS")
              ? "border-signal/40 bg-signal/10 text-ink"
              : "border-danger/40 bg-danger/10 text-danger"
          }`}
        >
          {verdict}
        </p>
      )}
    </main>
  );
}
