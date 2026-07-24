// ADR-004 — run explanations ("Why did this fail?"). A generated, cached,
// regeneratable (delete + insert) explanation of a failed/timed_out run,
// grounded in the run's own event log. Unlike `Eval` (append-only), a run
// explanation is a derived artifact — not itself a fact recorded about the
// run — so it may be regenerated (by an admin) without violating the event
// log's immutability guarantee; see docs/adr/004-run-explanations.md.

export type RunExplanationKind = "heuristic" | "llm";

export interface RunExplanation {
  id: string;
  orgId: string;
  runId: string;
  kind: RunExplanationKind;
  /** Plain-English summary of what happened. <= 2 KB. */
  summary: string;
  /** Plain-English root cause. <= 1 KB. */
  rootCause: string;
  /** Optional suggested remediation. <= 1 KB. */
  suggestedFix?: string;
  /** sequenceNumbers (from this run's event log) the explanation cites. <= 20 entries. */
  citedSequenceNumbers: number[];
  /** Free-form failure classification (e.g. "llm_error", "tool_error", "timeout", "unknown"). */
  failureClass: string;
  generatedAt: number;
  /** Present only when kind === "llm". */
  model?: string;
  /** Present only when kind === "llm" — wall-clock ms spent in the provider call, for cost/latency observability. */
  generationMs?: number;
  /** Schema version of this explanation shape. */
  version: number;
}

/** Lightweight batched "why-preview" shape returned by `getRunExplanationSummaries` — NOT the full explanation, just what a one-line list preview needs. */
export interface RunExplanationSummary {
  runId: string;
  summary: string;
  failureClass: string;
  kind: RunExplanationKind;
}

/**
 * Cycle 3 addition (additive, 0.7.4 -> 0.7.5): the explicit status
 * discriminant `getRunExplanation` (convex/run_explanations.ts) and
 * `apiGetExplanation` (convex/read_api.ts) now return alongside the
 * explanation itself. Closes a "coarse null" gap where "this run will never
 * have an explanation" (not failed/timed_out/cancelled) and "eligible, but
 * generation hasn't landed yet" were indistinguishable to a caller — both
 * used to read as `null`/`{ explanation: null }`, forcing a UI consumer to
 * guess from the run's own `endedAt` client-side.
 */
export type RunExplanationQueryStatus = "not_eligible" | "pending" | "ready";

/** The full shape `getRunExplanation`/`apiGetExplanation` return: the `status` discriminant above, the explanation itself (or null), and the run's own status/endedAt so a caller can apply a grace period without a second round-trip. */
export interface RunExplanationQueryResult {
  status: RunExplanationQueryStatus;
  explanation: RunExplanation | null;
  runStatus: string;
  runEndedAt?: number;
}
