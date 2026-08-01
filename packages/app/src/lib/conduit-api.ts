// Thin client for the Conduit API (packages/api). The dashboard is a thin
// client of this service only — no direct DB access, no contract reads for
// intent state (spec Phase 3 preamble). The only on-chain touch allowed from
// the app is the payer signing/submitting a transaction at checkout.

const API_BASE = process.env.NEXT_PUBLIC_CONDUIT_API_URL ?? "http://localhost:8080";
const STORAGE_KEY = "conduit_dashboard_session_token";

// Bearer token used for dashboard requests. Holds either a Privy access
// token (refreshed periodically by the dashboard layout while a merchant is
// logged in via Privy -- see DashboardLayout) or, still, a pasted sk_/pk_
// key for the programmatic-access path -- the API's auth.Middleware accepts
// both, so this file doesn't need to know which kind it's holding.
export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setSessionToken(token: string): void {
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearSessionToken(): void {
  window.localStorage.removeItem(STORAGE_KEY);
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

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; apiKey?: string; idempotencyKey?: string } = {}
): Promise<T> {
  const apiKey = options.apiKey ?? getSessionToken();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

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
  settle_currency: string;
  settle_address: string;
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

export function createSubAccount(body: { name: string; settle_currency: string; settle_address: string }) {
  return request<AccountWithKey>("/v1/accounts/sub", { method: "POST", body });
}

// Phase 4: recipient identity. getMyAccount resolves the caller's own
// account without needing its id up front (Settings loads this to edit).
export function getMyAccount() {
  return request<Account>("/v1/accounts/me");
}

export function updateAccount(id: string, body: { name?: string; logo_url?: string; settle_currency?: string; settle_address?: string }) {
  return request<Account>(`/v1/accounts/${id}`, { method: "PATCH", body });
}

export function listAccounts() {
  return request<{ data: Account[] }>("/v1/accounts");
}

export interface PrivyAccount {
  id: string;
  name: string;
  settle_currency: string;
  settle_address: string;
  login_wallet: string;
  livemode: boolean;
}

// Idempotent Privy login bootstrap -- called on every successful Privy
// login, not only the first. accessToken authenticates the request itself
// (this route isn't behind the usual session-token plumbing, since a
// brand-new Privy user has no account yet). On first login the body's
// name/settle_currency/login_wallet are required by the server; on
// subsequent logins the body is ignored and the existing account returned.
export function createAccountFromPrivy(
  accessToken: string,
  body: { name?: string; settle_currency?: string; settle_address?: string; login_wallet: string }
) {
  return request<PrivyAccount>("/v1/accounts/privy", { method: "POST", body, apiKey: accessToken });
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

export function quoteSettlementIntent(id: string, payCurrency: string, apiKey?: string) {
  return request<{ rate: string; pay_amount: string; expires_at: string }>(
    `/v1/settlement_intents/${id}/quote`,
    { method: "POST", body: { pay_currency: payCurrency }, apiKey }
  );
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
}

export function getPublicSettlementIntent(id: string) {
  return request<PublicSettlementIntent>(`/v1/settlement_intents/${id}/public`);
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

// ── Settlements (per-payment view: paid, received, rate, fee, tx link) ──────

export interface Settlement {
  id: string;
  intent_id: string;
  reference?: string;
  settle_address: string;
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

export function createPaymentLink(body: {
  amount_mode: AmountMode;
  amount?: string;
  min_amount?: string;
  max_amount?: string;
  settle_currency: string;
  settle_address: string;
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
