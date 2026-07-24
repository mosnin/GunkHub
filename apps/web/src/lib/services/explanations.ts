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

function mapBareExplanation(r: Partial<RunExplanation>): RunExplanation {
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

function mapExplanationResult(result: unknown): RunExplanation | null {
  if (!result) return null
  // Cycle-3 (Team A) wrapped the query result in a status discriminant:
  // `{ status, explanation, runStatus, runEndedAt }`. Unwrap to the inner
  // explanation. Stays tolerant of the pre-Cycle-3 bare `RunExplanation`
  // shape (undeployed backend) — if there's no `explanation` key but the
  // object looks like an explanation, treat it as the explanation itself.
  if (typeof result === 'object' && 'explanation' in result) {
    const inner = (result as { explanation: unknown }).explanation
    if (!inner) return null
    return mapExplanationResult(inner)
  }
  return mapBareExplanation(result as Partial<RunExplanation>)
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

// ---------------------------------------------------------------------------
// Real status discriminant (cycle 3, Team A) — closes the "coarse null
// state" gap for good, for the single-run read path. `getRunExplanation`
// above stays as-is (bare `RunExplanation | null`) for existing callers;
// this sibling exposes the full `{ status, explanation, runStatus,
// runEndedAt }` the query now actually returns, for any caller (this route,
// or a future ExplanationPanel revision) that wants the REAL discriminant
// instead of the `isStillAnalyzing`/`ANALYZING_GRACE_PERIOD_MS` time-based
// heuristic below (which remains in place for the batched summary path,
// where no per-run status discriminant exists yet — see
// getRunExplanationSummaries below).
// ---------------------------------------------------------------------------

/**
 * `"not_eligible"` — the run has never reached (and, being terminal-or-not,
 * may never reach) an explainable status; there is nothing to generate.
 * `"pending"` — the run IS eligible but generation hasn't completed yet
 * (scheduled/in flight). `"ready"` — a stored explanation exists.
 */
export type RunExplanationStatus = 'not_eligible' | 'pending' | 'ready'

export interface RunExplanationWithStatus {
  status: RunExplanationStatus
  explanation: RunExplanation | null
  runStatus: string
  runEndedAt?: number
}

function isKnownStatus(v: unknown): v is RunExplanationStatus {
  return v === 'not_eligible' || v === 'pending' || v === 'ready'
}

/**
 * Fetch the explanation for a run WITH the real status discriminant, when
 * the backend provides one. Falls back to inferring `pending`/`ready` from
 * a bare (pre-discriminant) result — never throws for "nothing to show
 * yet", only for a genuine fetch failure, same contract as
 * `getRunExplanation`.
 */
export async function getRunExplanationWithStatus(runId: string): Promise<RunExplanationWithStatus> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.explanations.getRunExplanation, { runId })

  if (result && typeof result === 'object' && 'status' in result && isKnownStatus((result as { status: unknown }).status)) {
    const r = result as { status: RunExplanationStatus; explanation: unknown; runStatus: string; runEndedAt?: number }
    return {
      status: r.status,
      explanation: r.explanation ? mapBareExplanation(r.explanation as Partial<RunExplanation>) : null,
      runStatus: r.runStatus,
      ...(r.runEndedAt !== undefined && { runEndedAt: r.runEndedAt }),
    }
  }

  // Pre-discriminant fallback: no way to distinguish not_eligible/pending, so
  // report the honest lesser claim ("pending") rather than guessing "ready".
  const explanation = mapExplanationResult(result)
  return { status: explanation ? 'ready' : 'pending', explanation, runStatus: 'unknown' }
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

// ---------------------------------------------------------------------------
// Batched "why" preview for run lists (Explainability Layer, cycle 2).
//
// There is no batch query on the Convex side yet — `run_explanations:*`
// only exposes the single-run `getRunExplanation`. NEEDED FROM DATA TEAM:
// a `run_explanations:getRunExplanationSummaries(runIds: string[])` batch
// query (org-scoped, same null-collapsing semantics as the single-run one)
// would let this fetch in one round-trip instead of N. Until that lands,
// this falls back to per-run `getRunExplanation` calls — capped to
// MAX_SUMMARY_BATCH and, more importantly, capped by the CALLER to only the
// visible FAILED/timed_out rows on the current page (never the whole list),
// which keeps the fan-out bounded to what's actually rendered.
// ---------------------------------------------------------------------------

/** Defensive upper bound on how many explanations this will fetch in one call, independent of what the caller passes. */
const MAX_SUMMARY_BATCH = 25

export type RunExplanationSummaryState =
  | { status: 'ready'; summary: string; failureClass: string }
  /** No explanation yet — could be still generating, or (per the coarse-null
      gap documented on getRunExplanation) not actually eligible. Callers
      should only request this for rows they already know are failed/timed_out,
      so in practice this reads as "still analyzing". */
  | { status: 'analyzing' }
  /** The fetch for this run failed, or it will never have an explanation.
      Render nothing — never a broken row. */
  | { status: 'unavailable' }

// ---------------------------------------------------------------------------
// "Analyzing… forever" honesty gap (cross-cutting audit finding, cycle 3).
//
// A `null`/missing explanation from Convex collapses two very different
// states: "generation is genuinely in flight" and "generation was never
// scheduled / will never happen" (a cancelled run, a pre-ADR-004 run, one
// whose generation was skipped or purged). Team A is exposing a proper
// status/endedAt discriminant on the explanation read this cycle — until
// that lands, this uses the one honest signal callers already have: the
// run's own `endedAt`. Once a run has been over for longer than the grace
// period below and still has no explanation, treating it as "still
// analyzing" is not just imprecise, it's actively misleading (a pulsing dot
// implies live work). `ExplanationPanel` and the list previews both apply
// this same threshold so they read as one honest system, not two guesses.
// ---------------------------------------------------------------------------

/** How long to keep showing an "analyzing" state after a run ended before
    treating a still-missing explanation as "not available" instead of "in
    progress". Generous on purpose (scheduling lag is normal) but bounded so
    the state is never a permanent lie. */
export const ANALYZING_GRACE_PERIOD_MS = 2 * 60 * 1000

/** True while a null/missing explanation should still read as "analyzing" —
    i.e. the run hasn't ended yet, or ended too recently to conclude
    generation was skipped. `endedAt === undefined` covers still-running runs
    (nothing to explain yet, but also nothing dishonest about "analyzing"
    since the run itself isn't done). */
export function isStillAnalyzing(endedAt: number | undefined, now: number = Date.now()): boolean {
  return endedAt === undefined || now - endedAt < ANALYZING_GRACE_PERIOD_MS
}

/**
 * Downgrades any `{ status: 'analyzing' }` entry to `{ status: 'unavailable' }`
 * for runs that ended more than `ANALYZING_GRACE_PERIOD_MS` ago — so a
 * failed-runs-list preview degrades to rendering nothing (see
 * `ExplanationPreview`) instead of an indefinite "analyzing failure…" pulse
 * for a run that will never get one. Pure and non-throwing; callers pass the
 * same run objects they already have (only `id` and `endedAt` are read).
 */
export function withAnalyzingGracePeriod(
  summaries: Record<string, RunExplanationSummaryState>,
  runs: ReadonlyArray<{ id: string; endedAt?: number }>,
): Record<string, RunExplanationSummaryState> {
  const endedAtById = new Map(runs.map((r) => [r.id, r.endedAt]))
  const now = Date.now()
  const out: Record<string, RunExplanationSummaryState> = {}
  for (const [runId, state] of Object.entries(summaries)) {
    out[runId] =
      state.status === 'analyzing' && !isStillAnalyzing(endedAtById.get(runId), now)
        ? { status: 'unavailable' }
        : state
  }
  return out
}

/**
 * Batched (best-effort, per-row-fallback) fetch of explanation summaries for
 * a set of run IDs — meant for the failed-runs-list "why" preview. Never
 * throws: a per-run failure becomes `{ status: 'unavailable' }` for that run
 * only, so one bad fetch can't blank the whole list. Callers MUST pre-filter
 * to the visible FAILED/timed_out rows before calling this — it does not
 * check run status itself, it only bounds the batch size defensively.
 */
export async function getRunExplanationSummaries(
  runIds: string[],
): Promise<Record<string, RunExplanationSummaryState>> {
  const capped = runIds.slice(0, MAX_SUMMARY_BATCH)
  if (capped.length === 0) return {}

  // Preferred: one org-scoped batch round-trip (convex/run_explanations.ts
  // getRunExplanationSummaries, Team A). It omits runs with no explanation
  // yet, so any requested id missing from the result is still "analyzing".
  try {
    const client = await getAuthedClient()
    const rows = (await client.query(convex.explanations.getRunExplanationSummaries, {
      runIds: capped,
    })) as Array<{ runId: string; summary: string; failureClass: string }>
    const byId = new Map(rows.map((r) => [r.runId, r]))
    const out: Record<string, RunExplanationSummaryState> = {}
    for (const runId of capped) {
      const row = byId.get(runId)
      out[runId] = row
        ? { status: 'ready', summary: row.summary, failureClass: row.failureClass }
        : { status: 'analyzing' }
    }
    return out
  } catch {
    // Fallback (e.g. the batch query isn't deployed yet): per-run fetch,
    // still bounded to the capped visible rows.
    const settled = await Promise.allSettled(capped.map((id) => getRunExplanation(id)))
    const out: Record<string, RunExplanationSummaryState> = {}
    settled.forEach((result, i) => {
      const runId = capped[i]
      if (!runId) return
      if (result.status === 'fulfilled') {
        out[runId] = result.value
          ? { status: 'ready', summary: result.value.summary, failureClass: result.value.failureClass }
          : { status: 'analyzing' }
      } else {
        out[runId] = { status: 'unavailable' }
      }
    })
    return out
  }
}
