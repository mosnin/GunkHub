import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// COVERAGE CONTRACT for `afr_explain_run` (tier 3 of the MCP progressive-
// disclosure ladder, docs/mcp.md).
//
// The tier-3 promotion — ~121 tokens to answer "why did this fail?" instead of
// ~3,838 for a raw event window — is only sound if an explanation is actually
// THERE when an agent asks. That guarantee is NOT held by any single file; it
// is spread across:
//
//   1. FIVE write-side sites that schedule generation, every one of them
//      resolved by STRING (`makeFunctionReference("run_explanations:...")`),
//      which TypeScript cannot check. A typo silently no-ops the schedule and
//      the run never gets an explanation.
//   2. FOUR read-side declarations of the `status` discriminant vocabulary,
//      each an independent hard-coded copy, two of which SILENTLY DOWNGRADE an
//      unrecognized value instead of failing.
//
// Both are cross-boundary invariants with no compiler behind them, so they are
// pinned here as source-level assertions. The behavioural tests for the sweep
// itself live in convex/run_explanations.test.ts (which runs under the Convex
// edge-runtime harness); this file is deliberately the boundary-spanning half.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '../..')
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

const GENERATE_REF = 'run_explanations:generateRunExplanation'
const BACKFILL_REF = 'run_explanations:backfillMissingExplanations'

// ---------------------------------------------------------------------------
// 1. Write side — every path that can leave a run needing an explanation
// ---------------------------------------------------------------------------

describe('explanation generation is scheduled from every terminal-failure path', () => {
  // A run reaches an explainable status (failed / timed_out / cancelled) via
  // exactly these four paths. Each must schedule generation, and each does it
  // through an unchecked string ref.
  const EAGER_SITES: ReadonlyArray<readonly [file: string, why: string]> = [
    ['convex/events.ts', 'Clerk-authed createEvent appending run.failed'],
    ['convex/sdk_ingest.ts', 'SDK batch ingest appending run.failed'],
    ['convex/runs.ts', 'admin updateRunStatus transitioning into a failure state'],
    ['convex/stale_runs.ts', 'stale-run-expiry cron marking a run timed_out'],
  ]

  it.each(EAGER_SITES)('%s schedules generation (%s)', (file) => {
    const src = read(file)
    expect(src).toContain(GENERATE_REF)
    expect(src).toContain('scheduler.runAfter(0, _generateRunExplanationRef')
  })

  it('the function name every site references is actually exported by convex/run_explanations.ts', () => {
    const src = read('convex/run_explanations.ts')
    const [module, fn] = GENERATE_REF.split(':')
    expect(module).toBe('run_explanations')
    expect(src).toMatch(new RegExp(`export const ${fn} = internalAction\\(`))
  })
})

