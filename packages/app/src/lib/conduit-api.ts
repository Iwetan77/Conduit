// Thin client for the Conduit API (packages/api). The dashboard is a thin
// client of this service only — no direct DB access, no contract reads for
// intent state (spec Phase 3 preamble). The only on-chain touch allowed from
// the app is the payer signing/submitting a transaction at checkout.

const API_BASE = process.env["NEXT_PUBLIC_CONDUIT_API_URL"] ?? "http://localhost:8080";
const STORAGE_KEY = "conduit_dashboard_api_key";

export function getApiKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setApiKey(key: string): void {
  window.localStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey(): void {
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
  const apiKey = options.apiKey ?? getApiKey();
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

export function listAccounts() {
  return request<{ data: Account[] }>("/v1/accounts");
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
}

export function getPublicSettlementIntent(id: string) {
  return request<PublicSettlementIntent>(`/v1/settlement_intents/${id}/public`);
}

// ── Cross-chain bridge (CCTP Solana -> Arc) ──────────────────────────────────

export interface BridgeInitiateResponse {
  transfer_id: string;
  state: string;
  unsigned_tx_base64?: string;
}

export function initiateBridge(intentId: string, payerAddress: string, usdcAmount: string) {
  return request<BridgeInitiateResponse>(`/v1/settlement_intents/${intentId}/bridge/initiate`, {
    method: "POST",
    body: { payer_address: payerAddress, usdc_amount: usdcAmount },
  });
}

export function reportBridgeBurn(intentId: string, transferId: string, sourceTxHash: string) {
  return request<BridgeInitiateResponse>(`/v1/settlement_intents/${intentId}/bridge/initiate`, {
    method: "POST",
    body: { transfer_id: transferId, source_tx_hash: sourceTxHash },
  });
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
  const apiKey = getApiKey();
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
