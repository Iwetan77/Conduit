// Thin client for the Conduit API (packages/api). The dashboard is a thin
// client of this service only — no direct DB access, no contract reads for
// intent state (spec Phase 3 preamble). The only on-chain touch allowed from
// the app is the payer signing/submitting a transaction at checkout.

const API_BASE = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "http://localhost:8080";
const STORAGE_KEY = "conduit_dashboard_session_token";

// Bearer token used for dashboard requests. Holds either a Conduit session
// token (cs_..., minted by the API at sign-in and stored by circle-stack) or a
// pasted sk_ key for the programmatic-access path -- the API's
// auth.Middleware accepts both, so this file doesn't need to know which kind
// it's holding.
//
// It used to hold a Privy access token, refreshed periodically by the dashboard
// layout. That is what the Conduit session token replaced: verifying a
// provider's JWT meant a network call to that provider on every request (281ms
// to 7.6s measured), whereas a cs_ token is HMAC-verified locally.
export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

/**
 * Fired when the session token changes to a DIFFERENT one.
 *
 * Anything cached under the old session belongs to the old account and must go.
 * `["account","me"]` is the sharp case: it cannot be keyed by account, because
 * the endpoint means "whoever is signed in", so a cached entry is simply the
 * previous person's account waiting to be served to the next one.
 */
export const SESSION_CHANGED_EVENT = "conduit:session-changed";

export function setSessionToken(token: string): void {
  const previous = window.localStorage.getItem(STORAGE_KEY);
  window.localStorage.setItem(STORAGE_KEY, token);
  // Only on a real change. Re-minting the same session (the dashboard does this
  // when a cs_ token is refreshed) must not wipe a working cache.
  if (previous && previous !== token) {
    window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  }
}

export function clearSessionToken(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(CIRCLE_STORAGE_KEY);
}

// A Circle session is NOT a bearer token, and must not be stored as one.
//
// The API resolves sk_/pk_ keys and Conduit session tokens from the
// Authorization header.
// Circle's user token is a credential issued by Circle to the browser; putting
// it in that same header would hand it to the code path that looks up Conduit
// keys, where at best it fails confusingly and at worst it is compared against
// key hashes. The server reads it from X-Circle-User-Token precisely so the two
// can never be mistaken for one another, and this mirrors that.
const CIRCLE_STORAGE_KEY = "conduit.circleSession";

export function getCircleSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(CIRCLE_STORAGE_KEY);
}

export function setCircleSessionToken(token: string): void {
  window.localStorage.setItem(CIRCLE_STORAGE_KEY, token);
}

export class ConduitApiError extends Error {
  code?: string;
  docUrl?: string;
  constructor(message: string, code?: string, docUrl?: string) {
    super(message);
    this.code = code;
    this.docUrl = docUrl;
  }
}

// Re-mint the dashboard session from the live Circle session.
//
// A cs_ token can stop being accepted while the merchant is still very much
// signed in: it carries a 12-hour expiry, and it also dies whenever the API's
// signing secret changes under it. Neither is visible from here -- both arrive
// as a bare 401, which the dashboard rendered as "Missing or invalid API key"
// over a session the user had no reason to think was over. They were then
// stuck: nothing re-mints on its own, so every subsequent action failed the
// same way until a full page reload happened to run the login bootstrap again.
//
// Circle's own token is the authority, so if it is still good this is silent.
// If it is not, there is nothing to recover and the caller gets an honest
// "sign in again" instead.
async function remintSession(): Promise<string | null> {
  try {
    const { currentSession } = await import("@/lib/circle/browser");
    const s = currentSession();
    if (!s) return null;
    const account = await createAccountFromCircle(s.userToken, {
      login_wallet: s.wallet.address,
    });
    if (!account.session_token) return null;
    setSessionToken(account.session_token);
    return account.session_token;
  } catch {
    return null;
  }
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    apiKey?: string;
    circleToken?: string;
    idempotencyKey?: string;
    /** Internal: set on the one retry after a re-mint, so it cannot loop. */
    retried?: boolean;
  } = {}
): Promise<T> {
  const apiKey = options.apiKey ?? getSessionToken();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  // Only when a caller passes it explicitly, which in practice is the login
  // bootstrap alone. Attaching a stored Circle token to every request made the
  // API re-verify with Circle on each one -- a network round trip per call,
  // measured between 280ms and 7.6s on a polling dashboard, with Circle's
  // availability in front of every request. The bootstrap returns a Conduit
  // session token instead, and that is what authenticates everything after.
  if (options.circleToken) headers["X-Circle-User-Token"] = options.circleToken;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let json: { error?: { message?: string; code?: string; doc_url?: string } } & Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON body: a plain-text "404 page not found" from a route that
      // isn't registered (e.g. the bridge endpoints when ARC_RELAYER_KEY is
      // unset), or an HTML error page from a proxy. Surfacing the raw
      // "unable to parse JSON string" to a payer is the bug this replaces.
      throw new ConduitApiError(
        res.status === 404
          ? "This feature isn't available yet."
          : `The server returned an unexpected response (HTTP ${res.status}).`,
        res.status === 404 ? "not_available" : "bad_response"
      );
    }
  }

  // An expired or no-longer-valid dashboard session, on a call that used the
  // stored one. Recover once, then report it in words the merchant can act on
  // -- "Missing or invalid API key" describes a key they never held.
  //
  // Only when the token was ours to replace: a caller that passed an explicit
  // sk_ key gets the server's answer unchanged, because re-minting a session
  // would silently run their request as somebody else.
  // `circleToken` excluded because that IS the bootstrap: it authenticates with
  // Circle's credential, and recovering from its 401 by calling the bootstrap
  // again would recurse into the same failure.
  if (res.status === 401 && !options.apiKey && !options.circleToken && !options.retried) {
    const fresh = await remintSession();
    if (fresh) return request<T>(path, { ...options, apiKey: fresh, retried: true });
    throw new ConduitApiError(
      "Your session expired. Sign in again to continue.",
      "session_expired"
    );
  }

  if (!res.ok) {
    const err = json.error ?? {};
    throw new ConduitApiError(err.message ?? `HTTP ${res.status}`, err.code, err.doc_url);
  }
  return json as T;
}

