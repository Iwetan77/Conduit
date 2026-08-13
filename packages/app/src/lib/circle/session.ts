"use client";

// Google sign-in against a Circle user-controlled wallet, as a hook.
//
// Extracted from the Phase 1 spike rather than reimplemented. Every branch
// here exists because of a specific failure observed against the live API, and
// each one is a silent failure — the flow does not error, it simply stops.
// Writing this a second time from the docs would reproduce all of them:
//
//   - The device id MUST come from sdk.getDeviceId(). Circle happily mints a
//     device token for an id you invent and then refuses the login at the very
//     end with 155140, one hop away from the cause.
//   - W3SSdk keeps a static singleton. A second construction in one page load
//     runs setup on a throwaway object that skipped createElement, then returns
//     the first instance — so the new callback is attached to the discarded
//     object and `this.iframe.src` throws inside an unawaited async method.
//   - Google's sign-in is a full-page redirect, so the run that started it is
//     gone when the browser returns. The device token cannot be re-derived and
//     has to be stashed across the navigation.
//   - selectAccountPrompt must be true, or the SDK asks Google for
//     prompt=none and Google bounces back with interaction_required.
//   - The login result arrives as a postMessage from pw-auth.circle.com. The
//     SDK has been observed receiving it without invoking onLoginComplete; its
//     own timeout reports to onComplete, which is undefined during login, so
//     the failure is swallowed entirely.
//   - Wallet creation is asynchronous. A completed challenge means Circle
//     accepted it, not that the wallet exists.

import { useCallback, useEffect, useRef, useState } from "react";

const RESUME_KEY = "conduit_circle_resume";
const CIRCLE_AUTH_ORIGIN = "https://pw-auth.circle.com";

// Captured at module scope — before React mounts and before any SDK instance
// can run history.replaceState over it. Read in an effect it is already gone,
// and "Google never came back" cannot be told apart from "something ate the
// answer".
const CALLBACK_AT_LOAD =
  typeof window === "undefined"
    ? ""
    : window.location.hash && window.location.hash.length > 1
      ? window.location.hash.slice(1)
      : "";

