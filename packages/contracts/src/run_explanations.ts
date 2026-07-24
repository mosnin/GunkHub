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