// ── Accounts / keys ──────────────────────────────────────────────────────────

export interface Account {
  id: string;
  name: string;
  logo_url?: string;
  /**
   * The name this account is paid under, or null until claimed.
   *
   * Null and absent must stay distinguishable — "no username yet" is what
   * triggers the one-time prompt, so the field is always present on the wire
   * rather than omitted when empty.
   */
  username: string | null;
  settle_currency: string;
  settle_address: string;
  /**
   * Whether this account has a settlement wallet of its own yet.
   *
   * The dashboard decides whether to run provisioning from exactly this, so
   * absent and false have to mean the same thing — always present on the wire.
   */
  settlement_wallet_ready: boolean;
  /**
   * How settle_address was arrived at: a wallet provisioned for this account,
   * the wallet used to sign in, or an address its owner supplied. Null on rows
   * written before the API set it, which is a real state rather than an error.
   */
  settle_address_source: "provisioned" | "login_wallet" | "external" | null;
  /**
   * The wallet this account signs in with, or null for an API-key account.
   *
   * Used to tell "this connected wallet is mine" from "this wallet happens to
   * be connected" — a distinction the username lookup gets wrong without it.
   */
  login_wallet: string | null;
  livemode: boolean;
}

export interface CreatedKey {
  key: string; // full secret — present only in this one response, never again
  prefix: string;
  suffix: string;
}

export interface AccountWithKey extends Account {
  api_key?: CreatedKey;
}

export interface ApiKeySummary {
  id: string;
  prefix: string;
  suffix: string;
  type: "pk" | "sk";
  livemode: boolean;
  revoked_at?: string;
}

export function createAccount(body: { name: string; settle_currency: string; settle_address: string; livemode?: boolean }) {
  return request<AccountWithKey>("/v1/accounts", { method: "POST", body });
}

export function listApiKeys() {
  return request<{ data: ApiKeySummary[] }>("/v1/api_keys");
}

// Mint a secret key for one of your storefronts, so its point-of-sale can
// create a payment link per bill against that storefront's own books. The
// secret is in this response and is never retrievable again.
export function createAccountApiKey(accountId: string) {
  return request<{ id: string; account_id: string; key: string; prefix: string; suffix: string }>(
    `/v1/accounts/${accountId}/api_keys`,
    { method: "POST" }
  );
}

export function revokeApiKey(keyId: string) {
  return request<{ id: string; status: string }>(`/v1/api_keys/${keyId}/revoke`, { method: "POST" });
}

/**
 * A storefront under this account.
 *
 * No address: a storefront inherits its parent's, snapshotted at creation. It
 * is a place the same business takes money, not a different business, and
 * letting one be typed per till was a separate chance to point each location's
 * takings somewhere unrecoverable.
 */
export function createSubAccount(body: { name: string; settle_currency: string }) {
  return request<AccountWithKey>("/v1/accounts/sub", { method: "POST", body });
}

// Phase 4: recipient identity. getMyAccount resolves the caller's own
// account without needing its id up front (Settings loads this to edit).
export function getMyAccount() {
  return request<Account>("/v1/accounts/me");
}

// ── Usernames ───────────────────────────────────────────────────────────────
//
// A name to be paid under, instead of 42 hex characters. Bound to the ACCOUNT
// rather than the wallet, so a person and their business can each have one on
// the same wallet and still resolve to different places.

export interface UsernameResolution {
  username: string;
  /** The account's own name — what to show a sender before they confirm. */
  display_name: string;
  settle_address: string;
  settle_currency: string;
  /**
   * "personal" or "business".
   *
   * One wallet can hold both kinds of account and both can hold a name, so a
   * name alone does not say which is being paid — @Ivan resolving to "Ivan and
   * Sons" is correct and still reads as a surprise unless the screen says it is
   * the business.
   */
  account_type: "personal" | "business";
}

/**
 * Resolve a name to the address a payment should go to.
 *
 * Returns null when nobody holds the name, rather than throwing: /send calls
 * this on a partially typed name, where "no such user yet" is the normal case
 * and not an error worth surfacing.
 */
export async function resolveUsername(name: string): Promise<UsernameResolution | null> {
  try {
    return await request<UsernameResolution>(`/v1/usernames/${encodeURIComponent(name)}`);
  } catch {
    return null;
  }
}

