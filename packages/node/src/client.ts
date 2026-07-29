import { randomUUID } from "node:crypto";
import { ConduitError, type ConduitErrorBody } from "./errors.js";

export interface ConduitClientConfig {
  apiKey: string;
  /** Defaults to https://api.conduit.xyz — override for local dev against packages/api. */
  baseURL?: string;
}

export interface SettlementIntent {
  id: string;
  status: string;
  amount: string;
  settle_currency: string;
  settle_address: string;
  accept_currencies: string[];
  reference?: string;
  metadata?: Record<string, unknown>;
  expires_at: string;
  created: string;
  hosted_url: string;
  qr_payload: string;
}

export interface CreateSettlementIntentParams {
  amount: string | number;
  settle_currency: string;
  settle_address: string;
  accept_currencies?: string[];
  reference?: string;
  expires_in?: number;
  metadata?: Record<string, unknown>;
}

export interface Account {
  id: string;
  name: string;
  settle_currency: string;
  settle_address: string;
  livemode: boolean;
  api_key?: { key: string; prefix: string; suffix: string };
}

export interface CreateAccountParams {
  name: string;
  settle_currency: string;
  settle_address: string;
  livemode?: boolean;
}

class Requestor {
  constructor(private baseURL: string, private apiKey: string) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { idempotencyKey?: string } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    // Auto-generate an idempotency key on every mutating call the caller
    // didn't already key themselves — per spec §4: "Auto-generate an
    // idempotency key when the caller omits one."
    if (method !== "GET") {
      headers["idempotency-key"] = opts.idempotencyKey ?? randomUUID();
    }

    const res = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const errBody: ConduitErrorBody = json.error ?? {
        code: "internal_error",
        type: "conduit_error",
        message: `HTTP ${res.status}`,
        doc_url: "https://docs.conduit.xyz/errors/internal_error",
      };
      throw new ConduitError(errBody, res.status);
    }
    return json as T;
  }
}

class SettlementIntentsResource {
  constructor(private req: Requestor) {}

  create(params: CreateSettlementIntentParams, idempotencyKey?: string): Promise<SettlementIntent> {
    return this.req.request("POST", "/v1/settlement_intents", params, { idempotencyKey });
  }

  retrieve(id: string): Promise<SettlementIntent> {
    return this.req.request("GET", `/v1/settlement_intents/${id}`);
  }

  list(): Promise<{ data: SettlementIntent[] }> {
    return this.req.request("GET", "/v1/settlement_intents");
  }

  cancel(id: string): Promise<SettlementIntent> {
    return this.req.request("POST", `/v1/settlement_intents/${id}/cancel`);
  }
}

class AccountsResource {
  constructor(private req: Requestor) {}

  create(params: CreateAccountParams): Promise<Account> {
    return this.req.request("POST", "/v1/accounts", params);
  }

  retrieve(id: string): Promise<Account> {
    return this.req.request("GET", `/v1/accounts/${id}`);
  }

  list(): Promise<{ data: Account[] }> {
    return this.req.request("GET", "/v1/accounts");
  }
}

export class Conduit {
  readonly settlementIntents: SettlementIntentsResource;
  readonly accounts: AccountsResource;

  constructor(config: ConduitClientConfig) {
    const req = new Requestor(config.baseURL ?? "https://api.conduit.xyz", config.apiKey);
    this.settlementIntents = new SettlementIntentsResource(req);
    this.accounts = new AccountsResource(req);
  }
}
