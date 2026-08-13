"use client";

// Circle user-controlled wallet session, with no React in it.
//
// This is the core the rest of the Circle integration binds to. It lives
// outside React because a wagmi connector is not a component and cannot call
// hooks, and the connector is what lets every existing getWalletProvider()
// call site keep working untouched. useCircleSession() is a thin binding over
// this; lib/circle/connector.ts is the other.
//
// State is module-level on purpose. There is exactly one Circle session per
// page — one SDK instance, one wallet, one user token — and the SDK itself
// enforces that with a static singleton whose second construction is broken
// (see ensureSdk). Modelling it as anything other than a singleton would be
// modelling it wrong.
//
// Every branch below exists because of a specific silent failure observed
// against the live API. They are documented where they are handled rather than
// listed here, because the next person will meet them one at a time.

const RESUME_KEY = "conduit_circle_resume";
const SESSION_KEY = "conduit_circle_session";
const CIRCLE_AUTH_ORIGIN = "https://pw-auth.circle.com";

// Circle user tokens last 60 minutes. Treat them as dead a little early so a
// session never expires mid-request: a token that passes the check and then
// expires two seconds later fails somewhere far less legible than sign-in.
const SESSION_TTL_MS = 55 * 60 * 1000;

// Captured at module scope: before React mounts, and before any SDK instance
// can run history.replaceState over the hash. Read this in an effect and it is
// already gone, at which point "Google never came back" is indistinguishable
// from "something already consumed the answer".
const CALLBACK_AT_LOAD =
  typeof window === "undefined"
    ? ""
    : window.location.hash && window.location.hash.length > 1
      ? window.location.hash.slice(1)
      : "";

// Read and cleared at module scope for the same reason, plus one more: React
// StrictMode mounts effects twice in dev, so an effect that read then removed
// this would succeed on the first pass and see nothing on the second —
// reporting "no run to resume" over a run it had just started.
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

export interface CircleWallet {
  id: string;
  address: string;
  blockchain: string;
}

export interface CircleSessionState {
  userToken: string;
  encryptionKey: string;
  wallet: CircleWallet;
}

export interface CircleConfig {
  apiBase: string;
  appId: string;
  googleClientId: string;
  /** Path Google redirects back to. Must be registered in the Google console. */
  redirectPath: string;
  blockchain?: string;
}

let config: CircleConfig | null = null;
let sdk: import("@circle-fin/w3s-pw-web-sdk").W3SSdk | null = null;
let session: CircleSessionState | null = null;
let restoring: Promise<CircleSessionState | null> | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export function configureCircle(c: CircleConfig) {
  config = c;
}
export function circleConfigured(): boolean {
  return !!config?.appId && !!config?.googleClientId;
}
export function currentSession(): CircleSessionState | null {
  return session;
}
/** True when this page load is a return trip from Google. */
export function hasPendingResume(): boolean {
  return RESUME_AT_LOAD !== null;
}
export function onCircleChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function clearCircleSession() {
  session = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Private-browsing modes throw on storage access. Losing persistence is
    // survivable; taking sign-out down with it is not.
  }
  emit();
}

// ── Persistence ──────────────────────────────────────────────────────────────
//
// The session outlives a page refresh, because Circle is replacing Privy
// everywhere and every dashboard route would otherwise bounce the merchant
// through Google on every reload.
//
// What is stored is Circle's own user token — a credential, in localStorage,
// readable by any script that achieves XSS on this origin. That is a real
// exposure and worth being precise about rather than waving at:
//
//   - It is Circle's design that the browser holds this token; it is handed to
//     the client by the SDK. We are choosing its lifetime, not inventing its
//     presence.
//   - It expires in 60 minutes and cannot be renewed from the browser, so the
//     blast radius is bounded in a way an API key's would not be.
//   - It cannot move money on its own. Every transfer and signature is a
//     challenge the user must approve with their PIN inside Circle's iframe,
//     which this token does not grant.
//
// localStorage rather than sessionStorage so the session survives closing a
// tab, matching what Privy does today. There is no refresh: Circle renews a
// session through POST /users/token keyed on userId with the API key alone, so
// an endpoint exposing that would let anyone who learns a userId mint a
// session for that wallet. Re-login at expiry is the honest cost.

interface PersistedSession extends CircleSessionState {
  savedAt: number;
}

function persist(s: CircleSessionState) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, savedAt: Date.now() }));
  } catch {
    // Storage unavailable — the in-memory session still works for this page.
  }
}

function readPersisted(): CircleSessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedSession;
    if (!p?.userToken || !p?.encryptionKey || !p?.wallet?.address) return null;
    if (Date.now() - p.savedAt > SESSION_TTL_MS) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    const { savedAt: _savedAt, ...rest } = p;
    return rest;
  } catch {
    return null;
  }
}

/** True when a stored session looks live. Cheap and synchronous. */
export function hasPersistedSession(): boolean {
  return readPersisted() !== null;
}