export interface UsernameAvailability {
  available: boolean;
  /** Present whenever available is false, and always safe to show verbatim. */
  reason?: string;
}

/** Live check while someone types. Always answers; never throws for "taken". */
export function checkUsernameAvailable(name: string) {
  return request<UsernameAvailability>(
    `/v1/usernames/${encodeURIComponent(name)}/available`,
  );
}

/** Claim a name for the signed-in account. Once only — the server enforces it. */
export function claimUsername(username: string) {
  return request<{ username: string }>("/v1/accounts/me/username", {
    method: "POST",
    body: { username },
  });
}

/**
 * Claim a name using a wallet signature instead of a session.
 *
 * For a payer who connected an EVM wallet and nothing else: they have no
 * session because their account is created lazily on first send, and they are
 * half the people this feature is for.
 */
export function claimUsernameWithWallet(body: {
  wallet: string;
  username: string;
  timestamp: number;
  signature: string;
}) {
  return request<{ username: string }>("/v1/usernames/claim", { method: "POST", body });
}

/** The name held by a wallet's own personal account, or null. Never throws for "none". */
export async function getUsernameForWallet(address: string): Promise<string | null> {
  try {
    const res = await request<{ username: string | null }>(
      `/v1/wallets/${encodeURIComponent(address)}/username`,
    );
    return res.username;
  } catch {
    return null;
  }
}

// Ends every session for the account, server-side.
//
// Dropping the token from localStorage only removes this browser's copy; the
// token itself stays valid for the rest of its life wherever else it has
// reached. This is what actually invalidates it, so it has to be called while
// the token is still present -- clearing first would leave nothing to
// authenticate with.
export function logout() {
  return request<void>("/v1/auth/logout", { method: "POST" });
}

/**
 * No settle_address. Where an account is paid is derived from the wallet
 * provisioned for it; the API rejects this field rather than ignoring it, so
 * sending one is a 400 rather than a silent no-op.
 */
export function updateAccount(id: string, body: { name?: string; logo_url?: string; settle_currency?: string }) {
  return request<Account>(`/v1/accounts/${id}`, { method: "PATCH", body });
}

/**
 * Bind the settlement wallet the browser just created to this account.
 *
 * Sends the wallet ID and nothing else, deliberately. The server reads the
 * address back from Circle with the caller's own user token and stores THAT —
 * an address sent from here would be an address nobody verified, which is the
 * hole this whole flow exists to close. Sending one would not help anyway; it
 * is ignored.
 */
export function provisionSettlementWallet(walletId: string, circleToken: string) {
  return request<{
    settle_address: string;
    settle_wallet_id: string;
    settle_address_source: string;
    settlement_wallet_ready: boolean;
  }>("/v1/accounts/me/settlement_wallet", {
    method: "POST",
    body: { wallet_id: walletId },
    // Passed explicitly, unlike every other call here. The server needs the
    // caller's own Circle session to ask Circle which wallets they own — that
    // lookup is the entire safety property, and it cannot be made with anything
    // the server holds: Circle refuses to mint a token for a Google user from an
    // API key. This is a once-per-account call, so the round trip it costs is
    // paid once rather than on every request.
    circleToken,
  });
}

// ── Payout destinations ─────────────────────────────────────────────────────
//
// Where a business withdraws TO, which is not where its income routes. An
// address is added unverified and stays unpayable until its owner proves
// control of it — a withdrawal is on-chain and final, and twenty bytes of valid
// hex is not evidence of anything.

export interface PayoutDestination {
  id: string;
  address: string;
  label: string | null;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
}

export function listPayoutDestinations() {
  return request<{ data: PayoutDestination[] }>("/v1/payout_destinations");
}

export function addPayoutDestination(body: { address: string; label?: string }) {
  return request<PayoutDestination>("/v1/payout_destinations", { method: "POST", body });
}

/** Asks for the message to sign. Single-use, and re-asking replaces the last one. */
export function payoutDestinationChallenge(id: string) {
  return request<{ message: string; expires_in: number }>(
    `/v1/payout_destinations/${id}/challenge`,
    { method: "POST", body: {} },
  );
}

export function verifyPayoutDestination(id: string, signature: string) {
  return request<{ verified: boolean }>(`/v1/payout_destinations/${id}/verify`, {
    method: "POST",
    body: { signature },
  });
}

export function removePayoutDestination(id: string) {
  return request<void>(`/v1/payout_destinations/${id}`, { method: "DELETE" });
}

export interface Payout {
  id: string;
  status: "pending" | "paid" | "failed";
  currency: string;
  amount: string;
  destination_address: string;
  from_address: string;
  tx_hash: string | null;
  created_at: string;
  paid_at: string | null;
  /** Present only on the create response: what the browser has to send. */
  transfer?: { token: string; to: string; amount: string };
}

/**
 * Authorises a withdrawal. Nothing has moved when this returns — it hands back
 * the transfer to make, every field of which the SERVER chose.
 */
export function createPayout(body: { destination_id: string; currency: string; amount: string }) {
  return request<Payout>("/v1/payouts", { method: "POST", body });
}

