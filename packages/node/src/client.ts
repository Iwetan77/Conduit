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
  /**
   * Removed. An intent settles to the address of the account that created it,
   * derived server-side and snapshotted onto the intent. The API rejects this
   * field rather than ignoring it, so leaving it in place would turn every
   * create into a 400 rather than quietly settling somewhere unexpected.
   */
  settle_address?: never;
  accept_currencies?: string[];
  reference?: string;
  expires_in?: number;
  metadata?: Record<string, unknown>;
}

export interface Employee {
  id: string;
  name: string;
  address: string;
  username: string | null;
  pay_currency: string;
  pay_type: "fixed" | "variable";
  /** Null for a variable employee, by construction. */
  amount: string | null;
  status: "active" | "paused" | "archived";
}

export interface CreateEmployeeParams {
  name: string;
  /**
   * Preferred over `address`. A username is resolved against a real account;
   * an address is taken on trust, because there is nothing to check it against.
   */
  username?: string;
  address?: string;
  pay_currency: string;
  pay_type: "fixed" | "variable";
  /** Required for a fixed employee, refused for a variable one. */
  amount?: string;
}

export interface PayrollRun {
  id: string;
  status: "draft" | "converting" | "executing" | "completed" | "partial" | "failed";
  treasury_currency: string;
  items: Array<{
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
  }>;
  groups: Array<{
    currency: string;
    total: string;
    recipients: number;
    needs_conversion: boolean;
    status: string;
  }>;
  created_at: string;
  executed_at: string | null;
  wallet_balance?: string;
  estimated_gas?: string;
  balance_covers?: boolean;
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

class EmployeesResource {
  constructor(private req: Requestor) {}

  create(params: CreateEmployeeParams): Promise<Employee> {
    return this.req.request("POST", "/v1/employees", params);
  }

  list(includeArchived = false): Promise<{ data: Employee[] }> {
    return this.req.request(
      "GET",
      `/v1/employees${includeArchived ? "?include_archived=true" : ""}`,
    );
  }

  update(
    id: string,
    params: Partial<Pick<CreateEmployeeParams, "name" | "pay_currency" | "pay_type" | "amount">> & {
      status?: "active" | "paused";
    },
  ): Promise<Employee> {
    return this.req.request("PATCH", `/v1/employees/${id}`, params);
  }

  /**
   * The only way somebody leaves the list. Never a delete: a removed row breaks
   * the history of every run that paid them.
   */
  archive(id: string): Promise<Employee> {
    return this.req.request("POST", `/v1/employees/${id}/archive`, {});
  }
}

class PayrollResource {
  constructor(private req: Requestor) {}

  /** Builds a draft and returns the full preview. Nothing is paid. */
  createRun(amounts?: Record<string, string>): Promise<PayrollRun> {
    return this.req.request("POST", "/v1/payroll_runs", { amounts: amounts ?? {} });
  }

  getRun(id: string): Promise<PayrollRun> {
    return this.req.request("GET", `/v1/payroll_runs/${id}`);
  }

  listRuns(): Promise<{ data: PayrollRun[] }> {
    return this.req.request("GET", "/v1/payroll_runs");
  }

  /**
   * Claims the run and returns the legs to sign.
   *
   * `runKey` is required. A retried request is indistinguishable from a second
   * payroll without one, and the server refuses a key it has already seen — so
   * reusing the same key on a retry is the SAFE thing to do, and generating a
   * fresh one is what would pay everybody twice.
   */
  executeRun(
    id: string,
    runKey: string,
  ): Promise<{
    run_id: string;
    status: string;
    spender: string;
    legs: Array<{
      currency: string;
      token: string;
      total: string;
      needs_conversion: boolean;
      recipients: string[];
      amounts: string[];
      run_id_hash: string;
    }>;
  }> {
    return this.req.request("POST", `/v1/payroll_runs/${id}/execute`, { run_key: runKey });
  }

  /** Reports one currency group's outcome. The server checks the chain. */
  recordLeg(
    id: string,
    params: { currency: string; tx_hash?: string; failed?: boolean; error?: string },
  ): Promise<PayrollRun> {
    return this.req.request("POST", `/v1/payroll_runs/${id}/legs`, params);
  }
}

export class Conduit {
  readonly settlementIntents: SettlementIntentsResource;
  readonly accounts: AccountsResource;
  readonly employees: EmployeesResource;
  readonly payroll: PayrollResource;

  constructor(config: ConduitClientConfig) {
    const req = new Requestor(config.baseURL ?? "https://api.conduit.xyz", config.apiKey);
    this.settlementIntents = new SettlementIntentsResource(req);
    this.accounts = new AccountsResource(req);
    this.employees = new EmployeesResource(req);
    this.payroll = new PayrollResource(req);
  }
}
