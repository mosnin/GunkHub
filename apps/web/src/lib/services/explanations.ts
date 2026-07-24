import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

// ---------------------------------------------------------------------------
// "Why did this fail?" — run explanation, Explainability Layer (this cycle).
//
// Backed by convex/run_explanations.ts (Team A — ADR-004), which landed
// after this file was first written against a `convex/explanations.ts`
// filename guess; the convexFunctions.ts bindings were corrected to the real
// `run_explanations:*` names once that file shipped (see that file's own
// comment). This module's exported `RunExplanation` shape below matches the
// real `getRunExplanation` query's return type exactly (mirrors
// packages/contracts/src/run_explanations.ts's `RunExplanation`, minus `id`/
// `orgId`/`version`, which callers here don't need).
//
// getRunExplanation(runId) -> RunExplanation | null. `null` covers TWO
// distinct real states convex/run_explanations.ts collapses into the same
// value: the run hasn't failed/timed_out/cancelled (nothing to explain), OR
// it has but generation hasn't completed yet (still scheduled/in flight).
// This is a known, documented gap (docs/design/explanations.md "Known gap:
// coarse null state") — the UI's ExplanationPanel currently shows an
// "analyzing" state for both, which is not accurate for the first case.
// This is distinct from "the fetch failed", which callers see as a thrown
// error (Promise.allSettled in the run-detail page turns that into a
// per-section InlineError so the rest of the page still renders).
// ---------------------------------------------------------------------------

export type RunExplanationKind = 'heuristic' | 'llm'

export interface RunExplanation {
  kind: RunExplanationKind
  /** Plain-English, human-readable summary of what happened. Not markdown, not HTML — render as text. */
  summary: string
  /** Plain-English root cause. Render as text. */
  rootCause: string
  /** Actionable suggested fix, when the analysis produced one. Render as text. */
  suggestedFix?: string
  /** Event sequence numbers that ground the explanation — clickable in the UI. */
  citedSequenceNumbers: number[]
  /** Short machine-ish classification label, e.g. "tool_error", "timeout". */
  failureClass: string
  generatedAt: number
  /** Present only when kind === 'llm'. */
  model?: string
}

function mapExplanationResult(result: unknown): RunExplanation | null {
  if (!result) return null
  const r = result as Partial<RunExplanation>
  return {
    kind: r.kind === 'llm' ? 'llm' : 'heuristic',
    summary: typeof r.summary === 'string' ? r.summary : '',
    rootCause: typeof r.rootCause === 'string' ? r.rootCause : '',
    citedSequenceNumbers: Array.isArray(r.citedSequenceNumbers)
      ? r.citedSequenceNumbers.filter((n): n is number => typeof n === 'number')
      : [],
    failureClass: typeof r.failureClass === 'string' ? r.failureClass : 'unknown',
    generatedAt: typeof r.generatedAt === 'number' ? r.generatedAt : Date.now(),
    ...(typeof r.suggestedFix === 'string' && { suggestedFix: r.suggestedFix }),
    ...(typeof r.model === 'string' && { model: r.model }),
  }
}

/**
 * Fetch the explanation for a run, if one exists. Returns null when there is
 * nothing to show yet (run not failed, or generation still in progress / not
 * yet triggered) — never throws for that case. Throws only on a genuine
 * fetch failure (auth, network, backend error, or a `NOT_FOUND` for a
 * nonexistent run), which the caller should treat as an additive/non-fatal
 * failure.
 */
export async function getRunExplanation(runId: string): Promise<RunExplanation | null> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.explanations.getRunExplanation, { runId })
  return mapExplanationResult(result)
}

/**
 * Force regeneration of a run's explanation (Team C — backs
 * POST /api/runs/[id]/explanation/regenerate). Admin-gated: the Convex
 * ACTION `run_explanations:regenerateRunExplanation` enforces the admin role
 * itself (`_requireAdminForRegenerate`) and throws a `Forbidden:`-prefixed
 * error for a non-admin caller, and an `INVALID_ARGUMENT:` afrError if the
 * run's status isn't failed/timed_out/cancelled — this function does not
 * re-check either, it lets both throws propagate so the route's existing
 * `mapApiError` turns them into a clean 403 / 422 rather than a generic 500.
 *
 * The action itself returns a `GenerateRunExplanationResult` status object
 * (`{ skipped, reason }` or `{ skipped: false, kind, failureClass }`), NOT
 * the explanation document — so on success this re-fetches
 * `getRunExplanation` to return the actual fresh `RunExplanation` the caller
 * (and `ExplanationPanel`) expects, keeping this function's return type
 * consistent with `getRunExplanation`'s above.
 */
export async function regenerateRunExplanation(runId: string): Promise<RunExplanation | null> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  await client.action(convex.explanations.regenerateRunExplanation, { runId })
  return getRunExplanation(runId)
}