/** Records what the chain says happened. The hash is a claim until this looks. */
export function confirmPayout(id: string, txHash: string) {
  return request<Payout>(`/v1/payouts/${id}/confirm`, {
    method: "POST",
    body: { tx_hash: txHash },
  });
}

export function listPayouts() {
  return request<{ data: Payout[] }>("/v1/payouts");
}

/**
 * Settle directly to a verified payout destination instead of the wallet
 * Conduit provisioned.
 *
 * Only a destination id — there is no free-text address anywhere in this flow,
 * because a typed settlement address is the hole all of this closed. The name
 * is friction rather than security: anyone who can call this can read it, and
 * the point is that it cannot happen by mis-clicking.
 */
export function settleToExternal(body: { destination_id: string; confirm_name: string }) {
  return request<{ settle_address: string; settle_address_source: string }>(
    "/v1/accounts/me/settlement_address/external",
    { method: "POST", body },
  );
}

/** Back to the account's own wallet. One call, nothing to type. */
export function revertSettlementAddress() {
  return request<{ settle_address: string; settle_address_source: string }>(
    "/v1/accounts/me/settlement_address/revert",
    { method: "POST", body: {} },
  );
}

// ── Employees and payroll ───────────────────────────────────────────────────

export interface Employee {
  id: string;
  name: string;
  address: string;
  username: string | null;
  pay_currency: string;
  pay_type: "fixed" | "variable";
  /** Null for a variable employee, by construction. */
  amount: string | null;
  /** Which group they are in, or null for ungrouped. */
  group_id: string | null;
  status: "active" | "paused" | "archived";
}

/**
 * A group of staff — the scope of a payroll run, and nothing more.
 *
 * One person often runs more than one business. Without groups, paying one
 * team meant pausing every other team and remembering to unpause them.
 */
export interface EmployeeGroup {
  id: string;
  name: string;
  /** Active members. */
  members: number;
}

export function listEmployeeGroups() {
  return request<{ data: EmployeeGroup[] }>("/v1/employee_groups");
}

export function createEmployeeGroup(name: string) {
  return request<EmployeeGroup>("/v1/employee_groups", { method: "POST", body: { name } });
}

export function renameEmployeeGroup(id: string, name: string) {
  return request<EmployeeGroup>(`/v1/employee_groups/${id}`, { method: "PATCH", body: { name } });
}

/** Removes the GROUP. Its members return to ungrouped — nobody is deleted. */
export function deleteEmployeeGroup(id: string) {
  return request<void>(`/v1/employee_groups/${id}`, { method: "DELETE" });
}

export function listEmployees(includeArchived = false) {
  return request<{ data: Employee[] }>(
    `/v1/employees${includeArchived ? "?include_archived=true" : ""}`,
  );
}

export function addEmployee(body: {
  name: string;
  username?: string;
  address?: string;
  pay_currency: string;
  pay_type: "fixed" | "variable";
  amount?: string;
  group_id?: string;
}) {
  return request<Employee>("/v1/employees", { method: "POST", body });
}

/**
 * No address. Changing where a person is paid is not an edit to their record —
 * doing it quietly on a row a payroll run reads is how money goes elsewhere
 * with nobody looking. Archive and re-add instead.
 */
export function updateEmployee(
  id: string,
  // group_id has three states: absent leaves it alone, "" removes them from
  // their group, an id moves them. Moving groups is a normal edit — it changes
  // which run pays somebody, not where their money goes.
  body: { name?: string; pay_currency?: string; pay_type?: "fixed" | "variable"; amount?: string; status?: "active" | "paused"; group_id?: string },
) {
  return request<Employee>(`/v1/employees/${id}`, { method: "PATCH", body });
}

/** Never a delete: a removed row breaks the history of every run that paid them. */
export function archiveEmployee(id: string) {
  return request<Employee>(`/v1/employees/${id}/archive`, { method: "POST", body: {} });
}

export interface PayrollItem {
  id: string;
  employee_id: string;
  name: string;
  username: string | null;
  address: string;
  currency: string;
  amount: string;
  status: "pending" | "paid" | "failed";
  tx_hash: string | null;
  error: string | null;
}

export interface PayrollGroup {
  currency: string;
  total: string;
  recipients: number;
  needs_conversion: boolean;
  status: string;
}

export interface PayrollRun {
  id: string;
  status: "draft" | "converting" | "executing" | "completed" | "partial" | "failed";
  treasury_currency: string;
  items: PayrollItem[];
  groups: PayrollGroup[];
  created_at: string;
  executed_at: string | null;
  wallet_balance?: string;
  estimated_gas?: string;
  balance_covers?: boolean;
  settle_address?: string;
  payroll_contract?: string;
}

export interface PayrollLeg {
  currency: string;
  token: string;
  total: string;
  needs_conversion: boolean;
  recipients: string[];
  amounts: string[];
  run_id_hash: string;
}

/** Builds a draft and returns the whole preview. Nothing is paid. */
/** Pass a groupId to pay only that group. Omit it to pay everybody active. */
export function createPayrollRun(amounts?: Record<string, string>, groupId?: string) {
  return request<PayrollRun>("/v1/payroll_runs", {
    method: "POST",
    body: { amounts: amounts ?? {}, group_id: groupId ?? "" },
  });
}