// Read and cleared at module scope for the same reason, plus one more: React
// StrictMode mounts effects twice in dev, so an effect that read then removed
// this would succeed on the first pass and report "nothing to resume" on the
// second — overwriting the state of the run it had just started.
const RESUME_AT_LOAD: { deviceToken: string; deviceEncryptionKey: string } | null = (() => {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(RESUME_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(RESUME_KEY);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
})();

export type CircleStatus = "idle" | "connecting" | "ready" | "error";

export interface CircleWallet {
  id: string;
  address: string;
  blockchain: string;
}

export interface CircleSession {
  status: CircleStatus;
  error?: string;
  wallet?: CircleWallet;
  userToken?: string;
  /** True when this page load is completing a redirect from Google. */
  resuming: boolean;
  signIn: () => void;
  /** Runs a Circle challenge in Circle's own UI. */
  execute: (challengeId: string) => Promise<unknown>;
  log: string[];
}

export interface CircleSessionOptions {
  apiBase: string;
  appId: string;
  googleClientId: string;
  /** Path Google redirects back to. Must be this page, and registered in GCP. */
  redirectPath: string;
  /** Chain the wallet must exist on. */
  blockchain?: string;
}

export function useCircleSession(opts: CircleSessionOptions): CircleSession {
  const { apiBase, appId, googleClientId, redirectPath } = opts;
  const blockchain = opts.blockchain ?? "ARC-TESTNET";

  const [status, setStatus] = useState<CircleStatus>("idle");
  const [error, setError] = useState<string>();
  const [wallet, setWallet] = useState<CircleWallet>();
  const [userToken, setUserToken] = useState<string>();
  const [log, setLog] = useState<string[]>([]);

  const sdkRef = useRef<unknown>(null);
  const resumedRef = useRef(false);
  const waiterRef = useRef<{
    resolve: (s: { userToken: string; encryptionKey: string }) => void;
    reject: (e: Error) => void;
  } | null>(null);

  const note = useCallback((line: string) => {
    setLog((prev) => (prev.includes(line) ? prev : [...prev, line]));
  }, []);

  const api = useCallback(
    async (path: string, init?: RequestInit & { token?: string }) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (init?.token) headers["X-Circle-User-Token"] = init.token;
      const res = await fetch(`${apiBase}${path}`, { ...init, headers }).catch(() => {
        throw new Error(
          `could not reach ${apiBase}${path} — the API is down, or CORS refused the request` +
            (init?.token ? " (this call sends X-Circle-User-Token)" : "")
        );
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const e = json?.error as { message?: string; param?: string } | undefined;
        throw new Error([e?.message ?? `HTTP ${res.status}`, e?.param].filter(Boolean).join(" — "));
      }
      return json;
    },
    [apiBase]
  );

  // Settle the login from Circle's own postMessage. See the header note: the
  // SDK receives this and does not always pass it on.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== CIRCLE_AUTH_ORIGIN) return;
      const verified = (e.data as Record<string, unknown> | null)?.[
        "onSocialLoginVerified"
      ] as
        | { error?: { code?: number; message?: string }; result?: Record<string, unknown> }
        | undefined;
      if (!verified) return;

      const waiting = waiterRef.current;
      if (!waiting) return;
      waiterRef.current = null;

      if (verified.error) {
        waiting.reject(
          new Error(`Circle rejected the login: ${verified.error.code} ${verified.error.message}`)
        );
        return;
      }
      const r = verified.result as { userToken?: string; encryptionKey?: string } | undefined;
      if (!r?.userToken || !r?.encryptionKey) {
        waiting.reject(new Error("Circle verified the login but returned no user token"));
        return;
      }
      waiting.resolve({ userToken: r.userToken, encryptionKey: r.encryptionKey });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  /** Build the SDK, never constructing a second one in a page load. */
  const makeSdk = useCallback(
    async (
      configs: ConstructorParameters<typeof import("@circle-fin/w3s-pw-web-sdk").W3SSdk>[0],
      cb: (err: unknown, result: unknown) => void
    ) => {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const existing = sdkRef.current as import("@circle-fin/w3s-pw-web-sdk").W3SSdk | null;
      if (existing) {
        existing.updateConfigs(configs, cb);
        return existing;
      }
      const sdk = new W3SSdk(configs, cb);
      sdkRef.current = sdk;
      return sdk;
    },
    []
  );

  const execute = useCallback(async (challengeId: string) => {
    const sdk = sdkRef.current as import("@circle-fin/w3s-pw-web-sdk").W3SSdk | null;
    if (!sdk) throw new Error("no Circle session — sign in first");
    return new Promise<unknown>((resolve, reject) => {
      sdk.execute(challengeId, (e: unknown, result: unknown) =>
        e ? reject(e instanceof Error ? e : new Error(JSON.stringify(e))) : resolve(result)
      );
    });
  }, []);

  /** Wallet on the target chain, waiting for Circle to provision it. */
  const loadWallet = useCallback(
    async (token: string): Promise<CircleWallet> => {
      const init = await api("/v1/auth/circle/initialize", { method: "POST", token });
      if (init.challenge_id) {
        note("creating your wallet…");
        await execute(init.challenge_id);
      }
      const deadline = Date.now() + 60_000;
      for (;;) {
        const res = await api("/v1/auth/circle/wallets", { token });
        const list = (res.data ?? []) as CircleWallet[];
        const found = list.find((w) => w.blockchain === blockchain) ?? list[0];
        if (found?.address) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `Circle returned no wallets after 60s. The create-wallet challenge succeeded, ` +
              `so this is provisioning or a chain Circle did not accept (asked for ${blockchain}).`
          );
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
    [api, blockchain, execute, note]
  );

  const finishLogin = useCallback(
    async (session: { userToken: string; encryptionKey: string }) => {
      const sdk = sdkRef.current as import("@circle-fin/w3s-pw-web-sdk").W3SSdk;
      sdk.setAuthentication({
        userToken: session.userToken,
        encryptionKey: session.encryptionKey,
      });
      setUserToken(session.userToken);
      const w = await loadWallet(session.userToken);
      setWallet(w);
      setStatus("ready");
      note(`wallet ${w.address} on ${w.blockchain}`);
    },
    [loadWallet, note]
  );

  // Resume after Google's redirect.
  useEffect(() => {
    if (!RESUME_AT_LOAD || resumedRef.current) return;
    resumedRef.current = true;

    (async () => {
      setStatus("connecting");
      note("completing sign-in…");
      try {
        const session = await new Promise<{ userToken: string; encryptionKey: string }>(
          (resolve, reject) => {
            waiterRef.current = { resolve, reject };
            void makeSdk(
              {
                appSettings: { appId },
                loginConfigs: {
                  deviceToken: RESUME_AT_LOAD.deviceToken,
                  deviceEncryptionKey: RESUME_AT_LOAD.deviceEncryptionKey,
                  google: {
                    clientId: googleClientId,
                    redirectUri: window.location.origin + redirectPath,
                    selectAccountPrompt: true,
                  },
                },
              },
              (err, result) => {
                const waiting = waiterRef.current;
                if (!waiting) return;
                waiterRef.current = null;
                if (err) {
                  return waiting.reject(err instanceof Error ? err : new Error(String(err)));
                }
                const r = result as { userToken?: string; encryptionKey?: string } | undefined;
                if (!r?.userToken || !r?.encryptionKey) {
                  return waiting.reject(new Error("login returned no user token"));
                }
                waiting.resolve({ userToken: r.userToken, encryptionKey: r.encryptionKey });
              }
            ).catch(reject);
            setTimeout(() => {
              if (!waiterRef.current) return;
              waiterRef.current = null;
              reject(
                new Error(
                  "Circle's SDK never completed the login. " +
                    `callback hash ${CALLBACK_AT_LOAD ? "present" : "ABSENT"}, ` +
                    `id_token ${CALLBACK_AT_LOAD.includes("id_token") ? "yes" : "no"}`
                )
              );
            }, 20_000);
          }
        );
        await finishLogin(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(() => {
    (async () => {
      setStatus("connecting");
      setError(undefined);
      try {
        if (!appId || !googleClientId) {
          throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID / NEXT_PUBLIC_GOOGLE_CLIENT_ID not set");
        }
        // The device id comes from Circle, and the token is minted FOR it.
        // Reversing this order is what produces 155140 at the end of the login.
        note("asking Circle for a device id…");
        const sdk = await makeSdk({ appSettings: { appId } }, () => {});
        const deviceId = await sdk.getDeviceId();
        const dev = await api("/v1/auth/circle/device", {
          method: "POST",
          body: JSON.stringify({ device_id: deviceId }),
        });

        note("redirecting to Google…");
        const configured = await makeSdk(
          {
            appSettings: { appId },
            loginConfigs: {
              deviceToken: dev.device_token,
              deviceEncryptionKey: dev.device_encryption_key,
              google: {
                clientId: googleClientId,
                redirectUri: window.location.origin + redirectPath,
                selectAccountPrompt: true,
              },
            },
          },
          () => {}
        );
        // Stash before leaving: the redirect discards everything in memory and
        // the device token cannot be minted again for the same login.
        sessionStorage.setItem(
          RESUME_KEY,
          JSON.stringify({
            deviceToken: dev.device_token,
            deviceEncryptionKey: dev.device_encryption_key,
          })
        );
        // performLogin takes SocialLoginProvider, which the package imports but
        // never re-exports. It is a string enum whose GOOGLE member is exactly
        // "Google", so only the compile-time name is missing.
        void (configured as unknown as { performLogin: (p: string) => Promise<void> }).performLogin(
          "Google"
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
  }, [api, appId, googleClientId, makeSdk, note, redirectPath]);

  return {
    status,
    error,
    wallet,
    userToken,
    resuming: RESUME_AT_LOAD !== null,
    signIn,
    execute,
    log,
  };
}