const log: string[] = [];
export function circleLog(): readonly string[] {
  return log;
}
function note(line: string) {
  if (!log.includes(line)) {
    log.push(line);
    emit();
  }
}

function requireConfig(): CircleConfig {
  if (!config) throw new Error("Circle is not configured — call configureCircle() first");
  if (!config.appId || !config.googleClientId) {
    throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID / NEXT_PUBLIC_GOOGLE_CLIENT_ID not set");
  }
  return config;
}

async function api(path: string, init?: RequestInit & { token?: string }) {
  const { apiBase } = requireConfig();
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
}

/**
 * Build the SDK, never constructing a second one in a page load.
 *
 * W3SSdk keeps a static singleton. Its constructor, when one already exists,
 * runs setupInstance on the NEW object — which skipped `this.iframe =
 * createElement` — and then returns the OLD instance. So setup executes
 * against an object whose iframe is undefined, `this.iframe.src = …` throws
 * inside an async method nobody awaits, and the callback you passed is
 * attached to the object that got thrown away. The result is total silence.
 * updateConfigs is the supported way to re-point the live instance.
 */
type SdkConfigs = ConstructorParameters<
  typeof import("@circle-fin/w3s-pw-web-sdk").W3SSdk
>[0];

async function ensureSdk(
  configs: SdkConfigs,
  cb: (err: unknown, result: unknown) => void
) {
  const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
  if (sdk) {
    sdk.updateConfigs(configs, cb);
    return sdk;
  }
  sdk = new W3SSdk(configs, cb);
  return sdk;
}

/** Runs a Circle challenge in Circle's own UI (PIN, security questions). */
export async function executeChallenge(challengeId: string): Promise<unknown> {
  if (!sdk) throw new Error("no Circle session — sign in first");
  return new Promise<unknown>((resolve, reject) => {
    sdk!.execute(challengeId, (e: unknown, result: unknown) =>
      e ? reject(e instanceof Error ? e : new Error(JSON.stringify(e))) : resolve(result)
    );
  });
}

/**
 * The wallet on the target chain.
 *
 * Polls. A completed create-wallet challenge means Circle ACCEPTED the
 * creation, not that the wallet exists — provisioning is asynchronous, so an
 * empty first read is normal rather than a failure.
 */