/**
 * Recover a run stranded in `executing`.
 *
 * Needs a NEW run key — the original stays permanently burned, so a recovery
 * cannot double as a way to replay the original request. Refused until the run
 * has sat still long enough that it cannot be racing a browser still signing,
 * and it rebuilds legs from the unpaid people only.
 */
export function resumePayrollRun(id: string, runKey: string) {
  return request<{ run_id: string; status: string; spender: string; legs: PayrollLeg[] }>(`/v1/payroll_runs/${id}/resume`, {
    method: "POST",
    body: { run_key: runKey },
  });
}

export function getPayrollRun(id: string) {
  return request<PayrollRun>(`/v1/payroll_runs/${id}`);
}

/** Past runs. Drafts are excluded by the server — a preview is not history. */
export function listPayrollRuns() {
  return request<{ data: PayrollRun[] }>("/v1/payroll_runs");
}

/**
 * Throws away a draft nobody ran.
 *
 * Called when somebody backs out of the preview, so looking at what a payroll
 * would cost does not leave a row behind. Refused on anything already
 * executed — that is a record.
 */
export function discardPayrollRun(id: string) {
  return request<void>(`/v1/payroll_runs/${id}`, { method: "DELETE" });
}

/**
 * Claims the run and returns what has to be signed.
 *
 * run_key is required, not optional. A double click, a retried request and a
 * restored tab all produce a second execute, and the key is what refuses it.
 */
export function executePayrollRun(id: string, runKey: string) {
  return request<{ run_id: string; status: string; spender: string; legs: PayrollLeg[] }>(
    `/v1/payroll_runs/${id}/execute`,
    { method: "POST", body: { run_key: runKey } },
  );
}

/** Records one currency group's outcome. The server checks the chain. */
export function recordPayrollLeg(
  id: string,
  body: { currency: string; tx_hash?: string; failed?: boolean; error?: string },
) {
  return request<PayrollRun>(`/v1/payroll_runs/${id}/legs`, { method: "POST", body });
}

export function listAccounts() {
  return request<{ data: Account[] }>("/v1/accounts");
}

// The standing open-amount link behind a storefront's printed QR. Get-or-create
// on the server, so calling it for every card on every load is safe and
// storefronts made before the feature existed get one on first view.
export function getStorefrontLink(accountId: string) {
  return request<PaymentLink>(`/v1/accounts/${accountId}/storefront_link`, { method: "POST" });
}

export interface DashboardAccount {
  // Conduit's own dashboard session. Present on both login bootstraps; store
  // it and use it for every subsequent call.
  session_token?: string;
  id: string;
  name: string;
  settle_currency: string;
  settle_address: string;
  login_wallet: string;
  livemode: boolean;
}

// Idempotent login bootstrap -- called on every successful sign-in, not only
// the first. The Circle user token authenticates the call in its own header
// (this route isn't behind the usual session-token plumbing, since a brand-new
// user has no account yet); the server verifies it with Circle before creating
// or returning the account. On first login the body's
// name/settle_currency/login_wallet are required by the server; on subsequent
// logins the body is ignored and the existing account returned.
//
// createAccountFromPrivy stood beside this and hit /v1/accounts/privy with a
// Privy JWT. Removed in Phase 7 along with that route.
export function createAccountFromCircle(
  circleUserToken: string,
  body: { name?: string; settle_currency?: string; settle_address?: string; login_wallet: string }
) {
  return request<DashboardAccount>("/v1/accounts/circle", {
    method: "POST",
    body,
    circleToken: circleUserToken,
  });
}

// ── Settlement intents ───────────────────────────────────────────────────────

export interface SettlementIntent {
  id: string;
  status: string;
  amount: string;
  settle_currency: string;
  settle_address: string;
  accept_currencies: string[];
  reference?: string;
  metadata: Record<string, unknown>;
  expires_at: string;
  created: string;
  hosted_url: string;
  qr_payload: string;
}

export function listSettlementIntents() {
  return request<{ data: SettlementIntent[] }>("/v1/settlement_intents");
}

export function getSettlementIntent(id: string, apiKey?: string) {
  return request<SettlementIntent>(`/v1/settlement_intents/${id}`, { apiKey });
}

export function createSettlementIntent(body: {
  amount: string;
  settle_currency: string;
  settle_address: string;
  accept_currencies?: string[];
  reference?: string;
  expires_in?: number;
  metadata?: Record<string, unknown>;
}) {
  return request<SettlementIntent>("/v1/settlement_intents", {
    method: "POST",
    body,
    idempotencyKey: crypto.randomUUID(),
  });
}

// Direct send: cross-currency from a connected wallet with no account and no
// sign-in. The server provisions a wallet-keyed personal account to own the
// intent (StableFX trades need one) -- see SettlementIntents.CreateDirect.
// Unauthenticated on purpose: creating an intent moves no money, and the payer
// still signs both StableFX payloads with their own wallet.
export function createDirectSettlementIntent(body: {
  payer_wallet: string;
  amount: string;
  settle_currency: string;
  settle_address: string;
  accept_currencies?: string[];
}) {
  return request<SettlementIntent>("/v1/settlement_intents/direct", {
    method: "POST",
    body,
    idempotencyKey: crypto.randomUUID(),
  });
}

