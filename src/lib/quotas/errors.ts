// #52 R2: fachliche Fehler der Quoten mit stabilem Code (Übersetzung in der UI über messages).
export type QuotaErrorCode =
  | "PLAN_MISSING" | "PLAN_CHANGED" | "MEA_INVALID" | "FIXED_NOT_DIVISIBLE" | "CUSTOM_INVALID" | "HOLDERS_INVALID"
  | "ALREADY_ISSUED_CONFLICT" | "SNAPSHOT_SUPERSEDED" | "HAS_PAYMENTS" | "USE_REFUND_AND_CANCEL"
  | "NOT_FOUND" | "INVALID_INPUT" | "RETRY_EXHAUSTED";

export class QuotaError extends Error {
  constructor(public code: QuotaErrorCode, message?: string, public details?: unknown) {
    super(message ? `${code}: ${message}` : code);
  }
}
