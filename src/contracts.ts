export type Provider = "moodle" | "google" | "migration";
export type Coverage =
  | "complete"
  | "partial"
  | "denied"
  | "unavailable"
  | "expired"
  | "timeout"
  | "parsing_error";
export interface Principal {
  readonly ownerId: string;
  readonly clientId?: string;
}
export interface Provenance {
  system: string;
  locator: string;
  version?: string;
  excerpt?: string;
  observed_at?: string;
  occurred_at?: string;
  original_date?: string;
}
export interface Delta {
  idempotency_key: string;
  context_id: string;
  kind: "decision" | "correction" | "preference" | "submission_report" | "artifact" | "experience";
  content: string;
  evidence_kind: "user_report" | "observed" | "interpretation" | "hypothesis";
  expected_version: number;
  provenance: Provenance[];
  scope?: Record<string, string>;
}
export class HubError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