export interface IntentQuote {
  provider: string;
  rate: string;
  pay_amount: string;
  pay_currency: string;
  expires_at: number;
  // EIP-712 payload the payer signs (sig #1). Absent for the direct,
  // same-currency provider, which needs no signature.
  typed_data?: unknown;
}

// payAddress is the wallet that will SIGN, which Circle recovers from the
// quote signature and checks against the trade. Omitting it made the API fall
// back to the recipient's address and every cross-wallet trade was rejected.
export function quoteSettlementIntent(
  id: string,
  payCurrency: string,
  payAddress?: string,
  apiKey?: string
) {
  return request<IntentQuote>(`/v1/settlement_intents/${id}/quote`, {
    method: "POST",
    body: { pay_currency: payCurrency, ...(payAddress ? { pay_address: payAddress } : {}) },
    apiKey,
  });
}

// Step 2 of the StableFX flow: hand back the payer's signature over the
// quote's typed data; Circle creates the trade and returns the funding
// payload to sign next. Unauthenticated — the payer holds no API key.
export function prepareSettlementIntent(
  id: string,
  quoteMessage: unknown,
  quoteSignature: string
) {
  return request<{ funding_typed_data: unknown }>(`/v1/settlement_intents/${id}/prepare`, {
    method: "POST",
    body: { quote_message: quoteMessage, quote_signature: quoteSignature },
  });
}

// Step 3: the funding signature. Circle's maker executes and delivers the
// settle currency to the recipient.
export function confirmSettlementIntent(id: string, fundingSignature: string) {
  return request<{ status: string; tx_hash?: string }>(`/v1/settlement_intents/${id}/confirm`, {
    method: "POST",
    body: { funding_signature: fundingSignature },
  });
}

// ── Public payer surface (no API key -- a bare payment link has none) ───────

export interface PublicSettlementIntent {
  id: string;
  status: string;
  amount: string;
  settle_currency: string;
  source_chain: string;
  expires_at: string;
  // Phase 4 recipient identity — display_name is primary; settle_address is
  // secondary (shown on request, for verification), never the main label.
  display_name: string;
  logo_url?: string;
  settle_address: string;
  // Where to send the buyer once this settles. Set by the merchant's own
  // server at charge creation (sk_ key), never by the browser. Drives the
  // mobile redirect flow — wallet in-app browsers can't open a tab, so the
  // checkout replaces the merchant's page and has to hand the buyer back.
  return_url?: string;
}

export interface FxRate {
  from: string;
  to: string;
  amount: string;
  /** Minor units of `from` the payer would send. */
  pay_amount: string;
  rate: string;
  provider: string;
  expires_at?: number;
  indicative: boolean;
}

// Indicative rate for a pair, with NO side effects — no intent, no trade, no
// state. Lets any surface show "you'll receive ≈ X", and surface an unroutable
// pair or a below-minimum amount, BEFORE the payer commits to a checkout.
// The firm rate is still the one POST /settlement_intents/{id}/quote returns at
// payment time.
export function getFxRate(from: string, to: string, amountMinor: string, address?: string) {
  const qs = new URLSearchParams({ from, to, amount: amountMinor });
  if (address) qs.set("address", address);
  return request<FxRate>(`/v1/fx/rates?${qs.toString()}`);
}

export function getPublicSettlementIntent(id: string) {
  return request<PublicSettlementIntent>(`/v1/settlement_intents/${id}/public`);
}

// Report a same-currency direct pay's on-chain tx so the server verifies it and
// marks the intent settled + fires the settlement.succeeded webhook. Without
// this, a same-currency pay moves the money on-chain but the intent stays
// "created" forever (the indexer keys off a declaration_id the API never
// writes) — so a gateway checkout never flips to "payment received". Public,
// like quote/prepare/confirm: the intent id is the capability and the server
// trusts only the chain, not this call.
export function recordDirectSettlement(id: string, txHash: string) {
  return request<{ status: string; tx_hash?: string }>(
    `/v1/settlement_intents/${id}/record`,
    { method: "POST", body: { tx_hash: txHash } }
  );
}

// ── Cross-chain funding (Circle Gateway, Solana -> Arc) ──────────────────────
// Two-call flow matching internal/handlers/bridge.go exactly: the first call
// returns what to sign (a deposit transaction, only if the payer's Gateway
// balance is insufficient, plus always a burn-intent message to sign); the
// second reports the signature(s) back and the funding pipeline runs
// server-side from there — see docs/ubk-capability.md for why a burn intent
// is a signed message, not an on-chain transaction.

export interface BridgeInitiateResponse {
  transfer_id: string;
  state: string;
  needs_deposit?: boolean;
  deposit_tx_base64?: string;
  burn_intent_message?: string; // hex, 0x-prefixed — sign this, don't submit it
}

export function initiateBridge(intentId: string, payerAddress: string, usdcAmount: string) {
  return request<BridgeInitiateResponse>(`/v1/settlement_intents/${intentId}/bridge/initiate`, {
    method: "POST",
    body: { payer_address: payerAddress, usdc_amount: usdcAmount },
  });
}

