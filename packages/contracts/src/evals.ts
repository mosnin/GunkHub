// ADR-002 — evals. Append-only: no update/delete counterpart exists.

export type EvalKind = "rule" | "llm_judge" | "manual";

export interface Eval {
  id: string;
  orgId: string;
  runId: string;
  agentVersionId?: string;
  name: string;
  kind: EvalKind;
  passed: boolean;
  score?: number;
  details?: string;
  createdAt: number;
  /** Clerk user ID, or "system" for the API-key (sdkRecordEval) path. */
  createdBy: string;
}
