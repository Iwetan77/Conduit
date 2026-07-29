// Mirrors packages/api/internal/errors/registry.go's Code enum exactly.
// Keep in sync by hand — there is no shared schema between Go and TS here yet
// (a generated OpenAPI spec would remove this duplication; out of scope for v1).

export type ConduitErrorCode =
  | "fx_quote_expired"
  | "fx_no_route"
  | "fx_invalid_amount"
  | "fx_provider_unavailable"
  | "currency_not_supported"
  | "intent_expired"
  | "intent_already_settled"
  | "idempotency_key_reuse"
  | "signature_invalid"
  | "insufficient_payer_balance"
  | "invalid_request"
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "internal_error";

export interface ConduitErrorBody {
  code: ConduitErrorCode | string;
  type: string;
  message: string;
  param?: string;
  doc_url: string;
}

/// @notice Thrown for every non-2xx response from the Conduit API. `code` is
///         typed (best-effort — an unrecognized code from a newer server
///         still comes through as a string) so callers can `switch` on it
///         instead of string-matching `message`, which is not a stable
///         contract.
export class ConduitError extends Error {
  readonly code: ConduitErrorCode | string;
  readonly type: string;
  readonly param?: string;
  readonly docUrl: string;
  readonly status: number;

  constructor(body: ConduitErrorBody, status: number) {
    super(body.message);
    this.name = "ConduitError";
    this.code = body.code;
    this.type = body.type;
    this.param = body.param;
    this.docUrl = body.doc_url;
    this.status = status;
  }
}

export class ConduitSignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConduitSignatureVerificationError";
  }
}