export function reportBridgeSignature(
  intentId: string,
  transferId: string,
  burnIntentSignature: string,
  depositTxHash?: string
) {
  return request<BridgeInitiateResponse>(`/v1/settlement_intents/${intentId}/bridge/initiate`, {
    method: "POST",
    body: { transfer_id: transferId, burn_intent_signature: burnIntentSignature, deposit_tx_hash: depositTxHash },
  });
}

export interface BridgeBalance {
  total_available: string;
  by_chain: Record<string, string>; // "solana" | "arc" | "sui" -> minor-unit string
}

// Balance-aware paying (Phase 5.1): checked before showing any amount
// entry, so the payer only ever sees "paying with USDC" as a confirmed
// fact — never a list of assets they don't hold.
export function getBridgeBalance(intentId: string, payerAddress: string) {
  return request<BridgeBalance>(
    `/v1/settlement_intents/${intentId}/bridge/balance?payer_address=${encodeURIComponent(payerAddress)}`
  );
}

export interface BridgeStatus {
  transfer_id: string;
  state: string;
  source_domain: number;
  dest_domain: number;
  burn_amount: string;
  minted_amount?: string;
  source_tx_hash?: string;
  mint_tx_hash?: string;
  updated_at: string;
}

export function getBridgeStatus(intentId: string) {
  return request<BridgeStatus>(`/v1/settlement_intents/${intentId}/bridge/status`);
}

// ── Client-side UBK spend path (option B) ────────────────────────────────────
// The browser drives Circle's Unified Balance Kit directly (see
// lib/unified-balance.ts), so it needs to know where to mint the USDC and how
// much to spend (getBridgePlan), then reports the resulting Gateway transfer id
// back so the server polls the mint and runs the existing StableFX settlement.

export interface BridgePlan {
  recipient_address: string; // Conduit's Arc relayer — mint the USDC here
  required_usdc: string; // minor units of USDC to spend (already includes cross-currency margin)
  settle_currency: string;
  settle_amount: string;
}

export function getBridgePlan(intentId: string) {
  return request<BridgePlan>(`/v1/settlement_intents/${intentId}/bridge/plan`);
}

export function reportBridgeSpend(
  intentId: string,
  body: { gateway_transfer_id: string; source_chain: string; usdc_amount: string }
) {
  return request<{ transfer_id: string; state: string }>(
    `/v1/settlement_intents/${intentId}/bridge/report_spend`,
    { method: "POST", body }
  );
}

// ── Settlements (per-payment view: paid, received, rate, fee, tx link) ──────

export interface Settlement {
  id: string;
  intent_id: string;
  reference?: string;
  settle_address: string;
  /** Who paid. Absent for cross-chain: the address moving funds on Arc there
   *  is Conduit's relayer, not the payer. */
  payer_address?: string;
  pay_currency: string;
  pay_amount: string;
  settle_currency: string;
  settle_amount: string;
  rate_applied?: string;
  fee: string;
  tx_hash: string;
  settled_at: string;
}

export function listSettlements() {
  return request<{ data: Settlement[] }>("/v1/settlements");
}

// ── Balance transactions ─────────────────────────────────────────────────────

export interface BalanceTransaction {
  id: string;
  settlement_id: string;
  type: string;
  gross: string;
  fee: string;
  net: string;
  currency: string;
  created_at: string;
}

export function listBalanceTransactions() {
  return request<{ data: BalanceTransaction[] }>("/v1/balance_transactions");
}