describe('the coverage repair sweep closes the gap the eager schedules leave', () => {
  // Eager scheduling is FIRE-AND-FORGET with no retry: one runAfter(0, ...)
  // per terminal transition. When that single attempt does not land a row —
  // dropped/failed action, a transient `heuristic_engine_unavailable` skip, a
  // run that failed before ADR-004 shipped — `getRunExplanation` reports
  // `"pending"`, which instructs the caller to RETRY LATER. Without a sweep
  // that instruction never terminates. This is what bounds it.
  it('is registered as a cron in convex/crons.ts', () => {
    const src = read('convex/crons.ts')
    expect(src).toContain('backfill-missing-explanations')
    expect(src).toContain(BACKFILL_REF)
  })

  it('the cron string ref resolves to a real exported internalAction (nothing typechecks this)', () => {
    const src = read('convex/run_explanations.ts')
    const [module, fn] = BACKFILL_REF.split(':')
    expect(module).toBe('run_explanations')
    expect(src).toMatch(new RegExp(`export const ${fn} = internalAction\\(`))
  })

  it('is internalAction, never a public action — it is an unauthenticated cross-org batch job', () => {
    const src = read('convex/run_explanations.ts')
    // The `action({` (public) form must not appear anywhere near the sweep.
    const sweep = src.slice(src.indexOf('export const backfillMissingExplanations'))
    expect(sweep).toContain('internalAction({')
    expect(sweep).not.toMatch(/export const \w+ = action\(\{/)
  })

  it('is bounded on BOTH axes — rows read and generations fanned out', () => {
    const src = read('convex/run_explanations.ts')
    // A sweep with no read bound or no fan-out bound is the unbounded scan
    // this codebase's cron patterns forbid.
    expect(src).toContain('EXPLANATION_BACKFILL_SCAN_LIMIT')
    expect(src).toContain('EXPLANATION_BACKFILL_MAX_SCHEDULES')
    expect(src).toContain('EXPLANATION_BACKFILL_WINDOW_MS')
    expect(src).toContain('EXPLANATION_BACKFILL_GRACE_MS')
    // The index range is narrowed to one status AND lower-bounded by the
    // window — never a bare `.collect()` over runs.
    expect(src).toContain('withIndex("by_status_started", (q) => q.eq("status", args.status).gte("startedAt", args.windowStart))')
    expect(src).toContain('.take(args.scanLimit)')
  })

  it('never writes to the events table (explanations are derived artifacts — Event Log Rule 1)', () => {
    const src = read('convex/run_explanations.ts')
    expect(src).not.toMatch(/db\.(insert|patch|replace|delete)\(\s*["']events["']/)
    // The only table this file inserts into is run_explanations.
    const inserts = [...src.matchAll(/db\.insert\(\s*["']([a-z_]+)["']/g)].map((m) => m[1])
    expect([...new Set(inserts)]).toEqual(['run_explanations'])
  })
})

// ---------------------------------------------------------------------------
// 2. Read side — the status vocabulary is duplicated, and widening it silently
// ---------------------------------------------------------------------------

describe('the `status` discriminant vocabulary is duplicated across four boundaries and must stay in lockstep', () => {
  // `status` is what tells a tier-3 agent whether to stop or retry. There is
  // no shared type behind it: four files each hard-code the same closed set,
  // and two of them VALIDATE against their copy and silently fall back on a
  // value they do not recognize:
  //
  //   packages/mcp/src/tools/explain-run.ts  readStatus()   -> falls back to
  //     `explanation === null ? 'pending' : 'ready'`
  //   apps/web/src/lib/services/explanations.ts isKnownStatus() -> same
  //
  // So adding a fifth status server-side does NOT reach the agent: it is
  // downgraded to `"pending"`, i.e. "retry later", which is the exact
  // un-actionable answer a new status would have been added to avoid. Any
  // change to this vocabulary must therefore land in all four files at once —
  // that is what this test enforces.
  const EXPECTED = ['not_eligible', 'pending', 'ready'] as const

  const DECLARATIONS: ReadonlyArray<readonly [file: string, note: string]> = [
    ['convex/run_explanations.ts', 'RunExplanationQueryStatus (Clerk-authed web query)'],
    ['convex/read_api.ts', 'apiGetExplanation (key-authed v1 read API the MCP server calls)'],
    ['packages/mcp/src/tools/explain-run.ts', 'STATUSES allow-list, with a silent downgrade fallback'],
    ['apps/web/src/lib/services/explanations.ts', 'isKnownStatus, with a silent downgrade fallback'],
  ]

  it.each(DECLARATIONS)('%s declares exactly the shared vocabulary (%s)', (file) => {
    const src = read(file)
    for (const status of EXPECTED) {
      expect(src).toMatch(new RegExp(`['"]${status}['"]`))
    }
  })

  it('convex/run_explanations.ts exposes no status outside the shared set', () => {
    const src = read('convex/run_explanations.ts')
    const decl = /export type RunExplanationQueryStatus =([^;]+);/.exec(src)
    expect(decl).not.toBeNull()
    const declared = [...(decl?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
    expect(declared).toEqual([...EXPECTED].sort())
  })

  it('the two validating consumers still silently downgrade an unknown status (documenting why widening is blocked)', () => {
    // If either of these ever starts propagating unknown statuses instead of
    // collapsing them, this test should be revisited — widening the server
    // vocabulary becomes safe at that point.
    const mcp = read('packages/mcp/src/tools/explain-run.ts')
    expect(mcp).toContain("STATUSES.includes(raw)")
    expect(mcp).toContain("return explanation === null ? 'pending' : 'ready'")

    const web = read('apps/web/src/lib/services/explanations.ts')
    expect(web).toContain('isKnownStatus(')
    expect(web).toContain("status: explanation ? 'ready' : 'pending'")
  })
})

// ---------------------------------------------------------------------------
// 3. Determinism — an explanation must exist with zero external configuration
// ---------------------------------------------------------------------------

describe('an explanation never requires an LLM provider', () => {
  it('the default provider is the noop one, so an unset AFR_LLM_PROVIDER yields no LLM call', () => {
    const src = read('convex/helpers/llm_provider.ts')
    expect(src).toContain('return new NoopExplanationLLM()')
    expect(src).toContain('Promise.resolve(undefined)')
  })

  it('the deterministic heuristic is computed BEFORE and INDEPENDENTLY of the provider', () => {
    const src = read('convex/run_explanations.ts')
    const heuristicAt = src.indexOf('heuristic = heuristicBuilder(heuristicInput)')
    const providerAt = src.indexOf('getConfiguredExplanationLLM()')
    expect(heuristicAt).toBeGreaterThan(-1)
    expect(providerAt).toBeGreaterThan(-1)
    // Ordering is the guarantee: the stored result is already complete before
    // the provider is even resolved, so LLM absence/failure cannot yield null.
    expect(heuristicAt).toBeLessThan(providerAt)
    expect(src).toContain('let kind: "heuristic" | "llm" = "heuristic"')
  })

  it('the stored row records WHICH kind it is, so a derived summary is never mistaken for an analysed one', () => {
    const schema = read('convex/schema.ts')
    expect(schema).toContain('kind: v.union(v.literal("heuristic"), v.literal("llm"))')
    // And the tier-3 projection surfaces it to the agent.
    expect(read('packages/mcp/src/projections.ts')).toContain('result.kind = explanation.kind')
  })
})
