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

// Circle identifies the browser, not the human. Persisted so a repeat login
// from this machine is recognised as the same device.
const DEVICE_ID_KEY = "conduit_circle_device_id";
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
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

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
    const stashed = sessionStorage.getItem(RESUME_KEY);
    const provider = localStorage.getItem("socialLoginProvider");
    const notes = [
      `callback hash at load: ${CALLBACK_AT_LOAD ? `present (${CALLBACK_AT_LOAD.length} chars)` : "ABSENT"}`,
      `has id_token: ${CALLBACK_AT_LOAD.includes("id_token") ? "yes" : "no"}`,
      `pending run to resume: ${stashed ? "yes" : "no"}`,
      `SDK socialLoginProvider: ${provider || "(unset)"}`,
    ];
    setDiag(notes);

    // Came back from Google but nothing was waiting to resume: the run that
    // started the sign-in is gone and its device token with it, so there is
    // nothing to continue and starting over silently would just loop.
    if (!stashed) {
      if (CALLBACK_AT_LOAD.includes("id_token")) {
        setVerdict(
          "Google came back with a token, but this page had no run waiting for it. " +
            "Press Run spike to start a fresh attempt."
        );
      }
      return;
    }
    sessionStorage.removeItem(RESUME_KEY); // one shot: never loop on a failure

    (async () => {
      setBusy(true);
      set(0, "pass", "restored after redirect");
      set(1, "running", "completing sign-in…");
      try {
        const { deviceToken, deviceEncryptionKey } = JSON.parse(stashed);
        const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
        const session = await new Promise<{ userToken: string; encryptionKey: string }>(
          (resolve, reject) => {
            const sdk = new W3SSdk(
              {
                appSettings: { appId: APP_ID },
                loginConfigs: {
                  deviceToken,
                  deviceEncryptionKey,
                  google: {
                    clientId: GOOGLE_CLIENT_ID,
                    redirectUri: window.location.origin + SPIKE_PATH,
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
            );
            sdkRef.current = sdk;
            // The SDK consumes the hash in its constructor and calls back
            // asynchronously. If it never does, the page would sit on step 2
            // forever looking like a hang -- so fail loudly with the state that
            // explains why instead.
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Circle's SDK never completed the login. " + notes.join(" · ")
                  )
                ),
              20_000
            );
          }
        );
        await finish(session);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set(1, "fail", msg);
        setVerdict(`Stopped: ${msg}`);
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const api = async (path: string, init?: RequestInit & { userToken?: string }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init?.userToken) headers["X-Circle-User-Token"] = init.userToken;
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
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
    set(3, "running");
    const wallets = await api("/v1/auth/circle/wallets", { userToken: session.userToken });
    const wallet =
      (wallets.data ?? []).find((w: { blockchain?: string }) => w.blockchain === "ARC-TESTNET") ??
      (wallets.data ?? [])[0];
    if (!wallet?.address) throw new Error("no wallet returned");
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

      // 1 — device token. Minted server-side; the API key never reaches here.
      set(0, "running");
      const device = deviceId();
      const dev = await api("/v1/auth/circle/device", {
        method: "POST",
        body: JSON.stringify({ device_id: device }),
      });
      set(0, "pass", `device ${device.slice(0, 8)}…`);

      // 2 — Google sign-in through Circle's SDK.
      set(1, "running", "waiting for Google…");
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const session = await new Promise<{ userToken: string; encryptionKey: string }>(
        (resolve, reject) => {
          const sdk = new W3SSdk(
            {
              appSettings: { appId: APP_ID },
              loginConfigs: {
                deviceToken: dev.device_token,
                deviceEncryptionKey: dev.device_encryption_key,
                google: {
                  clientId: GOOGLE_CLIENT_ID,
                  redirectUri: window.location.origin + SPIKE_PATH,
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
          );
          sdkRef.current = sdk;
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
        }
      );
      set(1, "pass");

      await finish(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSteps((prev) => {
        const i = prev.findIndex((s) => s.status === "running");
        if (i === -1) return prev;
        return prev.map((s, idx) => (idx === i ? { ...s, status: "fail", detail: msg } : s));
      });
      setVerdict(`Stopped: ${msg}`);
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