// The export endpoint only accepts the Authorization header (no query-param
// auth on the server), so a plain <a href> download won't carry credentials —
// fetch it as an authenticated blob and trigger the save client-side instead.
export async function downloadBalanceTransactionsCsv(filename = "conduit-balance-transactions.csv"): Promise<void> {
  const apiKey = getSessionToken();
  const res = await fetch(`${API_BASE}/v1/balance_transactions/export`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new ConduitApiError(`Export failed: HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret?: string; // only present in the create response, once
  enabled_events: string[];
}

export function listWebhookEndpoints() {
  return request<{ data: WebhookEndpoint[] }>("/v1/webhook_endpoints");
}

export function createWebhookEndpoint(body: { url: string; enabled_events: string[] }) {
  return request<WebhookEndpoint>("/v1/webhook_endpoints", { method: "POST", body });
}

export interface WebhookDelivery {
  id: string;
  event_type: string;
  attempt: number;
  response_code: number | null;
  delivered_at: string | null;
}

export function listWebhookDeliveries(endpointId: string) {
  return request<{ data: WebhookDelivery[] }>(`/v1/webhook_endpoints/${endpointId}/deliveries`);
}

export function replayWebhookDelivery(deliveryId: string) {
  return request<{ status: string }>(`/v1/webhook_deliveries/${deliveryId}/replay`, { method: "POST" });
}

// ── Currencies ────────────────────────────────────────────────────────────────

export interface CurrencyInfo {
  iso: string;
  symbol: string;
  token: string;
  decimals: number;
}

export function listCurrencies() {
  return request<{ data: CurrencyInfo[] }>("/v1/currencies");
}

// ── Payment links (Phase 3: amount modes, lifecycle, void) ──────────────────

export type AmountMode = "fixed" | "open" | "open_with_suggested";
export type ReusePolicy = "single_use" | "multi_use";
export type LinkStatus = "draft" | "active" | "viewed" | "paid" | "settled" | "expired" | "void";

export interface PaymentLink {
  id: string;
  amount_mode: AmountMode;
  amount?: string;
  min_amount?: string;
  max_amount?: string;
  settle_currency: string;
  settle_address: string;
  accept_currencies: string[];
  description?: string;
  merchant_reference?: string;
  reuse_policy: ReusePolicy;
  status: LinkStatus;
  expires_at?: string;
  created: string;
  hosted_url: string;
  qr_payload: string;
}

/**
 * A payment link.
 *
 * No settle_address: it is derived from the account that owns the link and
 * snapshotted onto it, so a link created today keeps paying where it said even
 * if the business later moves its settlement. The API rejects this field rather
 * than ignoring it — sending one is a 400, not a silent no-op.
 */
export function createPaymentLink(body: {
  amount_mode: AmountMode;
  amount?: string;
  min_amount?: string;
  max_amount?: string;
  settle_currency: string;
  accept_currencies?: string[];
  description?: string;
  merchant_reference?: string;
  reuse_policy?: ReusePolicy;
  expires_in?: number;
}) {
  return request<PaymentLink>("/v1/payment_links", { method: "POST", body });
}

export function listPaymentLinks() {
  return request<{ data: PaymentLink[] }>("/v1/payment_links");
}

export function getPaymentLink(id: string) {
  return request<PaymentLink>(`/v1/payment_links/${id}`);
}

export function voidPaymentLink(id: string) {
  return request<{ id: string; status: string }>(`/v1/payment_links/${id}/void`, { method: "POST" });
}

// The payer-facing view of a link — display_name/logo_url/settle_address
// (Phase 4 recipient identity) instead of account_id/merchant_reference.
// Not yet wired into a page (Phase 5 owns the payer-surface rework that
// will consume this), but the client function is ready for it.
export interface PublicPaymentLink {
  id: string;
  amount_mode: AmountMode;
  amount?: string;
  min_amount?: string;
  max_amount?: string;
  settle_currency: string;
  description?: string;
  status: LinkStatus;
  expires_at?: string;
  display_name: string;
  logo_url?: string;
  settle_address: string;
}

export function getPublicPaymentLink(id: string) {
  return request<PublicPaymentLink>(`/v1/payment_links/${id}/public`);
}

export interface PayLinkResponse {
  id: string; // the resulting settlement_intent id — hand off to the si_ pay flow with this
  payment_link_id: string;
  amount: string;
  settle_currency: string;
  hosted_url: string;
}

// Turns a payment link into an actual payable settlement_intent — enforces
// single_use/expiry/void/amount-bounds server-side (Phase 3). amount is
// required for amount_mode=open, optional override for open_with_suggested.
export function payPaymentLink(id: string, body: { amount?: string; payer_reference?: string }) {
  return request<PayLinkResponse>(`/v1/payment_links/${id}/pay`, { method: "POST", body });
}

// ── Balances ────────────────────────────────────────────────────────────────

export interface BalanceRow {
  iso: string;
  symbol: string;
  token: string;
  decimals: number;
  amount: string; // integer minor units
}

// Public (no auth): a payer has no API key. Reading balances through the API
// instead of from the browser is what keeps Arc's public RPC from being hit
// once per visitor — the server does one cached Multicall3 read and serves
// everyone from it.
export async function getBalances(address: string): Promise<BalanceRow[]> {
  const res = await fetch(`${API_BASE}/v1/balances?address=${address}`);
  if (!res.ok) throw new Error(`balances: ${res.status}`);
  const body = (await res.json()) as { data: BalanceRow[] };
  return body.data;
}

// ── Wallet history (cross-currency) ────────────────────────────────────────

export interface WalletSettlementRow {
  id: string;
  tx_hash: string;
  pay_currency: string;
  pay_amount: string;
  settle_currency: string;
  settle_amount: string;
  settle_address: string;
  /**
   * Who paid. Null on a bridged payment: the Arc-side sender is Conduit's own
   * relayer and the payer's real wallet is on another chain, so there is no
   * honest Arc address to name.
   */
  payer_address: string | null;
  rate_applied: string | null;
  settled_at: string; // unix seconds, as a string
  /** "sent" when this wallet funded it, "received" when it was paid out to. */
  direction?: "sent" | "received";
}

// A payer's own cross-currency settlements — the ones ConduitRouter never
// sees because Circle's maker delivers via Permit2, so /history's on-chain
// read (see lib/use-history or ReceiptClient.getHistory) can never surface
// them. Gated by a wallet signature, not an API key: a payer paying from
// /send or a pay link has no key, and this is read-only, so the endpoint
// requires proof of wallet control rather than acting on the wallet's behalf.
// See packages/api/internal/handlers/wallet_history.go for the verification.
export async function getWalletSettlements(
  wallet: string,
  timestamp: number,
  signature: string
): Promise<WalletSettlementRow[]> {
  const res = await fetch(`${API_BASE}/v1/wallet_settlements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, timestamp, signature }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = json.error ?? {};
    throw new ConduitApiError(err.message ?? `HTTP ${res.status}`, err.code, err.doc_url);
  }
  return (json as { data: WalletSettlementRow[] }).data;
}