async function loadWallet(token: string): Promise<CircleWallet> {
  const blockchain = requireConfig().blockchain ?? "ARC-TESTNET";
  const init = await api("/v1/auth/circle/initialize", { method: "POST", token });
  if (init.challenge_id) {
    note("creating your wallet…");
    await executeChallenge(init.challenge_id);
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
}

/**
 * Complete a login that started before Google's redirect.
 *
 * Memoised: the connector's setup(), its isAuthorized(), and any React binding
 * may all ask for this on the same page load, and the callback hash is
 * one-shot — a second attempt would find nothing and report a failure over a
 * login that was already succeeding.
 */
export function restoreSession(): Promise<CircleSessionState | null> {
  if (session) return Promise.resolve(session);
  if (restoring) return restoring;

  // A stored session takes priority over a redirect stash: if both exist we
  // are already signed in and there is nothing to complete.
  const stored = readPersisted();
  if (stored) {
    restoring = (async () => {
      const cfg = requireConfig();
      // The SDK must exist and be authenticated before any challenge can run.
      // Restoring the token without this gives a session that looks connected
      // and then fails on the first PIN prompt.
      await ensureSdk({ appSettings: { appId: cfg.appId } }, () => {});
      sdk!.setAuthentication({
        userToken: stored.userToken,
        encryptionKey: stored.encryptionKey,
      });

      // Prove the token is still good rather than trusting the clock. Circle
      // can invalidate a session early, and a stale token that only fails at
      // the first payment is far worse than one caught at page load.
      try {
        await api("/v1/auth/circle/wallets", { token: stored.userToken });
      } catch {
        note("stored session expired — sign in again");
        clearCircleSession();
        return null;
      }
      session = stored;
      emit();
      return session;
    })();
    restoring.catch(() => {
      restoring = null;
    });
    return restoring;
  }

  if (!RESUME_AT_LOAD) return Promise.resolve(null);

  restoring = (async () => {
    const cfg = requireConfig();
    note("completing sign-in…");
    const verified = await new Promise<{ userToken: string; encryptionKey: string }>(
      (resolve, reject) => {
        let settled = false;
        const settle = {
          ok: (s: { userToken: string; encryptionKey: string }) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(s);
          },
          fail: (e: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(e);
          },
        };

        // The login result arrives as a postMessage from Circle's own origin.
        // The SDK has been observed receiving onSocialLoginVerified and never
        // invoking onLoginComplete; its internal timeout reports to
        // this.onComplete, which is the CHALLENGE callback and is undefined
        // during login, so that failure is swallowed entirely. Reading the
        // message directly is not a way around the flow — it is the same
        // message, from the same origin, carrying the same payload.
        const onMsg = (e: MessageEvent) => {
          if (e.origin !== CIRCLE_AUTH_ORIGIN) return;
          const v = (e.data as Record<string, unknown> | null)?.[
            "onSocialLoginVerified"
          ] as
            | { error?: { code?: number; message?: string }; result?: Record<string, unknown> }
            | undefined;
          if (!v) return;
          if (v.error) {
            return settle.fail(
              new Error(`Circle rejected the login: ${v.error.code} ${v.error.message}`)
            );
          }
          const r = v.result as { userToken?: string; encryptionKey?: string } | undefined;
          if (!r?.userToken || !r?.encryptionKey) {
            return settle.fail(new Error("Circle verified the login but returned no user token"));
          }
          settle.ok({ userToken: r.userToken, encryptionKey: r.encryptionKey });
        };
        window.addEventListener("message", onMsg);

        const timer = setTimeout(() => {
          settle.fail(
            new Error(
              "Circle's SDK never completed the login. " +
                `callback hash ${CALLBACK_AT_LOAD ? "present" : "ABSENT"}, ` +
                `id_token ${CALLBACK_AT_LOAD.includes("id_token") ? "yes" : "no"}`
            )
          );
        }, 20_000);

        function cleanup() {
          window.removeEventListener("message", onMsg);
          clearTimeout(timer);
        }

        // Constructing the SDK is what consumes the callback hash.
        void ensureSdk(
          {
            appSettings: { appId: cfg.appId },
            loginConfigs: {
              deviceToken: RESUME_AT_LOAD!.deviceToken,
              deviceEncryptionKey: RESUME_AT_LOAD!.deviceEncryptionKey,
              google: {
                clientId: cfg.googleClientId,
                redirectUri: window.location.origin + cfg.redirectPath,
                selectAccountPrompt: true,
              },
            },
          },
          (err, result) => {
            if (err) {
              return settle.fail(err instanceof Error ? err : new Error(String(err)));
            }
            const r = result as { userToken?: string; encryptionKey?: string } | undefined;
            if (!r?.userToken || !r?.encryptionKey) {
              return settle.fail(new Error("login returned no user token"));
            }
            settle.ok({ userToken: r.userToken, encryptionKey: r.encryptionKey });
          }
        ).catch((e) => settle.fail(e instanceof Error ? e : new Error(String(e))));
      }
    );

    sdk!.setAuthentication({
      userToken: verified.userToken,
      encryptionKey: verified.encryptionKey,
    });
    const wallet = await loadWallet(verified.userToken);
    session = { ...verified, wallet };
    persist(session);
    note(`wallet ${wallet.address} on ${wallet.blockchain}`);
    emit();
    return session;
  })();

  // A failed restore must not be cached as a permanent "no": the user can
  // press sign in again, and that has to start clean.
  restoring.catch(() => {
    restoring = null;
  });
  return restoring;
}

/**
 * Start Google sign-in. Navigates the page away; the returned promise settles
 * only if it fails before the redirect happens.
 */
export async function startGoogleSignIn(): Promise<void> {
  const cfg = requireConfig();

  // The device id comes from Circle, and the token is minted FOR it. Reversing
  // this — inventing an id and asking Circle to mint against it — succeeds at
  // every step and then fails the login at the very end with 155140 "device ID
  // is not found", one hop away from the cause.
  note("asking Circle for a device id…");
  const bootstrap = await ensureSdk({ appSettings: { appId: cfg.appId } }, () => {});
  const deviceId = await bootstrap.getDeviceId();
  const dev = await api("/v1/auth/circle/device", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId }),
  });

  const configured = await ensureSdk(
    {
      appSettings: { appId: cfg.appId },
      loginConfigs: {
        deviceToken: dev.device_token,
        deviceEncryptionKey: dev.device_encryption_key,
        google: {
          clientId: cfg.googleClientId,
          redirectUri: window.location.origin + cfg.redirectPath,
          // MUST be true. The SDK builds the Google URL as
          //   prompt=${selectAccountPrompt ? 'select_account' : 'none'}
          // so omitting it asks Google to authenticate with no interaction at
          // all; Google cannot, and bounces back with interaction_required,
          // which looks exactly like the page reloading itself for no reason.
          selectAccountPrompt: true,
        },
      },
    },
    () => {}
  );

  // Stash before leaving: the redirect discards everything in memory, and the
  // device token cannot be re-minted for a login already in flight.
  sessionStorage.setItem(
    RESUME_KEY,
    JSON.stringify({
      deviceToken: dev.device_token,
      deviceEncryptionKey: dev.device_encryption_key,
    })
  );

  note("redirecting to Google…");
  // performLogin takes SocialLoginProvider, which the package imports but never
  // re-exports, so it cannot be named here. It is a string enum whose GOOGLE
  // member is exactly "Google" — only the compile-time name is missing.
  await (configured as unknown as { performLogin: (p: string) => Promise<void> }).performLogin(
    "Google"
  );
}
