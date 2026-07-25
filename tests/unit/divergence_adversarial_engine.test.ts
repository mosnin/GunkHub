/**
 * DIVERGENCE ENGINE — ADVERSARIAL SUITE (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * The replay-divergence feature: given a run's recorded event history and two
 * `AgentVersion.configSnapshot`s, report where a TARGET version would have
 * diverged from what was RECORDED. Its output authorises FLEET-WIDE DEPLOYS,
 * so the thing under attack is not "does it compute a diff" but "does it ever
 * claim more confidence than it has, and does it ever claim less".
 *
 * TWO INDEPENDENT ENGINES ARE IN THIS TREE AND THIS SUITE BINDS TO BOTH:
 *
 *   A. `convex/helpers/divergence.ts` — proven/speculative/unassessed, mirrors
 *      `packages/contracts/src/divergence.ts`. Reached by `convex/divergence.ts`.
 *   B. `apps/web/src/lib/divergence/{analyze,group}.ts` — a SEPARATE engine with
 *      a different taxonomy. This is the one `apps/web/src/lib/services/divergence.ts`
 *      actually wires into the UI; that file states it deliberately does NOT
 *      call `convex.divergence.*`. So the pages an operator reads are served by
 *      engine B, and engine B is materially weaker. See the report.
 *
 * Both are loaded HARD. If either cannot be loaded this suite FAILS; it is not
 * skipped. A skip-on-missing gate is how an adversarial suite goes green while
 * proving nothing, and this repo has been bitten by exactly that.
 *
 * ── THE DEFECT LEDGER ──────────────────────────────────────────────────────
 * Several attacks below FIND REAL DEFECTS. Asserting the correct behaviour
 * would leave a permanently red suite in a tree four other teams are working
 * in; asserting the current behaviour would pin the bug and is how defects
 * become features. This suite does neither.
 *
 * Every attack RUNS FOR REAL and compares actual behaviour against the CORRECT
 * expectation. A mismatch is appended to `observedDefects` with a stable id.
 * One final test asserts `observedDefects` is EXACTLY `KNOWN_DEFECTS`. So:
 *
 *   - a defect getting fixed   -> ledger mismatch -> RED (delete the entry)
 *   - a new defect appearing   -> ledger mismatch -> RED
 *   - the status quo           -> GREEN, with every defect named, executed,
 *                                 and reproducible from the case that found it
 *
 * This machinery has already earned its keep. Between two runs of this file the
 * convex engine was rewritten underneath it; the ledger went red rather than
 * silently grading a different API, and one probe
 * (`final-event-page-reports-clean`) was RETRACTED because it no longer
 * reproduced. Nothing here is reported from reading alone.
 *
 * ── ANTI-VACUITY ───────────────────────────────────────────────────────────
 * `teeth/*` breaks each checker's subject in memory and asserts THIS SUITE'S
 * OWN checkers reject it. `FIXTURE AUDIT` blocks inside probes assert each
 * adversarial fixture actually exercises the bound it claims — last cycle a
 * 9,000-char string was used to test a DEPTH bound and would have passed while
 * cutting nothing, and on this file's first run two fixtures were wrong and
 * were caught by these audits rather than by review.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 * Tenancy is enforced in `convex/divergence.ts` query handlers against a live
 * `ctx.db` + Clerk identity. There is no Convex deployment in this test
 * environment, so cross-org outcome-equality is asserted STRUCTURALLY here
 * (`tenancy/*`) and the runtime/timing oracle is named as untested in the
 * report rather than faked with a mock that would only grade my own mock.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'

import * as contractsModule from '@agent-flight-recorder/contracts'
import {
  computeDivergenceVerdict as contractsVerdict,
  isFleetScanComplete as contractsIsFleetScanComplete,
  MAX_DIVERGENCE_REPRESENTATIVE_RUNS as contractsMaxRepresentativeRuns,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

// The REAL contract functions, imported (not mirrored) — this file is the only
// place the two vocabularies meet, which is the point of the mirror-drift group.

// ---------------------------------------------------------------------------
// Binding to the two shipped engines
// ---------------------------------------------------------------------------
//
// Non-literal specifiers: keeps `convex/` and `apps/web/` out of
// tests/tsconfig.json's program (same reason otlp_adversarial_roundtrip.test.ts
// and otel_ordering_adversarial.test.ts do it), so this file does not have to
// buy into tests/tsconfig.convex-seam.json or inherit apps/web's compiler
// options. The modules are still loaded and executed for real.

const CONVEX_ENGINE = '../../convex/helpers/divergence.js'
const WEB_ADAPT = '../../apps/web/src/lib/divergence/adapt.ts'


// ---- convex engine surface (mirrors packages/contracts/src/divergence.ts) ---

type CxVerdict = 'incompatible' | 'compatible_with_caveats' | 'compatible' | 'indeterminate'

interface CxProof {
  citedEvent: { sequenceNumber: number; eventId?: string; eventType: string }
  targetConfigPath: string
  recordedValue: string
  targetValue: string | null
}

interface CxProven {
  certainty: 'proven'
  kind: string
  reasonKey: string
  provenClaim: string
  provenBy: CxProof[]
}

interface CxSpeculative {
  certainty: 'speculative'
  kind: string
  reasonKey: string
  speculativeConcern: string
  speculativeBecause: string
  changedConfigPath: string
}

interface CxCoverage {
  assessed: string[]
  unassessed: Array<{ dimension: string; reason: string; detail?: string }>
  eventsExamined: number
  eventHistoryComplete: boolean
}

interface CxRunAnalysis {
  verdict: CxVerdict
  proven: CxProven[]
  speculative: CxSpeculative[]
  coverage: CxCoverage
}

interface CxScanWindow {
  since?: number
  until?: number
  runsScanned: number
  runsAnalyzed: number
  runsUnassessable: number
  scanTruncated: boolean
  scanRowCeiling?: number
}

interface CxFleetAnalysis {
  verdict: CxVerdict
  provenReasons: Array<{
    reasonKey: string
    kind: string
    certainty: 'proven'
    affectedRunCount: number
    representativeRunIds: string[]
    exemplar: CxProven
  }>
  speculativeReasons: Array<{
    reasonKey: string
    kind: string
    certainty: 'speculative'
    affectedRunCount: number
    representativeRunIds: string[]
  }>
  runsWithProvenDivergence: number
  window: CxScanWindow
}

interface CxObservableEvent {
  type: string
  sequenceNumber: number
  payload: unknown
  _id?: string
  provenance?: { source?: string; lossy?: boolean } | undefined
}

interface ConvexEngine {
  readConfigSnapshot: (snapshot: unknown) => {
    snapshotStatus: string
    tools: { status: 'read' | 'absent' | 'malformed'; value?: Array<{ name: string }> }
  }
  analyzeConfigPair: (
    baseline: unknown,
    target: unknown,
  ) => {
    target: { tools: { status: string } }
    targetToolsByName: Map<string, unknown> | null
    targetModels: Set<string> | null
    targetBudgets: Record<string, number> | null
    speculative: CxSpeculative[]
    unassessed: Array<{ dimension: string; reason: string }>
  }
  extractRunObservation: (
    events: CxObservableEvent[],
    options?: { scanTruncated?: boolean },
  ) => { toolCalls: Array<{ name: string }>; gaps: string[]; gapCounts: Record<string, number> }
  analyzeRunDivergence: (
    baseline: unknown,
    target: unknown,
    events: CxObservableEvent[],
    options?: { scanTruncated?: boolean },
  ) => CxRunAnalysis
  foldFleetDivergence: (
    analyses: Array<{ runId: string; analysis: CxRunAnalysis }>,
    window: Omit<CxScanWindow, 'runsAnalyzed' | 'runsUnassessable'>,
  ) => CxFleetAnalysis
  mergeFleetAnalyses: (pages: CxFleetAnalysis[]) => CxFleetAnalysis
  computeDivergenceVerdict: (i: {
    provenCount: number
    speculativeCount: number
    complete: boolean
  }) => CxVerdict
  isDivergenceCoverageComplete: (c: CxCoverage) => boolean
  isFleetScanComplete: (w: CxScanWindow) => boolean
  MAX_DIVERGENCE_REPRESENTATIVE_RUNS: number
}

// ---- the adapter the UI renders ------------------------------------------

interface WebAdapt {
  adaptRunReport: (envelope: Record<string, unknown>) => {
    verdict: CxVerdict
    proven: CxProven[]
    speculative: CxSpeculative[]
    indeterminate: Array<{ certainty: 'indeterminate'; kind: string; reasonKey: string }>
    coverage: CxCoverage
  }
  adaptFleetReport: (envelope: Record<string, unknown>) => {
    verdict: CxVerdict
    provenReasons: unknown[]
    speculativeReasons: unknown[]
    indeterminateReasons: unknown[]
    window: CxScanWindow
  }
  liftUnassessedToIndeterminate: (
    coverage: CxCoverage,
    existing?: readonly { reasonKey: string }[],
  ) => Array<{ reasonKey: string; kind: string }>
}

const cx = (await import(CONVEX_ENGINE)) as unknown as ConvexEngine
/**
 * The adapter the UI actually renders. `apps/web/src/lib/services/divergence.ts`
 * calls `convex.divergence.analyzeRun` / `analyzeFleet` and passes the result
 * through here, so this — not the engine — is the last thing between the
 * engine's numbers and an operator's deploy decision.
 */
const adapt = (await import(WEB_ADAPT)) as unknown as WebAdapt

/**
 * The OPTIONAL route-layer projection stopgap.
 *
 * It existed while the backend force-included identifiers only, and was written
 * to be deleted once the durable fix landed. It since has been. This binding is
 * therefore a DISCOVERY, not an assumption: the seam group asserts the
 * completeness invariant over whatever layers exist, so it passes with one
 * layer, passes with two, and fails if the surviving layer stops upholding it.
 *
 * Hard-coding either "there are two layers" or "there is one" is what makes a
 * seam test wrong the day someone changes the layering — which is the day it
 * most needs to be right.
 */
const routeFields: {
  withCompletenessFields: (
    kind: 'run' | 'fleet' | 'config',
    fields: string[] | undefined,
  ) => string[] | undefined
} | null = await (async () => {
  try {
    const specifier = '../../apps/web/app/api/v1/_lib/divergenceFields.ts'
    return (await import(specifier)) as never
  } catch {
    return null
  }
})()

/**
 * The per-run event page size `convex/divergence.ts` TIER 2 actually ships,
 * read from source text. That module cannot be imported here (it pulls in
 * `./_generated/server.js`), but the constant decides where a run's event
 * history is split across query executions, so probes about paging bind to it
 * rather than guessing. A change to it turns those probes red, which is intended.
 */
const SHIPPED_EVENT_PAGE_SIZE: number = (() => {
  const src = readFileSync(new URL('../../convex/divergence.ts', import.meta.url), 'utf8')
  const m = /DIVERGENCE_EVENT_PAGE_SIZE = (\d+)/.exec(src)
  if (!m) throw new Error('DIVERGENCE_EVENT_PAGE_SIZE not found in convex/divergence.ts')
  return Number(m[1])
})()

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

const observedDefects: string[] = []
const ledgerEvidence = new Map<string, unknown>()

function defect(id: string, evidence: unknown): void {
  if (!observedDefects.includes(id)) observedDefects.push(id)
  ledgerEvidence.set(id, evidence)
}

/**
 * ── PROBE LIVENESS (permanent, not a one-off) ──────────────────────────────
 *
 * A ledger that observes nothing has two possible causes, and they could not be
 * more different: the defects were fixed, or THE PROBES WENT BLIND. Contracts
 * moved under this file twice in one session (`provable` -> `proven`, a third
 * `indeterminate` class, `dimension` becoming required, `affectedDimension`
 * renamed). A probe that reads a field which no longer exists computes `false`
 * and records nothing — indistinguishable, at the ledger, from a clean tree.
 *
 * So every probe's DETECTION PREDICATE is factored out here and used twice:
 *
 *   - against the REAL engine, by the probe    -> may or may not fire
 *   - against a DELIBERATELY BROKEN subject    -> MUST fire, every run
 *
 * The second is the liveness proof. If a predicate cannot be made to fire, the
 * probe is dead and this suite fails REGARDLESS of what the ledger says. That is
 * the only way an empty ledger can be believed.
 *
 * Each mutant is the shape the engine had WHEN THE DEFECT WAS REAL, so the
 * liveness test is also a permanent regression fixture for the fix itself.
 */
interface ProbePredicate<T> {
  readonly id: string
  /** Recognises the defect in a subject. Used by the probe AND the liveness test. */
  readonly detects: (subject: T) => boolean
  /** A subject that MUST trip `detects` — the recorded shape of the original defect. */
  readonly mutant: () => T
  /** Why this mutant is the historical defect, for a reader of a red run. */
  readonly wasReal: string
}

function probe<T>(p: ProbePredicate<T>): ProbePredicate<T> {
  PROBES.push(p as ProbePredicate<unknown>)
  return p
}

const PROBES: ProbePredicate<unknown>[] = []

/** `verdict === 'compatible'` on a population that analysed nothing. */
const P_EMPTY_AFFIRMATIVE = <T extends { verdict: string; window: { runsAnalyzed: number } }>(
  id: string,
  wasReal: string,
): ProbePredicate<T> =>
  probe<T>({
    id,
    detects: (r) => r.verdict === 'compatible' && r.window.runsAnalyzed === 0,
    mutant: () =>
      ({ verdict: 'compatible', window: { runsAnalyzed: 0, runsScanned: 0 } }) as unknown as T,
    wasReal,
  })

const PROBE_EMPTY_FOLD = P_EMPTY_AFFIRMATIVE<{
  verdict: string
  window: { runsAnalyzed: number }
}>(
  'convex/empty-fleet-fold-returns-compatible',
  'foldFleetDivergence([]) returned `compatible`: an empty window is vacuously complete, so zero analysed runs read as a clean bill.',
)

const PROBE_EMPTY_MERGE = P_EMPTY_AFFIRMATIVE<{
  verdict: string
  window: { runsAnalyzed: number }
}>(
  'convex/empty-fleet-merge-returns-compatible',
  'mergeFleetAnalyses([]) returned `compatible` from no pages at all.',
)

const PROBE_ADAPT_EMPTY = P_EMPTY_AFFIRMATIVE<{
  verdict: string
  window: { runsAnalyzed: number }
}>(
  'web/adapt-empty-fleet-renders-compatible',
  'adaptFleetReport over an empty batch rendered `compatible` with zero indeterminate reasons — the same vacuity at the surface an operator reads.',
)

const PROBE_FLEET_TRUNCATION = probe<{
  fleetVerdict: string
  adaptedVerdict: string
}>({
  id: 'convex/fleet-fold-ignores-per-run-history-truncation',
  detects: (r) => r.fleetVerdict === 'compatible' || r.adaptedVerdict === 'compatible',
  mutant: () => ({ fleetVerdict: 'compatible', adaptedVerdict: 'indeterminate' }),
  wasReal:
    'foldFleetDivergence read only `coverage.assessed.length`, so 25 runs each reporting eventHistoryComplete:false folded to `compatible`. Tier 3 truncates every run over DIVERGENCE_FLEET_EVENTS_PER_RUN, so this was the default path.',
})

const PROBE_TOOL_MAP_STRING = probe<{
  declaredNames: string[]
  provenKeys: string[]
}>({
  id: 'convex/tool-map-string-value-misparsed-as-tool-name',
  detects: (r) =>
    !r.declaredNames.includes('search') && r.provenKeys.includes('tool_removed:search'),
  mutant: () => ({ declaredNames: ['Search the web'], provenKeys: ['tool_removed:search'] }),
  wasReal:
    'parseToolEntry short-circuited on a string entry and discarded the map KEY it was handed as fallbackName, so {tools:{search:"Search the web"}} declared a tool named after its description and proved `tool_removed:search` against a tool the target declares.',
})

const PROBE_NAMESPACED_CLAIM = probe<{ toolName: string; claims: string[] }>({
  id: 'convex/namespaced-tool-name-truncated-in-proven-claim',
  detects: (r) => r.claims.some((c) => !c.includes(r.toolName)),
  mutant: () => ({
    toolName: 'github:search',
    claims: ['Called tool "github" with an argument object the target\'s schema rejects'],
  }),
  wasReal:
    'the schema-rejection claim recovered the tool name with key.slice(0, key.indexOf(":")), truncating a namespaced tool to its first segment.',
})

/**
 * An `indeterminate` emitted where a PROOF was available.
 *
 * The subject records what the engine knew and what it decided. The defect is
 * present when the target's capability set was readable AND EMPTY, an event of
 * the relevant type was recorded, and the engine still declined to prove —
 * because with an empty enumerated set the identity of the thing used is
 * irrelevant: nothing whatsoever is a member of the empty set.
 */
const gaveUpWithProofAvailable = probe<{
  targetSetReadable: boolean
  targetSetSize: number
  recordedEventOfKind: boolean
  provenKeys: string[]
}>

const PROBE_UNNAMED_TOOL_EMPTY_SET = gaveUpWithProofAvailable({
  id: 'engine/unnamed-tool-call-vs-empty-target-toolset',
  detects: (r) =>
    r.targetSetReadable && r.targetSetSize === 0 && r.recordedEventOfKind && r.provenKeys.length === 0,
  mutant: () => ({
    targetSetReadable: true,
    targetSetSize: 0,
    recordedEventOfKind: true,
    provenKeys: [],
  }),
  wasReal:
    'an externalized (or name-less) tool.call against a target declaring `tools: []` yielded `indeterminate` (evidence_externalized:tools) instead of a proven tool_removed, although no tool name is a member of the empty set.',
})

const PROBE_UNREADABLE_MODEL_EMPTY_SET = gaveUpWithProofAvailable({
  id: 'engine/unreadable-model-vs-empty-target-modelset',
  detects: (r) =>
    r.targetSetReadable && r.targetSetSize === 0 && r.recordedEventOfKind && r.provenKeys.length === 0,
  mutant: () => ({
    targetSetReadable: true,
    targetSetSize: 0,
    recordedEventOfKind: true,
    provenKeys: [],
  }),
  wasReal:
    'an externalized llm.request against a target declaring `models: []` yielded `indeterminate` instead of a proven model_removed, on the same reasoning.',
})

const PROBE_STOPGAP_LOAD_BEARING = probe<{ uncoveredKinds: string[] }>({
  id: 'stopgap/route-layer-still-load-bearing',
  detects: (r) => r.uncoveredKinds.length > 0,
  mutant: () => ({ uncoveredKinds: ['run', 'fleet', 'config'] }),
  wasReal:
    "convex/read_api.ts DIVERGENCE_IDENTITY_FIELDS force-includes identifiers only, so the apps/web route stopgap is the only layer holding the completeness invariant. Deleting it reopens ?fields=verdict on all three routes.",
})

const PROBE_CONTRACTS_EMPTY_WINDOW = probe<{
  serverSays: boolean
  contractSays: boolean
}>({
  id: 'contracts/is-fleet-scan-complete-vacuous-on-empty-window',
  detects: (r) => r.serverSays !== r.contractSays,
  mutant: () => ({ serverSays: false, contractSays: true }),
  wasReal:
    "contracts' isFleetScanComplete has no `runsAnalyzed > 0` clause, so an empty window is vacuously complete and a client re-deriving the verdict computes `compatible` where the server returns `indeterminate`.",
})

const PROBE_MAXTOKENS_ALIAS = probe<{
  resolved: number | null
  budgetFindings: number
}>({
  id: 'convex/max-tokens-alias-last-write-wins',
  detects: (r) => r.resolved === 100 && r.budgetFindings > 0,
  mutant: () => ({ resolved: 100, budgetFindings: 1 }),
  wasReal:
    'PARAM_ALIAS collapsed four spellings onto max_tokens assigned in list order, so {max_tokens:4000, max_output_tokens:100} silently resolved to 100 and a 500-token generation became a PROVEN budget_exceeded.',
})

/**
 * Every defect this suite currently observes, each produced by a live probe
 * below. Deleting a fixed entry is the ONLY sanctioned way to make the ledger
 * test pass again.
 */
/**
 * Every defect this suite currently observes.
 *
 * CURRENTLY EMPTY. Seven entries were retired in one pass after Teams A and C
 * shipped fixes. An empty ledger is the single most suspicious state this file
 * can be in, so retirement required BOTH of:
 *
 *   1. each defect verified gone by a probe run OUTSIDE this suite, against the
 *      engine directly, plus a sanity check that the engine still proves the
 *      baseline `tool_removed` (an inert engine also observes nothing); and
 *   2. `ledger/probe-liveness` below, which proves on EVERY run that each
 *      predicate still fires against the shape the defect actually had.
 *
 * Condition 2 is permanent. Without it this list could only ever go green.
 */
const KNOWN_DEFECTS: readonly string[] = []

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_WINDOW = { runsScanned: 0, scanTruncated: false } as const

/**
 * A config that declares EVERY dimension the engine assesses, so `compatible`
 * is genuinely reachable against it. Probes about truncation and emptiness need
 * this: against a partial config the verdict is already `indeterminate` for an
 * unrelated reason and the probe would be measuring nothing.
 */
const CFG_ALL_DIMENSIONS = {
  tools: ['a'],
  models: ['m'],
  systemPrompt: 'p',
  temperature: 1,
  max_tokens: 100_000,
  maxToolCalls: 100_000,
  capabilities: [],
} as const

/**
 * A `tool.call` whose payload was externalized past the 10 KB ceiling
 * (Event Log Rule 3). The EVENT's `type` stays `tool.call`; the payload becomes
 * an artifact pointer and THE TOOL NAME IS GONE. Shape mirrors
 * `ExternalizedPayload` in packages/contracts/src/events.ts exactly.
 */
function cxToolCall(seq: number, name: string, input?: unknown): CxObservableEvent {
  return {
    type: 'tool.call',
    sequenceNumber: seq,
    _id: `ev_${seq}`,
    payload: { type: 'tool.call', name, input: input ?? {}, call_id: `c${seq}` },
  }
}

function cxLlmResponse(seq: number, completionTokens: number, model = 'm'): CxObservableEvent {
  return {
    type: 'llm.response',
    sequenceNumber: seq,
    _id: `ev_${seq}`,
    payload: { type: 'llm.response', model, usage: { completion_tokens: completionTokens } },
  }
}

function cxLlmRequest(seq: number, model: string): CxObservableEvent {
  return {
    type: 'llm.request',
    sequenceNumber: seq,
    _id: `ev_${seq}`,
    payload: { type: 'llm.request', model, messages: [] },
  }
}

const EXTERNALIZED_TOOL_CALL_PAYLOAD = {
  type: '_externalized',
  originalType: 'tool.call',
  _artifact: {
    artifactId: 'art_1',
    storageKey: 'k/1',
    storageBucket: 'b',
    checksum: `sha256:${'a'.repeat(64)}`,
    size: 20_480,
  },
} as const

// ===========================================================================
// GROUP 1 — THE PROVABLE / SPECULATIVE LINE (web engine — the one the UI uses)
// ===========================================================================

describe('divergence/config-reader (convex engine)', () => {
  it('never throws on hostile or legacy snapshots', () => {
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      'legacy',
      [],
      [1, 2],
      {},
      { tools: null },
      { tools: 0 },
      { tools: [1, 'a'] },
      { tools: { a: 1 } },
      JSON.parse('{"__proto__":{"polluted":true}}'),
      JSON.parse('{"tools":{"__proto__":{"x":1}}}'),
      { tools: { a: { parameters: { properties: null } } } },
      { model: {} },
      { model: { name: '' } },
      { systemPrompt: [{ content: 1 }] },
      { temperature: 'hot' },
      { temperature: Number.NaN },
      { config: { tools: ['a'] } },
    ]
    for (const snapshot of hostile) {
      expect(() => cx.readConfigSnapshot(snapshot)).not.toThrow()
      expect(() => cx.analyzeConfigPair(snapshot, snapshot)).not.toThrow()
      expect(() => cx.analyzeRunDivergence(snapshot, snapshot, [cxToolCall(1, 'x')])).not.toThrow()
    }
    // Prototype pollution must not have escaped into Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(hostile.length).toBeGreaterThan(15)
  })

  it('an ABSENT tool list and an EMPTY tool list are different answers', () => {
    expect(cx.readConfigSnapshot({ model: 'm' }).tools.status).toBe('absent')
    const empty = cx.readConfigSnapshot({ tools: [] })
    expect(empty.tools.status).toBe('read')
    expect(empty.tools.value).toEqual([])

    // Absent on the target => NO tool proof of any kind is permitted.
    expect(cx.analyzeConfigPair({ tools: ['a'] }, { model: 'm' }).targetToolsByName).toBeNull()
    const absentRun = cx.analyzeRunDivergence({ tools: ['a'] }, { model: 'm' }, [cxToolCall(1, 'a')])
    expect(absentRun.proven).toEqual([])
    expect(absentRun.coverage.unassessed.some((u) => u.dimension === 'tools')).toBe(true)
    expect(absentRun.verdict).not.toBe('compatible')

    // Explicitly empty => the claim IS permitted, and is proven.
    const emptyRun = cx.analyzeRunDivergence({ tools: ['a'] }, { tools: [] }, [cxToolCall(1, 'a')])
    expect(emptyRun.proven.map((p) => p.reasonKey)).toContain('tool_removed:a')
    expect(emptyRun.verdict).toBe('incompatible')
  })

  it('a partially-unparseable tool array refuses the whole dimension', () => {
    // Refusing is correct: a parsed SUBSET would make `tool_removed` unsound.
    expect(cx.readConfigSnapshot({ tools: ['search', 42] }).tools.status).toBe('malformed')
    expect(cx.analyzeConfigPair({ tools: ['search'] }, { tools: ['search', 42] }).targetToolsByName).toBeNull()
  })

  it('a required parameter absent from `properties` is still required', () => {
    // JSON Schema permits a name in `required` with no `properties` entry.
    // Reading only `properties` would drop exactly the constraint most likely to
    // break a recorded call — a FALSE CLEAN.
    const target = { tools: [{ name: 'foo', parameters: { properties: {}, required: ['newArg'] } }] }
    const r = cx.analyzeRunDivergence(
      { tools: [{ name: 'foo', parameters: { properties: {}, required: [] } }] },
      target,
      [cxToolCall(1, 'foo', { other: 1 })],
    )
    expect(r.proven.map((p) => p.reasonKey)).toContain('tool_call_rejected_by_schema:foo:missing:newArg')
  })

  /**
   * DEFECT PROBE — `convex/tool-map-string-value-misparsed-as-tool-name`.
   *
   * `readTools`'s map branch calls `parseToolEntry(def, name)`. `parseToolEntry`
   * short-circuits on `typeof entry === "string"` and returns the VALUE as the
   * tool name, discarding the map KEY it was handed as `fallbackName`. A
   * name->description map therefore declares tools named after their descriptions.
   *
   * A run that called `search` against a target declaring
   * `{ search: "Search the web" }` then yields a PROVEN `tool_removed:search`
   * and verdict `incompatible` — a deploy-blocking certainty about a tool the
   * target plainly declares.
   */
  it('a name->description tool map must declare the KEYS as tool names', () => {
    const target = { tools: { search: 'Search the web', send_email: 'Send an email' } }
    const declared = (cx.readConfigSnapshot(target).tools.value ?? []).map((t) => t.name).sort()
    const run = cx.analyzeRunDivergence({ tools: ['search'] }, target, [cxToolCall(1, 'search')])

    const subject = { declaredNames: declared, provenKeys: run.proven.map((p) => p.reasonKey) }
    if (PROBE_TOOL_MAP_STRING.detects(subject)) {
      defect(PROBE_TOOL_MAP_STRING.id, {
        targetConfig: target,
        declaredAs: declared,
        verdict: run.verdict,
        provenClaim: run.proven.find((p) => p.reasonKey === 'tool_removed:search')?.provenClaim,
      })
    }
    // FIXTURE AUDIT: the map must really be name->STRING (the object-valued form
    // parses correctly and would prove nothing).
    expect(Object.values(target.tools).every((v) => typeof v === 'string')).toBe(true)
    // CONTROL: the object-valued form of the SAME map does read correctly, so the
    // map branch is not simply unsupported.
    expect(
      (cx.readConfigSnapshot({ tools: { search: { description: 'Search the web' } } }).tools.value ?? []).map(
        (t) => t.name,
      ),
    ).toEqual(['search'])
  })

  /**
   * DEFECT PROBE — `convex/namespaced-tool-name-truncated-in-proven-claim`.
   *
   * Schema-rejection findings are keyed `${call.name}:${violation}` and the
   * operator sentence recovers the tool name with
   * `key.slice(0, key.indexOf(":"))`. A namespaced tool — `github:search`, the
   * shape this repo's own MCP package produces — is truncated to `github`, so a
   * PROVEN claim names a tool that does not exist.
   *
   * The reasonKey itself is unaffected, so fleet grouping stays correct; the
   * damage is confined to the sentence an operator reads to decide a deploy.
   */
  it('a namespaced tool name survives into the proven claim intact', () => {
    const name = 'github:search'
    const run = cx.analyzeRunDivergence(
      { tools: [{ name, parameters: { properties: { q: {} }, required: [] } }] },
      { tools: [{ name, parameters: { properties: { q: {} }, required: ['q', 'lang'] } }] },
      [cxToolCall(1, name, { q: 'x' })],
    )
    const rejected = run.proven.filter((p) => p.kind === 'tool_call_rejected_by_schema')
    expect(rejected.length).toBeGreaterThan(0)
    const claimSubject = { toolName: name, claims: rejected.map((p) => p.provenClaim) }
    if (PROBE_NAMESPACED_CLAIM.detects(claimSubject)) {
      for (const p of rejected.filter((r) => !r.provenClaim.includes(name))) {
        defect(PROBE_NAMESPACED_CLAIM.id, {
          toolName: name,
          reasonKey: p.reasonKey,
          provenClaim: p.provenClaim,
          note: 'reasonKey is correct; the operator-facing sentence names a different tool',
        })
      }
    }
    // FIXTURE AUDIT: the name must genuinely contain the separator the recovery
    // splits on, and must not be recoverable by accident.
    expect(name).toContain(':')
    expect(name.slice(0, name.indexOf(':'))).not.toBe(name)
  })

  /**
   * DEFECT PROBE — `convex/max-tokens-alias-last-write-wins`.
   *
   * `PARAM_ALIAS` collapses `max_tokens`, `maxTokens`, `max_output_tokens` and
   * `maxOutputTokens` onto one canonical name, assigned in list order, so the
   * LAST alias present silently wins. `targetBudgets.max_tokens` feeds the
   * `budget_exceeded` finding — kind `proven`, verdict `incompatible` — so a
   * deploy-gating certainty rests on an arbitrary alias tie-break.
   */
  it('a config declaring two max-token aliases must not silently pick one', () => {
    const target = { max_tokens: 4000, max_output_tokens: 100, temperature: 1 }
    const delta = cx.analyzeConfigPair({ temperature: 1 }, target)
    const resolved = delta.targetBudgets?.max_tokens ?? null
    const run = cx.analyzeRunDivergence({ temperature: 1 }, target, [
      {
        type: 'llm.response',
        sequenceNumber: 1,
        _id: 'ev_1',
        payload: { type: 'llm.response', model: 'm', usage: { completion_tokens: 500 } },
      },
    ])
    const budget = run.proven.filter((p) => p.kind === 'budget_exceeded')
    // 500 tokens is UNDER 4000 and OVER 100: the two declared aliases disagree
    // about whether this recorded generation was even possible.
    if (PROBE_MAXTOKENS_ALIAS.detects({ resolved, budgetFindings: budget.length })) {
      defect(PROBE_MAXTOKENS_ALIAS.id, {
        target,
        resolvedMaxTokens: resolved,
        recordedCompletionTokens: 500,
        verdict: run.verdict,
        note: 'the other declared alias (4000) makes this recorded generation possible',
      })
    }
    // FIXTURE AUDIT: the recorded value must straddle BOTH aliases, else the two
    // resolutions would agree and the probe would prove nothing.
    expect(500).toBeGreaterThan(target.max_output_tokens)
    expect(500).toBeLessThan(target.max_tokens)
  })

  it('every proven finding carries at least one proof citing a real recorded event', () => {
    const cases: Array<[unknown, unknown, CxObservableEvent[]]> = [
      [{ tools: ['a'] }, { tools: [] }, [cxToolCall(1, 'a')]],
      [{ tools: ['a'] }, { tools: ['b'] }, [cxToolCall(3, 'a')]],
      [
        { tools: [{ name: 'a', parameters: { properties: { x: {} }, required: [] } }] },
        { tools: [{ name: 'a', parameters: { properties: { x: {} }, required: ['x'] } }] },
        [cxToolCall(5, 'a', { y: 1 })],
      ],
      [{ models: ['m1'] }, { models: ['m2'] }, [
        { type: 'llm.request', sequenceNumber: 7, _id: 'ev_7', payload: { type: 'llm.request', model: 'm1' } },
      ]],
      [{ max_tokens: 5000 }, { max_tokens: 10 }, [
        { type: 'llm.response', sequenceNumber: 9, _id: 'ev_9', payload: { type: 'llm.response', usage: { completion_tokens: 99 } } },
      ]],
    ]
    let provenSeen = 0
    for (const [src, tgt, events] of cases) {
      const run = cx.analyzeRunDivergence(src, tgt, events)
      const seqs = new Set(events.map((e) => e.sequenceNumber))
      for (const p of run.proven) {
        provenSeen += 1
        // A proof with nothing behind it is a speculative claim wearing a
        // proven label. This is enforced by a non-empty tuple in the type; here
        // it is enforced against the VALUE.
        expect(p.provenBy.length).toBeGreaterThan(0)
        for (const proof of p.provenBy) {
          expect(seqs.has(proof.citedEvent.sequenceNumber)).toBe(true)
        }
        // Proven claims speak in the past tense about what was recorded; they
        // must never hedge, or the certainty grade is decorative.
        expect(p.provenClaim).not.toMatch(/\bmay\b|\bmight\b|\bprobably\b|\bcould differ\b/i)
      }
      for (const s of run.speculative) {
        // Speculative findings must state WHY they cannot be proven, and must
        // carry no field a renderer could mistake for proof.
        expect(s.speculativeBecause.length).toBeGreaterThan(0)
        expect(s).not.toHaveProperty('provenBy')
      }
    }
    // ANTI-VACUITY: the sweep must actually have produced proven findings.
    expect(provenSeen).toBeGreaterThanOrEqual(cases.length)
  })

  it('an externalized tool.call blocks a clean verdict and is named as a gap', () => {
    const run = cx.analyzeRunDivergence({ tools: ['a'] }, { tools: ['a'] }, [
      { type: 'tool.call', sequenceNumber: 1, payload: EXTERNALIZED_TOOL_CALL_PAYLOAD },
    ])
    // The convex engine gets this RIGHT — asserted directly, as the reference
    // the web engine's ledgered defect is measured against.
    expect(run.coverage.eventHistoryComplete).toBe(false)
    expect(cx.isDivergenceCoverageComplete(run.coverage)).toBe(false)
    expect(run.verdict).not.toBe('compatible')
    expect(run.verdict).not.toBe('compatible_with_caveats')
  })

  it('a truncated scan is never clean, but DOES preserve a proven break', () => {
    const cfg = { tools: ['a'], model: 'm', systemPrompt: 'p', temperature: 1 }
    // Nothing found, but we did not look at everything -> never affirmative.
    const partial = cx.analyzeRunDivergence(cfg, cfg, [cxToolCall(1, 'a')], { scanTruncated: true })
    expect(partial.coverage.eventHistoryComplete).toBe(false)
    expect(partial.verdict).toBe('indeterminate')

    // A proof is MONOTONE in evidence: truncation must not soften it. This is
    // the verdict-precedence rule, exercised rather than trusted.
    const broken = cx.analyzeRunDivergence(cfg, cfg, [cxToolCall(1, 'gone')], { scanTruncated: true })
    expect(broken.verdict).toBe('incompatible')
    expect(cx.computeDivergenceVerdict({ provenCount: 1, speculativeCount: 0, complete: false })).toBe(
      'incompatible',
    )
  })
})

// ===========================================================================
// GROUP 4 — FLEET AGGREGATION: DOES "DISTINCT REASON" ACTUALLY GROUP?
// Two failure directions, both of which make the number an operator acts on
// wrong: distinct causes COLLAPSING, and one cause FRAGMENTING.
// ===========================================================================

describe('divergence/fleet-grouping (convex engine)', () => {
  const SRC = { tools: ['alpha', 'beta'], model: 'm', systemPrompt: 'p', temperature: 1 }
  const TGT = { tools: [], model: 'm', systemPrompt: 'p', temperature: 1 }

  it('two genuinely different removed tools never collapse into one reason', () => {
    const fleet = cx.foldFleetDivergence(
      [
        { runId: 'r1', analysis: cx.analyzeRunDivergence(SRC, TGT, [cxToolCall(1, 'alpha')]) },
        { runId: 'r2', analysis: cx.analyzeRunDivergence(SRC, TGT, [cxToolCall(1, 'beta')]) },
      ],
      { runsScanned: 2, scanTruncated: false },
    )
    expect(fleet.provenReasons.map((r) => r.reasonKey).sort()).toEqual([
      'tool_removed:alpha',
      'tool_removed:beta',
    ])
  })

  it('one cause across many runs collapses to exactly one reason', () => {
    const analyses = Array.from({ length: 12 }, (_, i) => ({
      runId: `r${i}`,
      // Different sequence numbers AND different call counts per run: the key
      // must absorb neither.
      analysis: cx.analyzeRunDivergence(
        SRC,
        TGT,
        Array.from({ length: i + 1 }, (_, k) => cxToolCall(k * 7 + i + 1, 'alpha')),
      ),
    }))
    const fleet = cx.foldFleetDivergence(analyses, { runsScanned: 12, scanTruncated: false })
    expect(fleet.provenReasons).toHaveLength(1)
    expect(fleet.provenReasons[0]!.reasonKey).toBe('tool_removed:alpha')
    expect(fleet.provenReasons[0]!.affectedRunCount).toBe(12)
    expect(fleet.runsWithProvenDivergence).toBe(12)
    // FIXTURE AUDIT: the runs must genuinely differ, else "absorbs neither" is
    // untested.
    expect(new Set(analyses.map((a) => a.analysis.proven[0]!.provenBy.length)).size).toBeGreaterThan(1)
  })

  it('ONE tool-schema change is ONE reason per constraint, not one per argument shape', () => {
    // The failure this guards: keying on the SET of args a run happened to omit
    // fragments a single edit into up to 2^n "root causes", inflating exactly
    // the number an operator acts on.
    const src = {
      tools: [{ name: 'foo', parameters: { properties: { a: {}, b: {}, c: {} }, required: [] } }],
      model: 'm',
      systemPrompt: 'p',
      temperature: 1,
    }
    const tgt = {
      tools: [{ name: 'foo', parameters: { properties: { a: {}, b: {}, c: {} }, required: ['a', 'b', 'c'] } }],
      model: 'm',
      systemPrompt: 'p',
      temperature: 1,
    }
    const argShapes = [{ a: 1, b: 1 }, { a: 1 }, {}, { b: 1 }, { a: 1, c: 1 }]
    const fleet = cx.foldFleetDivergence(
      argShapes.map((args, i) => ({
        runId: `r${i}`,
        analysis: cx.analyzeRunDivergence(src, tgt, [cxToolCall(1, 'foo', args)]),
      })),
      { runsScanned: argShapes.length, scanTruncated: false },
    )
    const keys = fleet.provenReasons.map((r) => r.reasonKey).sort()
    // Exactly three: one per newly-required parameter. Bounded by the EDIT, not
    // by the number of distinct argument shapes in the fleet.
    expect(keys).toEqual([
      'tool_call_rejected_by_schema:foo:missing:a',
      'tool_call_rejected_by_schema:foo:missing:b',
      'tool_call_rejected_by_schema:foo:missing:c',
    ])
    // FIXTURE AUDIT: the five runs must have five genuinely DIFFERENT argument
    // shapes, or fragmentation is not what is being measured.
    expect(new Set(argShapes.map((a) => Object.keys(a).sort().join(','))).size).toBe(5)
  })

  it('reason keys stay injective under adversarial tool names', () => {
    const nasty = [
      'a',
      'a:b',
      'tool_removed:a',
      'a|b',
      'a->b',
      'a+b',
      'A',
      'а', // Cyrillic а
      'a b',
      'x'.repeat(300),
      `${'x'.repeat(300)}y`,
      // NOTE: ' a' / 'a ' are deliberately absent. Both engines trim tool names
      // on the declaring AND the observing side, so whitespace variants are the
      // SAME tool by design. Including them made this probe fail on correct
      // behaviour on its first run; the pin below records that decision.
    ]
    const seen = new Map<string, string>()
    for (const name of nasty) {
      const run = cx.analyzeRunDivergence(
        { tools: [name], model: 'm', systemPrompt: 'p', temperature: 1 },
        { tools: [], model: 'm', systemPrompt: 'p', temperature: 1 },
        [cxToolCall(1, name)],
      )
      const key = run.proven.find((p) => p.kind === 'tool_removed')?.reasonKey
      expect(key, `no tool_removed reason for ${JSON.stringify(name)}`).toBeDefined()
      // A collision merges two genuinely different root causes into one bucket
      // an operator acts on as if it were one fix.
      expect(
        seen.get(key!),
        `key collision between ${JSON.stringify(seen.get(key!))} and ${JSON.stringify(name)}`,
      ).toBeUndefined()
      seen.set(key!, name)
    }
    // FIXTURE AUDIT: two fixtures must differ ONLY past character 200, which is
    // what makes a truncating key (failure_patterns.ts truncates labels at 200)
    // fail this probe rather than pass it vacuously.
    const long = nasty.filter((n) => n.length >= 300)
    expect(long).toHaveLength(2)
    expect(long[0]).not.toBe(long[1])
    expect(long[0]!.slice(0, 200)).toBe(long[1]!.slice(0, 200))
    // FIXTURE AUDIT: two fixtures must differ only by CASE, which is what makes
    // a case-folding key fail rather than pass.
    expect(nasty).toContain('a')
    expect(nasty).toContain('A')
  })

  it('whitespace-only differences in a tool name are the SAME tool, on both sides', () => {
    // Pinning the normalisation the injectivity probe exempts, so it stays a
    // deliberate decision rather than an untested accident.
    const run = cx.analyzeRunDivergence(
      { tools: [' search '], model: 'm', systemPrompt: 'p', temperature: 1 },
      { tools: [], model: 'm', systemPrompt: 'p', temperature: 1 },
      [cxToolCall(1, 'search')],
    )
    expect(run.proven.map((p) => p.reasonKey)).toContain('tool_removed:search')
  })

  it('a proven reason and a speculative reason never share a bucket', () => {
    const fleet = cx.foldFleetDivergence(
      [
        {
          runId: 'r1',
          analysis: cx.analyzeRunDivergence(
            { tools: ['alpha'], systemPrompt: 'a' },
            { tools: [], systemPrompt: 'b' },
            [cxToolCall(1, 'alpha')],
          ),
        },
      ],
      { runsScanned: 1, scanTruncated: false },
    )
    const provenKeys = new Set(fleet.provenReasons.map((r) => r.reasonKey))
    for (const s of fleet.speculativeReasons) expect(provenKeys.has(s.reasonKey)).toBe(false)
    expect(fleet.provenReasons.length).toBeGreaterThan(0)
    expect(fleet.speculativeReasons.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// GROUP 5 — SCALE HONESTY
// A capped scan reported as a complete answer is the worst outcome here.
// ===========================================================================

describe('divergence/scale-honesty', () => {
  const CFG = { tools: ['a'], model: 'm', systemPrompt: 'p', temperature: 1 }

  it('a truncated fleet scan can never return an affirmative verdict', () => {
    const fleet = cx.foldFleetDivergence(
      [{ runId: 'r1', analysis: cx.analyzeRunDivergence(CFG, CFG, [cxToolCall(1, 'a')]) }],
      { runsScanned: 10_000, scanTruncated: true },
    )
    expect(cx.isFleetScanComplete(fleet.window)).toBe(false)
    expect(fleet.verdict).toBe('indeterminate')
    // The window must expose the gap between what was SCANNED and what was
    // ANALYZED, or "1 of 10,000" is unrecoverable from the answer.
    expect(fleet.window.runsScanned).toBe(10_000)
    expect(fleet.window.runsAnalyzed).toBe(1)
  })

  it('a run whose coverage assessed NOTHING is counted unassessable, not clean', () => {
    // Both snapshots absent: nothing could be compared. Counting this run as
    // clean is the silent-empty-as-success failure at the run level.
    const blind = cx.analyzeRunDivergence(undefined, undefined, [cxToolCall(1, 'a')])
    expect(blind.coverage.assessed).toEqual([])
    const fleet = cx.foldFleetDivergence([{ runId: 'r1', analysis: blind }], {
      runsScanned: 1,
      scanTruncated: false,
    })
    expect(fleet.window.runsUnassessable).toBe(1)
    expect(cx.isFleetScanComplete(fleet.window)).toBe(false)
    expect(fleet.verdict).toBe('indeterminate')
  })

  /**
   * DEFECT PROBE — `convex/fleet-fold-ignores-per-run-history-truncation`.
   *
   * THE SHARPEST FINDING IN THIS FILE.
   *
   * Each run's analysis carries `coverage.eventHistoryComplete`, and a run whose
   * event scan was capped correctly reports `indeterminate`. `foldFleetDivergence`
   * then reads only `analysis.proven.length` and `analysis.coverage.assessed.length`
   * — it never consults `eventHistoryComplete`. `isFleetScanComplete` sees only
   * the WINDOW's `scanTruncated`, which describes the RUN population, not the
   * per-run event reads.
   *
   * So 25 runs that each say "I did not read all of my history" fold into a fleet
   * verdict of `compatible` — the affirmative, deploy-authorising grade.
   *
   * THIS IS THE NORMAL CASE, NOT AN EDGE CASE. `convex/divergence.ts` TIER 3
   * reads at most `DIVERGENCE_FLEET_EVENTS_PER_RUN` (200) events per run with a
   * `.take()`, so every run longer than 200 observable events is truncated by
   * construction on the fleet path. The per-run honesty the engine works hard to
   * produce is discarded at exactly the aggregation step that authorises the deploy.
   *
   * `adaptFleetReport` does not recover it either: it folds `nextCursor` and
   * `runsSkippedForBudget` into the window, but not per-run history completeness.
   */
  it('per-run event truncation must poison the fleet verdict', () => {
    const runs = Array.from({ length: 25 }, (_, i) => ({
      runId: `r${i}`,
      analysis: cx.analyzeRunDivergence(CFG_ALL_DIMENSIONS, CFG_ALL_DIMENSIONS, [cxToolCall(1, 'a')], {
        scanTruncated: true,
      }),
    }))
    const fleet = cx.foldFleetDivergence(runs, { runsScanned: 25, scanTruncated: false })
    const adapted = adapt.adaptFleetReport({
      agentId: 'a1',
      targetVersionId: 'v2',
      analyzedAt: 0,
      ...fleet,
      nextCursor: null,
      runsSkippedForBudget: 0,
    })

    if (
      PROBE_FLEET_TRUNCATION.detects({
        fleetVerdict: fleet.verdict,
        adaptedVerdict: adapted.verdict,
      })
    ) {
      defect(PROBE_FLEET_TRUNCATION.id, {
        perRunVerdict: runs[0]!.analysis.verdict,
        perRunEventHistoryComplete: runs[0]!.analysis.coverage.eventHistoryComplete,
        fleetVerdict: fleet.verdict,
        adaptedVerdict: adapted.verdict,
        adaptedIndeterminateReasons: adapted.indeterminateReasons.length,
        window: fleet.window,
        note: 'every analysed run reported an incomplete history; foldFleetDivergence never reads coverage.eventHistoryComplete, so the fold is affirmative. adaptedVerdict shows whether the web adapter independently recovers.',
      })
    }

    // FIXTURE AUDIT: every input run must genuinely be truncated AND must
    // genuinely have reported that fact, or this probe measures nothing.
    expect(runs.every((r) => r.analysis.coverage.eventHistoryComplete === false)).toBe(true)
    expect(runs.every((r) => r.analysis.verdict === 'indeterminate')).toBe(true)
    // FIXTURE AUDIT: the config must exercise EVERY dimension, so `compatible`
    // is genuinely reachable here and the probe is not simply observing that an
    // unassessed dimension already blocked it.
    const solo = cx.analyzeRunDivergence(CFG_ALL_DIMENSIONS, CFG_ALL_DIMENSIONS, [cxToolCall(1, 'a')])
    expect(solo.coverage.unassessed).toEqual([])
    expect(solo.verdict).toBe('compatible')
  })

  /**
   * DEFECT PROBE — `convex/empty-fleet-fold-returns-compatible`.
   *
   * `foldFleetDivergence([], {runsScanned: 0, scanTruncated: false})` yields
   * `verdict: "compatible"` — the affirmative, deploy-authorising grade —
   * derived from ZERO analysed runs.
   *
   * `computeDivergenceVerdict` reaches it honestly (`provenCount: 0`,
   * `speculativeCount: 0`, `complete: true`), because an empty window IS
   * vacuously complete: nothing was truncated and nothing was unassessable. The
   * gap is that "we analysed everything and found nothing" and "there was
   * nothing to analyse" are the same value. A fleet query for an agent whose
   * runs have all aged out of the retention window returns a green light.
   *
   * `runsAnalyzed: 0` is present in the window and recoverable — the defect is
   * that the VERDICT, which is what a deploy gate keys off, does not consult it.
   */
  it('a fold over zero runs must not return an affirmative verdict', () => {
    const fleet = cx.foldFleetDivergence([], EMPTY_WINDOW)
    if (PROBE_EMPTY_FOLD.detects(fleet)) {
      defect(PROBE_EMPTY_FOLD.id, {
        verdict: fleet.verdict,
        window: fleet.window,
        note: 'affirmative verdict from zero analysed runs; reachable when every run has aged out of retention',
      })
    }
    // FIXTURE AUDIT: the window must be genuinely empty and genuinely untruncated,
    // so this is the vacuous case and not a mis-declared one.
    expect(fleet.window.runsAnalyzed).toBe(0)
    expect(fleet.window.scanTruncated).toBe(false)
    expect(fleet.window.runsUnassessable).toBe(0)
    // CONTROL: the verdict rule itself is not at fault — given a truthful
    // `complete: false` it does the right thing. The gap is that nothing marks
    // an empty population incomplete.
    expect(cx.computeDivergenceVerdict({ provenCount: 0, speculativeCount: 0, complete: false })).toBe(
      'indeterminate',
    )
  })

  /**
   * DEFECT PROBE — `convex/empty-fleet-merge-returns-compatible`.
   *
   * Same shape one layer up. `mergeFleetAnalyses([])` — the function
   * `convex/divergence.ts` tells callers to use when paging a large population —
   * returns `compatible` from no pages at all. A caller that merges before any
   * page has arrived, or whose paging loop errored out before the first fetch,
   * gets a green light rather than "no data".
   */
  it('a merge over zero pages must not return an affirmative verdict', () => {
    const merged = cx.mergeFleetAnalyses([])
    if (PROBE_EMPTY_MERGE.detects(merged)) {
      defect(PROBE_EMPTY_MERGE.id, {
        verdict: merged.verdict,
        window: merged.window,
      })
    }
    expect(merged.provenReasons).toEqual([])
    // FIXTURE AUDIT: zero pages, not one empty page.
    expect(merged.window.runsScanned).toBe(0)
  })

  it('merging pages sums run counts and ORs truncation', () => {
    const src = { tools: ['a'], model: 'm', systemPrompt: 'p', temperature: 1 }
    const tgt = { tools: [], model: 'm', systemPrompt: 'p', temperature: 1 }
    const page = (ids: string[], truncated: boolean): CxFleetAnalysis =>
      cx.foldFleetDivergence(
        ids.map((runId) => ({ runId, analysis: cx.analyzeRunDivergence(src, tgt, [cxToolCall(1, 'a')]) })),
        { runsScanned: ids.length, scanTruncated: truncated },
      )
    const merged = cx.mergeFleetAnalyses([page(['r1', 'r2'], false), page(['r3'], true)])
    const reason = merged.provenReasons.find((r) => r.reasonKey === 'tool_removed:a')!
    expect(reason.affectedRunCount).toBe(3)
    expect(merged.window.runsAnalyzed).toBe(3)
    // One truncated page must poison the whole merged answer.
    expect(merged.window.scanTruncated).toBe(true)
    expect(cx.isFleetScanComplete(merged.window)).toBe(false)
    expect(reason.representativeRunIds.length).toBeLessThanOrEqual(cx.MAX_DIVERGENCE_REPRESENTATIVE_RUNS)
  })

  it('a run larger than one shipped event page cannot be answered in one call', () => {
    // Binds the paging story to the constant that actually decides it. TIER 2
    // spends the single permitted .paginate() on ONE run's events, so a run
    // beyond this size is necessarily reported across several executions.
    expect(SHIPPED_EVENT_PAGE_SIZE).toBeGreaterThan(0)
    const oversized = Array.from({ length: SHIPPED_EVENT_PAGE_SIZE + 1 }, (_, i) =>
      cxToolCall(i + 1, 'a'),
    )
    const firstPage = cx.analyzeRunDivergence(CFG, CFG, oversized.slice(0, SHIPPED_EVENT_PAGE_SIZE), {
      scanTruncated: true,
    })
    expect(firstPage.coverage.eventHistoryComplete).toBe(false)
    expect(firstPage.verdict).toBe('indeterminate')
    expect(oversized.length).toBeGreaterThan(SHIPPED_EVENT_PAGE_SIZE)
  })

})

/**
 * DEFECT PROBE — `web/adapt-empty-fleet-renders-compatible`.
 *
 * The same vacuity as the fold, at the surface the operator actually reads.
 * `adaptFleetReport` over an empty batch returns `verdict: "compatible"` with
 * ZERO indeterminate reasons — a green light rendered from no data. Reachable
 * whenever the source version has no runs left in the retention window, which
 * is the normal state of an old version under an org's retention policy.
 *
 * NOTE ON STABILITY: this probe's result flipped between two runs earlier in
 * the session. The cause was the engine being rewritten between them, not
 * non-determinism — the source hash was pinned across three consecutive runs
 * and the observation was identical each time. Recorded here because a ledger
 * entry whose provenance is "it flickered once" is worth exactly nothing.
 */
describe('divergence/adapter-honesty', () => {
  it('the adapter must not render an affirmative verdict from an empty population', () => {
    const empty = cx.foldFleetDivergence([], EMPTY_WINDOW)
    const adapted = adapt.adaptFleetReport({
      agentId: 'a1',
      targetVersionId: 'v2',
      analyzedAt: 0,
      ...empty,
      nextCursor: null,
      runsSkippedForBudget: 0,
    })
    if (PROBE_ADAPT_EMPTY.detects(adapted)) {
      defect(PROBE_ADAPT_EMPTY.id, {
        verdict: adapted.verdict,
        runsAnalyzed: adapted.window.runsAnalyzed,
        indeterminateReasons: adapted.indeterminateReasons.length,
      })
    }
    expect(adapted.window.runsAnalyzed).toBe(0)
  })

  it('the adapter never rounds completeness UP', () => {
    // An adapter that widened a claim would undo every honesty property the
    // engine establishes, so this is checked in the dangerous direction only.
    const complete = { assessed: ['tools'], unassessed: [], eventsExamined: 10, eventHistoryComplete: true }
    const lifted = adapt.liftUnassessedToIndeterminate(complete as never)
    expect(lifted).toEqual([])
    // Engine says complete, but a cursor remains: the STRICTER answer must win.
    const run = adapt.adaptRunReport({
      runId: 'r1',
      baselineVersionId: 'v1',
      targetVersionId: 'v2',
      analyzedAt: 0,
      proven: [],
      speculative: [],
      coverage: complete,
      nextEventCursor: 'more',
    })
    expect(run.coverage.eventHistoryComplete).toBe(false)
    expect(run.verdict).not.toBe('compatible')
    expect(run.indeterminate.some((f) => f.kind === 'recorded_history_incomplete')).toBe(true)
  })

  it('every unassessed dimension becomes a visible finding, not an absence', () => {
    const coverage = {
      assessed: ['model'],
      unassessed: [
        { dimension: 'tools', reason: 'target_dimension_absent' },
        { dimension: 'budgets', reason: 'unsupported_config_shape' },
      ],
      eventsExamined: 5,
      eventHistoryComplete: true,
    }
    const lifted = adapt.liftUnassessedToIndeterminate(coverage as never)
    expect(lifted).toHaveLength(2)
    // Distinct dimensions must not collapse onto one reason key.
    expect(new Set(lifted.map((f) => f.reasonKey)).size).toBe(2)
  })
})

// ===========================================================================
// GROUP 6 — MONOTONICITY OF PROOF UNDER INCOMPLETE HISTORY
// A proof valid only on COMPLETE history, emitted on PARTIAL history, is the
// catastrophic direction. The property that makes truncation safe is:
//
//     for every prefix P of a run's events,  proven(P) is a SUBSET of proven(E)
//
// i.e. reading less can never invent a proof. Asserted over generated event
// lists rather than argued per finding kind.
// ===========================================================================

describe('divergence/proof-monotonicity', () => {
  const BASELINE = {
    tools: [
      { name: 'alpha', parameters: { properties: { a: {} }, required: [] } },
      { name: 'beta', parameters: { properties: { a: {} }, required: [] } },
    ],
    models: ['m1', 'm2'],
    systemPrompt: 'p',
    temperature: 1,
    max_tokens: 10_000,
    maxToolCalls: 1_000,
    capabilities: [],
  }
  const TARGET = {
    tools: [{ name: 'alpha', parameters: { properties: { a: {} }, required: ['a'] } }],
    models: ['m1'],
    systemPrompt: 'p',
    temperature: 1,
    max_tokens: 100,
    maxToolCalls: 3,
    capabilities: [],
  }

  /** An event stream that can trip EVERY proven kind the engine emits. */
  const FULL: CxObservableEvent[] = [
    cxToolCall(1, 'alpha', { a: 1 }), // fine
    cxLlmRequest(2, 'm1'), // fine
    cxToolCall(3, 'beta', { a: 1 }), // tool_removed
    cxToolCall(4, 'alpha', { z: 9 }), // rejected_by_schema (missing required `a`)
    cxLlmRequest(5, 'm2'), // model_removed
    cxLlmResponse(6, 5_000), // budget_exceeded: max_tokens
    cxToolCall(7, 'alpha', { a: 1 }),
    cxToolCall(8, 'alpha', { a: 1 }), // budget_exceeded: maxToolCalls (>3)
  ]

  it('reading a PREFIX of a run can never invent a proof the full run lacks', () => {
    const full = new Set(
      cx.analyzeRunDivergence(BASELINE, TARGET, FULL).proven.map((p) => p.reasonKey),
    )
    for (let n = 0; n <= FULL.length; n++) {
      const prefix = FULL.slice(0, n)
      const partial = cx.analyzeRunDivergence(BASELINE, TARGET, prefix, { scanTruncated: n < FULL.length })
      for (const p of partial.proven) {
        // A reason visible only on a SHORTER read is a proof manufactured by
        // not looking — the exact inversion of "absence of evidence".
        expect(
          full.has(p.reasonKey),
          `prefix of length ${n} produced ${p.reasonKey}, absent from the full-history analysis`,
        ).toBe(true)
      }
      // Every proof must cite an event that is actually IN the prefix that
      // produced it. A proof citing an unread event would be fabricated.
      const seqs = new Set(prefix.map((e) => e.sequenceNumber))
      for (const p of partial.proven) {
        for (const proof of p.provenBy) expect(seqs.has(proof.citedEvent.sequenceNumber)).toBe(true)
      }
    }
    // ANTI-VACUITY: the full run must actually trip a broad set of proven kinds,
    // or "monotone" is a statement about an empty set.
    const kinds = new Set(cx.analyzeRunDivergence(BASELINE, TARGET, FULL).proven.map((p) => p.kind))
    expect(kinds.size).toBeGreaterThanOrEqual(3)
    expect(kinds).toContain('tool_removed')
    expect(kinds).toContain('model_removed')
  })

  it('a proof already established survives more history being read', () => {
    // The other half of monotonicity: reading MORE must not retract a proof.
    let previous = new Set<string>()
    for (let n = 0; n <= FULL.length; n++) {
      const current = new Set(
        cx.analyzeRunDivergence(BASELINE, TARGET, FULL.slice(0, n)).proven.map((p) => p.reasonKey),
      )
      for (const key of previous) {
        expect(current.has(key), `${key} was proven at length ${n - 1} and retracted at ${n}`).toBe(true)
      }
      previous = current
    }
    expect(previous.size).toBeGreaterThan(0)
  })

  it('a count-based budget proof rests on a LOWER bound, so truncation cannot falsify it', () => {
    // `maxToolCalls` is the one proven kind derived from a COUNT rather than a
    // single witnessing event. A capped read undercounts, so firing means the
    // true count is at least as high — sound. The dangerous inverse (a capped
    // read OVERcounting) is checked by asserting the count never exceeds the
    // events supplied.
    const obs = cx.extractRunObservation(FULL.slice(0, 4))
    expect(obs.toolCalls.length).toBeLessThanOrEqual(4)
    const under = cx.analyzeRunDivergence(BASELINE, TARGET, FULL.slice(0, 2), { scanTruncated: true })
    expect(under.proven.some((p) => p.reasonKey.startsWith('budget_exceeded:maxToolCalls'))).toBe(false)
  })
})

// ===========================================================================
// GROUP 7 — MIRROR DRIFT: convex/helpers/divergence.ts vs contracts
// `convex/` MIRRORS `packages/contracts` rather than importing it, by documented
// precedent. Team A's own suite lives beside the engine and cannot see contracts,
// so a silent divergence between the two vocabularies would fail NOWHERE. Mirrors
// have drifted silently twice this session. This is the check for it.
// ===========================================================================

describe('divergence/mirror-elimination', () => {
  const engineSrc = readFileSync(
    new URL('../../convex/helpers/divergence.ts', import.meta.url),
    'utf8',
  )

  /**
   * The mirror is GONE — `convex/helpers/divergence.ts` now imports its
   * vocabulary from `@agent-flight-recorder/contracts` instead of restating it.
   * That makes drift structurally impossible rather than merely tested for, so
   * the old member-by-member comparison is retired in favour of guarding the
   * property that replaced it: no local redeclaration may reappear.
   */
  const MUST_NOT_BE_REDECLARED = [
    'DivergenceDimension',
    'DivergenceUnassessedReason',
    'ProvenDivergenceKind',
    'SpeculativeDivergenceKind',
    'IndeterminateDivergenceKind',
    'DivergenceVerdict',
  ] as const

  it.each(MUST_NOT_BE_REDECLARED)('%s is imported from contracts, not restated', (typeName) => {
    expect(
      engineSrc.includes(`export type ${typeName} =`),
      `${typeName} is declared locally again — the mirror is back and can drift`,
    ).toBe(false)
    expect(engineSrc).toMatch(new RegExp(`\\b${typeName}\\b`))
  })

  it('the engine imports its vocabulary from the contracts package', () => {
    expect(engineSrc).toMatch(/from "@agent-flight-recorder\/contracts"/)
    // ANTI-VACUITY: the assertions above would pass on a file that mentions
    // none of these names at all. It must really be the divergence engine.
    expect(engineSrc).toMatch(/export function analyzeConfigPair/)
    expect(engineSrc).toMatch(/export function foldFleetDivergence/)
  })

  it('the shared representative-run cap is a single value, not two', () => {
    expect(cx.MAX_DIVERGENCE_REPRESENTATIVE_RUNS).toBe(contractsMaxRepresentativeRuns)
  })
})

// ===========================================================================
// GROUP 7b — SERVER/CLIENT VERDICT AGREEMENT
//
// The divergence answer crosses a process boundary: the server computes a
// verdict, and any client that re-derives one from the same report — the MCP
// tool, `afr compat`, a future `/api/v1` route consumer — must reach the SAME
// answer. A disagreement in the direction "server says indeterminate, client
// says compatible" is a false green produced by nobody's bug in particular,
// which is the hardest kind to find.
// ===========================================================================

describe('divergence/server-client-verdict-agreement', () => {
  /**
   * REGRESSION SENTINEL — `contracts/is-fleet-scan-complete-vacuous-on-empty-window`.
   *
   * RETIRED in contracts 0.16.1, verified against the built artifact. The probe
   * stays so that a predicate regaining vacuity re-fires it.
   *
   * `convex/helpers/divergence.ts` deliberately overrides the contract:
   *
   *     isFleetScanComplete = window.runsAnalyzed > 0 && contractsIsFleetScanComplete(window)
   *
   * because the contract's version is vacuously TRUE on an empty window — zero
   * scanned, nothing truncated, nothing unassessable — so a scan that analysed
   * NO RUNS re-derives as `compatible`. Reachable on an ordinary path: a version
   * whose runs have aged out of the org retention window (ADR-001).
   *
   * The server is right and the contract is wrong, which means every consumer
   * that re-derives from the contract disagrees with the server on exactly the
   * inputs where being wrong is worst. Team A flagged this upstream; it has not
   * landed in contracts, so it is ledgered here as a live cross-boundary defect
   * rather than as an engine bug.
   */
  it('the contract and the engine agree on whether an empty scan is complete', () => {
    const emptyWindow = {
      runsScanned: 0,
      runsAnalyzed: 0,
      runsUnassessable: 0,
      runsSkippedForBudget: 0,
      scanTruncated: false,
    }
    const serverSays = cx.isFleetScanComplete(emptyWindow as never)
    const contractSays = contractsIsFleetScanComplete(emptyWindow as never)

    if (PROBE_CONTRACTS_EMPTY_WINDOW.detects({ serverSays, contractSays })) {
      defect(PROBE_CONTRACTS_EMPTY_WINDOW.id, {
        window: emptyWindow,
        serverIsFleetScanComplete: serverSays,
        contractIsFleetScanComplete: contractSays,
        serverVerdict: contractsVerdict({ provenCount: 0, speculativeCount: 0, complete: serverSays }),
        clientReDerivedVerdict: contractsVerdict({
          provenCount: 0,
          speculativeCount: 0,
          complete: contractSays,
        }),
        note: 'a client re-deriving the verdict from an empty report computes `compatible` where the server returns `indeterminate`',
      })
    }

    // FIXTURE AUDIT: the window must be genuinely empty AND genuinely
    // untruncated, so this is the vacuous case and not a mis-declared one.
    expect(emptyWindow.runsAnalyzed).toBe(0)
    expect(emptyWindow.scanTruncated).toBe(false)
    expect(emptyWindow.runsUnassessable).toBe(0)
  })

  it('server and client agree on every NON-empty window shape', () => {
    // The disagreement must be confined to the empty case. If it were wider,
    // the ledger entry above would be understating the problem.
    let compared = 0
    for (const runsAnalyzed of [1, 25]) {
      for (const scanTruncated of [true, false]) {
        for (const runsUnassessable of [0, 3]) {
          for (const runsSkippedForBudget of [0, 2]) {
            const w = {
              runsScanned: 25,
              runsAnalyzed,
              runsUnassessable,
              runsSkippedForBudget,
              scanTruncated,
            }
            expect(
              cx.isFleetScanComplete(w as never),
              `disagreement at ${JSON.stringify(w)}`,
            ).toBe(contractsIsFleetScanComplete(w as never))
            compared += 1
          }
        }
      }
    }
    // ANTI-VACUITY: the sweep must be broad and must contain both outcomes.
    expect(compared).toBe(16)
  })

  it('a truncated or budget-capped scan is incomplete on BOTH sides', () => {
    // The completeness fields a forwarder is most likely to drop. Each must be
    // independently sufficient to make the scan incomplete, on both sides.
    const base = {
      runsScanned: 25,
      runsAnalyzed: 25,
      runsUnassessable: 0,
      runsSkippedForBudget: 0,
      scanTruncated: false,
    }
    expect(cx.isFleetScanComplete(base as never)).toBe(true)
    for (const partial of [
      { scanTruncated: true },
      { runsUnassessable: 1 },
      { runsSkippedForBudget: 1 },
      { nextCursor: 'more' },
    ]) {
      const w = { ...base, ...partial }
      expect(
        cx.isFleetScanComplete(w as never),
        `${JSON.stringify(partial)} did not make the scan incomplete`,
      ).toBe(false)
      expect(contractsIsFleetScanComplete(w as never)).toBe(false)
    }
  })
})

// ===========================================================================
// GROUP 7c — VACUITY SWEEP: DOES ANY COMPLETENESS PREDICATE CLEAR ON ZERO
// EVIDENCE?
//
// Two predicates in this feature were built entirely from NEGATIVE clauses —
// nothing truncated, nothing skipped, nothing unassessed, no pages remaining —
// and an analysis that did nothing satisfies every negative clause at once. The
// same shape has now produced defects in three layers, so this group does not
// ask "are these two correct". It DISCOVERS every completeness predicate the
// contract exports and asserts none of them clears on zero evidence.
//
// The discovery step is the point: a predicate added later with the same shape
// fails here without anyone having to think of the empty case again.
// ===========================================================================

describe('divergence/completeness-vacuity-sweep', () => {
  const contractsSrc = readFileSync(
    new URL('../../packages/contracts/src/divergence.ts', import.meta.url),
    'utf8',
  )

  /** Every exported `is…Complete` predicate the contract declares. */
  const DISCOVERED = [
    ...contractsSrc.matchAll(/export function (is[A-Za-z]*Complete)\s*\(/g),
  ]
    .map((m) => m[1]!)
    .sort()

  /**
   * A zero-evidence input for each predicate: NOTHING was examined, and every
   * negative flag is at its "no problem here" value. If a predicate returns
   * true for any of these, it certifies an analysis that never happened.
   */
  const ZERO_EVIDENCE: Record<string, () => Record<string, unknown>[]> = {
    isDivergenceCoverageComplete: () =>
      booleanSweep(['eventHistoryComplete']).map((flags) => ({
        assessed: [],
        unassessed: [],
        eventsExamined: 0,
        ...flags,
      })),
    isDivergenceAnalysisComplete: () =>
      booleanSweep(['eventHistoryComplete']).map((flags) => ({
        runId: 'r1',
        baselineVersionId: 'v1',
        targetVersionId: 'v2',
        analyzedAt: 0,
        verdict: 'compatible',
        proven: [],
        speculative: [],
        indeterminate: [],
        coverage: { assessed: [], unassessed: [], eventsExamined: 0, ...flags },
      })),
    isFleetScanComplete: () =>
      booleanSweep(['scanTruncated']).map((flags) => ({
        runsScanned: 0,
        runsAnalyzed: 0,
        runsUnassessable: 0,
        runsSkippedForBudget: 0,
        ...flags,
      })),
    isFleetDivergenceAnalysisComplete: () =>
      booleanSweep(['scanTruncated']).map((flags) => ({
        agentId: 'a1',
        baselineVersionId: 'v1',
        targetVersionId: 'v2',
        analyzedAt: 0,
        verdict: 'compatible',
        provenReasons: [],
        speculativeReasons: [],
        indeterminateReasons: [],
        runsWithProvenDivergence: 0,
        runsPartiallyAnalyzed: 0,
        window: {
          runsScanned: 0,
          runsAnalyzed: 0,
          runsUnassessable: 0,
          runsSkippedForBudget: 0,
          ...flags,
        },
      })),
  }

  /** Every combination of the named booleans. */
  function booleanSweep(keys: string[]): Record<string, boolean>[] {
    let out: Record<string, boolean>[] = [{}]
    for (const k of keys) {
      out = out.flatMap((base) => [
        { ...base, [k]: true },
        { ...base, [k]: false },
      ])
    }
    return out
  }

  it('the discovered predicate set is non-empty and fully covered by this sweep', () => {
    // ANTI-VACUITY, and the durable part: a predicate the contract adds later
    // has no zero-evidence case here, so this fails until someone writes one.
    // Without it the sweep silently stops covering the feature as it grows.
    expect(DISCOVERED.length, 'no completeness predicates were discovered').toBeGreaterThan(2)
    expect(DISCOVERED).toEqual(Object.keys(ZERO_EVIDENCE).sort())
  })

  it.each(Object.keys(ZERO_EVIDENCE).sort())('%s never clears on zero evidence', (name) => {
    const fn = (contractsModule as Record<string, unknown>)[name] as (i: unknown) => boolean
    expect(typeof fn, `${name} is not exported at runtime`).toBe('function')
    const cases = ZERO_EVIDENCE[name]!()
    expect(cases.length, 'sweep produced no cases').toBeGreaterThan(1)
    for (const input of cases) {
      expect(
        fn(input),
        `${name} returned TRUE on zero evidence: ${JSON.stringify(input)}\n  ` +
          'A predicate built only from negative clauses is satisfied by an analysis that did nothing. ' +
          'It needs a POSITIVE clause asserting that something was actually examined.',
      ).toBe(false)
    }
  })

  it('each predicate still clears when evidence IS present', () => {
    // The counterweight. A predicate hard-coded to `false` would pass the sweep
    // above and be useless, so each must return true on a genuinely complete
    // analysis. Without this the sweep could be satisfied by breaking them.
    expect(
      contractsModule.isDivergenceCoverageComplete({
        assessed: ['tools'],
        unassessed: [],
        eventsExamined: 12,
        eventHistoryComplete: true,
      } as never),
    ).toBe(true)
    expect(
      contractsModule.isFleetScanComplete({
        runsScanned: 25,
        runsAnalyzed: 25,
        runsUnassessable: 0,
        runsSkippedForBudget: 0,
        scanTruncated: false,
      } as never),
    ).toBe(true)
  })

  it("the engine's own completeness predicate is vacuity-free too", () => {
    // The engine wraps `isFleetScanComplete`. Whatever the contract does, the
    // server-side answer is the one a deploy gate sees.
    for (const scanTruncated of [true, false]) {
      expect(
        cx.isFleetScanComplete({
          runsScanned: 0,
          runsAnalyzed: 0,
          runsUnassessable: 0,
          runsSkippedForBudget: 0,
          scanTruncated,
        } as never),
      ).toBe(false)
    }
  })
})

// ===========================================================================
// GROUP 7d — INDETERMINATE WHERE A PROOF WAS AVAILABLE
//
// The third band's own failure direction, and the one this suite had not
// attacked. An engine that gives up where it could decide makes the gate
// useless, and an ignored gate is an absent gate. This is the mirror image of
// "speculative presented as proven" and it is not caught by any check for the
// latter.
//
// The decidable case: when a target's capability set is READABLE AND EMPTY, the
// IDENTITY of the capability a run used is irrelevant — nothing whatsoever is a
// member of the empty set. So an unreadable tool name or model string, which
// normally forces `indeterminate`, is still PROVABLE against an empty set.
// ===========================================================================

describe('divergence/gave-up-where-decidable', () => {
  const EXTERNALIZED = {
    type: '_externalized',
    originalType: 'tool.call',
    _artifact: { artifactId: 'art_1', storageKey: 'k', storageBucket: 'b', checksum: 'c', size: 20_480 },
  }

  it('an unreadable tool name is still decidable against an EMPTY target tool set', () => {
    const target = { tools: [] }
    const delta = cx.analyzeConfigPair({ tools: ['a'] }, target)
    const run = cx.analyzeRunDivergence({ tools: ['a'] }, target, [
      { type: 'tool.call', sequenceNumber: 1, _id: 'ev_1', payload: EXTERNALIZED },
    ])
    const subject = {
      targetSetReadable: delta.targetToolsByName !== null,
      targetSetSize: delta.targetToolsByName?.size ?? -1,
      recordedEventOfKind: true,
      provenKeys: run.proven.map((p) => p.reasonKey),
    }
    if (PROBE_UNNAMED_TOOL_EMPTY_SET.detects(subject)) {
      defect(PROBE_UNNAMED_TOOL_EMPTY_SET.id, {
        targetConfig: target,
        verdict: run.verdict,
        proven: subject.provenKeys,
        indeterminate: (run as unknown as { indeterminate?: { reasonKey: string }[] }).indeterminate?.map(
          (x) => x.reasonKey,
        ),
        note: 'the event type `tool.call` survives externalization, so the engine KNOWS a tool was called; against an empty enumerated tool list the name is irrelevant and tool_removed is provable',
      })
    }

    // FIXTURE AUDIT: the target set must be genuinely READABLE and genuinely
    // EMPTY — an ABSENT tool list must NOT reach this probe, because declining
    // to prove there is correct.
    expect(subject.targetSetReadable).toBe(true)
    expect(subject.targetSetSize).toBe(0)
    // FIXTURE AUDIT: the payload must really be unreadable, or there is no
    // give-up to detect.
    expect(EXTERNALIZED.type).toBe('_externalized')
    expect(cx.extractRunObservation([
      { type: 'tool.call', sequenceNumber: 1, payload: EXTERNALIZED },
    ]).toolCalls).toEqual([])
  })

  it('a NON-empty target tool set correctly declines to prove — the boundary', () => {
    // The counterweight that stops the finding above from reading as "always
    // prove on unreadable data". With a non-empty set the call may have been to
    // a tool the target still declares, so `indeterminate` is the right answer.
    const run = cx.analyzeRunDivergence({ tools: ['a'] }, { tools: ['x'] }, [
      { type: 'tool.call', sequenceNumber: 1, _id: 'ev_1', payload: EXTERNALIZED },
    ])
    expect(run.proven).toEqual([])
    expect(run.verdict).not.toBe('compatible')
  })

  it('an unreadable model is still decidable against an EMPTY target model set', () => {
    const target = { models: [] }
    const delta = cx.analyzeConfigPair({ models: ['a'] }, target)
    const run = cx.analyzeRunDivergence({ models: ['a'] }, target, [
      {
        type: 'llm.request',
        sequenceNumber: 1,
        _id: 'ev_1',
        payload: { ...EXTERNALIZED, originalType: 'llm.request' },
      },
    ])
    const subject = {
      targetSetReadable: delta.targetModels !== null,
      targetSetSize: delta.targetModels?.size ?? -1,
      recordedEventOfKind: true,
      provenKeys: run.proven.map((p) => p.reasonKey),
    }
    if (PROBE_UNREADABLE_MODEL_EMPTY_SET.detects(subject)) {
      defect(PROBE_UNREADABLE_MODEL_EMPTY_SET.id, {
        targetConfig: target,
        verdict: run.verdict,
        proven: subject.provenKeys,
      })
    }
    expect(subject.targetSetReadable).toBe(true)
    expect(subject.targetSetSize).toBe(0)
  })

  it('proofs that do NOT depend on the baseline are made without one', () => {
    // The other way to give up unnecessarily: requiring a baseline snapshot for
    // a claim that is purely (target config x recorded events). All of these
    // must still prove with `baselineSnapshot: undefined`.
    expect(
      cx.analyzeRunDivergence(undefined, { tools: [] }, [cxToolCall(1, 'a')]).proven.map((p) => p.reasonKey),
    ).toContain('tool_removed:a')
    expect(
      cx.analyzeRunDivergence(undefined, { tools: ['x'] }, [cxToolCall(1, 'a')]).proven.map((p) => p.reasonKey),
    ).toContain('tool_removed:a')
    expect(
      cx
        .analyzeRunDivergence(undefined, { models: ['x'] }, [
          { type: 'llm.request', sequenceNumber: 1, _id: 'e1', payload: { type: 'llm.request', model: 'y' } },
        ])
        .proven.map((p) => p.reasonKey),
    ).toContain('model_removed:y')
  })

  it('a count-based ceiling is proven from a LOWER bound even when names are unreadable', () => {
    // `maxToolCalls` counts tool.call EVENTS, which survive externalization. A
    // capped or unreadable read undercounts, so exceeding the ceiling is still
    // a proof. Giving up here would discard a decidable case.
    const unreadable = Array.from({ length: 5 }, (_, i) => ({
      type: 'tool.call',
      sequenceNumber: i + 1,
      _id: `ev_${i + 1}`,
      payload: EXTERNALIZED,
    }))
    const run = cx.analyzeRunDivergence(undefined, { maxToolCalls: 2 }, unreadable as never)
    expect(run.proven.map((p) => p.reasonKey)).toContain('budget_exceeded:maxToolCalls:2')
    // FIXTURE AUDIT: every event must genuinely be unreadable, so the proof
    // rests on the COUNT alone.
    expect(cx.extractRunObservation(unreadable as never).toolCalls).toEqual([])
    expect(unreadable.length).toBeGreaterThan(2)
  })
})

// ===========================================================================
// GROUP 7e — THE PROJECTION COMPLETENESS INVARIANT
//
// A caller may project a divergence report with `?fields=`. The invariant: a
// projection that asserts a CONCLUSION must come back with the evidence that
// qualifies it, or `?fields=verdict` buys a green build by stripping the proof
// that the answer was provisional.
//
// HISTORY, because it is why this group is shaped the way it is. The invariant
// was briefly held by TWO layers: a route-level stopgap in apps/web and the
// durable rule in convex/read_api.ts. This group was written to make deleting
// the redundant one safe and deleting the load-bearing one loud. The durable
// fix landed, the stopgap was deleted, and the group passed through that
// transition unchanged — which is the outcome it existed to produce.
//
// It is therefore written against the PROPERTY, not a layer count: the route
// layer is DISCOVERED (absent today), and the invariant is asserted over
// whatever layers exist. Hard-coding "there are two" or "there is one" is what
// makes a seam test wrong on the day the layering changes, which is the day it
// most needs to be right.
//
// The backend is measured BY EXECUTION — `validateDivergenceFieldSelection`'s
// output — never by reading `DIVERGENCE_IDENTITY_FIELDS`. That constant is
// still identifiers only and has been throughout; the behaviour moved into a
// rule beside it. Reading it produced a confident false positive. See the
// `backendSelect` comment.
// ===========================================================================

describe('divergence/projection-completeness-seam', () => {
  type Kind = 'run' | 'fleet' | 'config'
  const KINDS: Kind[] = ['run', 'fleet', 'config']

  /**
   * THE INVARIANT, stated here rather than read from either implementation.
   *
   * Deriving it from one of the layers would make this suite agree with
   * whichever layer it copied and prove nothing. These are the fields without
   * which a caller cannot tell a PROVISIONAL answer from a COMPLETE one — the
   * distinction the whole feature rests on.
   */
  const REQUIRED_COMPLETENESS: Readonly<Record<Kind, readonly string[]>> = {
    // `coverage` says which dimensions were assessed and whether the event
    // history was read to the end; a non-null `nextEventCursor` says it was not.
    run: ['coverage', 'nextEventCursor'],
    // `window` carries scanTruncated / runsUnassessable / runsSkippedForBudget;
    // `nextCursor` says pages remain, so every count is a lower bound.
    fleet: ['window', 'nextCursor'],
    // The config tier structurally cannot prove anything, so a caller who does
    // not see WHY reads a clean comparison as "safe to ship".
    config: ['coverage', 'provenKindsReachable', 'provenUnavailableBecause'],
  }

  /** A projection that asserts a conclusion — the case the invariant governs. */
  const CONCLUSION_PROJECTION: Readonly<Record<Kind, string[]>> = {
    run: ['verdict'],
    fleet: ['verdict'],
    config: ['verdict'],
  }

  const readApiSrc = readFileSync(new URL('../../convex/read_api.ts', import.meta.url), 'utf8')

  /** Parse one of read_api.ts's field tables into {kind: names}. */
  function parseFieldTable(name: string): Record<string, string[]> {
    const start = readApiSrc.indexOf(`const ${name}: Record<DivergenceReportKind, string[]> = {`)
    expect(start, `${name} not found in convex/read_api.ts`).toBeGreaterThan(-1)
    const body = readApiSrc.slice(start, readApiSrc.indexOf('\n};', start))
    const out: Record<string, string[]> = {}
    for (const m of body.matchAll(/(run|fleet|config):\s*\[([^\]]*)\]/g)) {
      out[m[1]!] = [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)
    }
    expect(Object.keys(out).sort(), `${name} parsed no kinds`).toEqual([...KINDS].sort())
    return out
  }

  /**
   * THE BACKEND LAYER, MEASURED BY CALLING IT — not by reading a constant.
   *
   * This probe previously read `DIVERGENCE_IDENTITY_FIELDS` and concluded the
   * backend still force-included identifiers only. That constant IS still
   * identifiers only — and the conclusion was WRONG, because the durable fix
   * landed as a RULE in `validateDivergenceFieldSelection` rather than as a
   * widening of the list:
   *
   *     const selected = new Set([...fields, ...DIVERGENCE_IDENTITY_FIELDS[kind]])
   *     if (DIVERGENCE_CONCLUSION_FIELDS[kind].some((f) => selected.has(f)))
   *       for (const caveat of DIVERGENCE_CAVEAT_FIELDS[kind]) selected.add(caveat)
   *
   * A constant is a plausible-looking PROXY for a behaviour, and it stops
   * tracking the moment someone implements the same property another way. The
   * resulting ledger entry claimed a hole that was already closed — the false
   * direction that matters most here, because it would have blocked a safe
   * deletion, and a ledger that cries wolf gets ignored like a gate that shrugs.
   *
   * The function is module-private (no export), and there is no Convex runtime
   * here, so it cannot be imported or driven through its handler. It is instead
   * EXTRACTED AND EXECUTED: the real body, with the real tables injected. That
   * runs the actual conditional logic, so a change to the RULE is caught — which
   * reading any of the four tables would not be.
   *
   * Extraction failure is a hard error, never a skip, and the faithfulness of
   * the extraction is checked against behaviour known independently of it.
   */
  const backendSelect: (kind: Kind, fields: string[] | undefined) => Set<string> | undefined = (() => {
    const decl = readApiSrc.indexOf('function validateDivergenceFieldSelection(')
    if (decl < 0) {
      throw new Error(
        'validateDivergenceFieldSelection not found in convex/read_api.ts — this probe measures its OUTPUT and must not fall back to reading a constant',
      )
    }
    const open = readApiSrc.indexOf('{', readApiSrc.indexOf(')', decl))
    let depth = 0
    let close = -1
    for (let k = open; k < readApiSrc.length; k++) {
      if (readApiSrc[k] === '{') depth += 1
      else if (readApiSrc[k] === '}') {
        depth -= 1
        if (depth === 0) {
          close = k
          break
        }
      }
    }
    if (close < 0) throw new Error('could not brace-match validateDivergenceFieldSelection')
    const body = readApiSrc
      .slice(open + 1, close)
      .replace(/: ReadonlySet<string> \| undefined/g, '')
      .replace(/: string\[\] \| undefined/g, '')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const compiled = new Function(
      'kind',
      'fields',
      'DIVERGENCE_REPORT_FIELDS',
      'DIVERGENCE_IDENTITY_FIELDS',
      'DIVERGENCE_CONCLUSION_FIELDS',
      'DIVERGENCE_CAVEAT_FIELDS',
      body,
    ) as (
      k: string,
      f: string[] | undefined,
      a: unknown,
      b: unknown,
      c: unknown,
      d: unknown,
    ) => Set<string> | undefined
    return (kind, fields) =>
      compiled(
        kind,
        fields,
        parseFieldTable('DIVERGENCE_REPORT_FIELDS'),
        parseFieldTable('DIVERGENCE_IDENTITY_FIELDS'),
        parseFieldTable('DIVERGENCE_CONCLUSION_FIELDS'),
        parseFieldTable('DIVERGENCE_CAVEAT_FIELDS'),
      )
  })()

  /** What the BACKEND actually delivers for a projection, measured by execution. */
  function backendDelivers(kind: Kind, fields: string[]): string[] {
    return [...(backendSelect(kind, fields) ?? [])]
  }

  const BACKEND_VALID = parseFieldTable('DIVERGENCE_REPORT_FIELDS')

  /** What the ROUTE layer guarantees for a given projection. */
  /** What the route layer contributes — the identity when no such layer exists. */
  function routeLayerFields(kind: Kind, fields: string[]): string[] {
    return routeFields?.withCompletenessFields(kind, fields) ?? fields
  }

  it('the extracted backend function behaves as the real one is known to', () => {
    // FAITHFULNESS GUARD. Everything below trusts this extraction, so it is
    // checked against behaviour established independently of the extraction:
    // the two documented error cases, the identity-inclusion rule, and the
    // no-projection passthrough. If the function is refactored into a shape the
    // extractor mangles, this fails LOUDLY rather than quietly reporting a hole.
    expect(() => backendSelect('run', ['definitely-not-a-field'])).toThrow(/unknown field/)
    expect(() => backendSelect('run', [])).toThrow(/must not be empty/)
    expect(backendSelect('run', undefined)).toBeUndefined()
    for (const kind of KINDS) {
      // Identity is always present, whatever else happens.
      for (const id of parseFieldTable('DIVERGENCE_IDENTITY_FIELDS')[kind]!) {
        expect(backendDelivers(kind, ['analyzedAt'])).toContain(id)
      }
    }
  })

  it('the parsed backend field list is real and non-trivial', () => {
    // ANTI-VACUITY: a regex that silently matched nothing would make the
    // enumeration-based checks below pass by default.
    for (const kind of KINDS) {
      expect(BACKEND_VALID[kind]?.length ?? 0, `no valid fields parsed for ${kind}`).toBeGreaterThan(5)
    }
    expect(Object.keys(BACKEND_VALID).sort()).toEqual([...KINDS].sort())
  })

  it.each(KINDS)(
    'the UNION of both layers keeps the completeness evidence for a %s conclusion',
    (kind) => {
      // THE SEAM ASSERTION. Delete the load-bearing layer and this fails;
      // delete the redundant one and it still passes. That is the whole point.
      const asked = CONCLUSION_PROJECTION[kind]
      const delivered = new Set([
        ...backendDelivers(kind, routeLayerFields(kind, asked)),
      ])
      for (const required of REQUIRED_COMPLETENESS[kind]) {
        expect(
          delivered.has(required),
          `?fields=${asked.join(',')} on the ${kind} report loses "${required}".\n` +
            `  route layer requests: ${routeLayerFields(kind, asked).join(', ')}\n` +
            `  backend delivers: ${backendDelivers(kind, routeLayerFields(kind, asked)).join(', ')}\n` +
            '  A conclusion without its caveats is the afr-compat-exits-zero shape.',
        ).toBe(true)
      }
      // ANTI-VACUITY: the caller must genuinely NOT have asked for these, or
      // the union would contain them trivially.
      for (const required of REQUIRED_COMPLETENESS[kind]) expect(asked).not.toContain(required)
    },
  )

  /**
   * REGRESSION SENTINEL — `stopgap/route-layer-still-load-bearing`.
   *
   * RETIRED: the durable backend rule landed and the route stopgap was deleted.
   * The probe stays registered and liveness-checked so that a backend that
   * stops pulling caveats re-fires it, naming exactly which fields are lost.
   *
   * Measured by calling the backend with the caller's RAW projection — i.e. by
   * simulating any route-level help being absent, which it now is.
   */
  it('the backend alone upholds the invariant, with no route layer helping', () => {
    // Measured by CALLING the backend with the caller's raw projection — i.e.
    // simulating the route stopgap being deleted.
    const uncovered: Record<string, string[]> = {}
    for (const kind of KINDS) {
      const delivered = new Set(backendDelivers(kind, CONCLUSION_PROJECTION[kind]))
      const missing = REQUIRED_COMPLETENESS[kind].filter((f) => !delivered.has(f))
      if (missing.length > 0) uncovered[kind] = missing
    }
    if (PROBE_STOPGAP_LOAD_BEARING.detects({ uncoveredKinds: Object.keys(uncovered) })) {
      defect(PROBE_STOPGAP_LOAD_BEARING.id, {
        uncoveredByBackendAlone: uncovered,
        note: 'with the route stopgap removed, the backend alone loses these fields',
      })
    }
    // ANTI-VACUITY: the projection used must genuinely assert a conclusion and
    // must genuinely not name the caveats itself.
    for (const kind of KINDS) {
      for (const req of REQUIRED_COMPLETENESS[kind]) {
        expect(CONCLUSION_PROJECTION[kind]).not.toContain(req)
      }
    }
  })

  it('a metadata-only projection is left alone, so the token saving survives', () => {
    // The counterweight to force-inclusion: if every projection dragged the
    // caveats in, `?fields=` would stop being worth using and integrators would
    // drop it — the same fail-open that made rejection the worse fix.
    for (const kind of KINDS) {
      const delivered = new Set(backendDelivers(kind, routeLayerFields(kind, ['analyzedAt'])))
      for (const caveat of REQUIRED_COMPLETENESS[kind]) {
        expect(
          delivered.has(caveat),
          `?fields=analyzedAt on ${kind} dragged in "${caveat}" — metadata asserts no conclusion, so there is nothing to caveat, and pulling them anyway erodes the token saving that stops integrators dropping ?fields= entirely`,
        ).toBe(false)
      }
      expect(delivered.has('analyzedAt')).toBe(true)
    }
  })

  it('no route-level field mirror has been reintroduced', () => {
    // The old stopgap hand-mirrored convex/read_api.ts's field NAMES, because
    // apps/web must not import convex/ (CLAUDE.md). Mirrors have drifted three
    // times in this feature, so the valuable assertion is no longer "the mirror
    // agrees" — it is that the mirror STAYS GONE.
    //
    // A route that re-adds its own conclusion/caveat tables would be a second
    // source of truth for a property the backend now owns outright, and the
    // failure mode is the one that already bit: two layers each assuming the
    // other handles it.
    expect(routeFields, 'the route-level field-augmentation module is back').toBeNull()

    const v1Dir = new URL('../../apps/web/app/api/v1/_lib/', import.meta.url)
    const present = readdirSync(v1Dir)
    for (const file of present) {
      if (!file.endsWith('.ts')) continue
      const src = readFileSync(new URL(file, v1Dir), 'utf8')
      // A route-level module naming the backend's caveat fields is mirroring
      // them. `fieldsParam.ts` (generic shape validation) names none of these.
      for (const caveat of ['nextEventCursor', 'provenKindsReachable', 'provenUnavailableBecause']) {
        expect(
          src.includes(caveat),
          `apps/web/app/api/v1/_lib/${file} names the backend caveat field "${caveat}" — a route-level mirror of a backend-owned rule`,
        ).toBe(false)
      }
    }
    // ANTI-VACUITY: the directory must actually contain the generic helper, or
    // this loop is scanning nothing.
    expect(present).toContain('fieldsParam.ts')
  })

  it('the route forwards the caller projection VERBATIM', () => {
    // The other way a route could reopen the hole after the backend closed it:
    // augmenting or post-filtering on the way through. The augmentation now
    // happens inside the Convex handler, so a route that rewrote `fields` — in
    // either direction — would be silently overriding a backend guarantee.
    const routes = [
      'apps/web/app/api/v1/runs/[runId]/divergence/route.ts',
      'apps/web/app/api/v1/agents/[agentId]/divergence/route.ts',
      'apps/web/app/api/v1/agents/[agentId]/divergence/config/route.ts',
    ].filter((r) => existsSync(new URL(`../../${r}`, import.meta.url)))
    // ANTI-VACUITY: at least one divergence route must exist, or this proves
    // nothing about a surface that is supposed to be live.
    expect(routes.length, 'no /api/v1 divergence route found').toBeGreaterThan(0)
    for (const rel of routes) {
      const src = readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
      expect(src, `${rel} augments the caller's field selection`).not.toMatch(
        /withCompletenessFields|CAVEAT_FIELDS|CONCLUSION_FIELDS/,
      )
      // It must hand the parsed selection straight to the service.
      expect(src).toMatch(/fields:\s*fields\.fields/)
    }
  })

  it('every field a reader draws a conclusion from pulls its caveats in', () => {
    // Not just `verdict`: `proven: []` is as much a claim as
    // `verdict: "compatible"`. A caller that asked only for the finding list and
    // got an empty array concludes the version is safe.
    const conclusionOnly: Record<Kind, string[]> = {
      run: ['proven'],
      fleet: ['provenReasons'],
      config: ['indeterminate'],
    }
    for (const kind of KINDS) {
      // The UNION, same as the main seam assertion. Checking the route layer
      // alone would make this test fail the moment the durable backend fix
      // lands and the redundant route layer is correctly deleted — i.e. it
      // would punish exactly the outcome this group exists to make safe.
      const delivered = new Set(backendDelivers(kind, routeLayerFields(kind, conclusionOnly[kind])))
      for (const required of REQUIRED_COMPLETENESS[kind]) {
        expect(
          delivered.has(required),
          `?fields=${conclusionOnly[kind]!.join(',')} on ${kind} loses "${required}"`,
        ).toBe(true)
      }
    }
  })
})

// ===========================================================================
// GROUP 8 — TENANCY (structural)
// The runtime boundary lives in convex/divergence.ts against a live ctx.db and
// Clerk identity, neither of which exists here. What CAN be checked without a
// deployment is asserted; what cannot is named in the report, not faked.
// ===========================================================================

describe('divergence/tenancy (structural)', () => {
  it('the pure engines carry no org identity, so they cannot leak one', () => {
    // Defence in depth in the honest direction: an engine that never sees an
    // orgId cannot cross one. The boundary is therefore entirely the query
    // layer's, which is where the runtime probe must eventually go.
    const run = cx.analyzeRunDivergence({ tools: ['a'] }, { tools: [] }, [cxToolCall(1, 'a')])
    expect(JSON.stringify(run)).not.toMatch(/orgId|organization|clerk/i)
    const fleet = cx.foldFleetDivergence([{ runId: 'r1', analysis: run }], {
      runsScanned: 1,
      scanTruncated: false,
    })
    expect(JSON.stringify(fleet)).not.toMatch(/orgId|organization|clerk/i)
  })

  it('two orgs with the same agent, version string and tool set produce identical output', () => {
    // Same-shaped inputs must produce byte-identical output regardless of which
    // tenant they came from: any difference is a fingerprint one org could use
    // to detect another's data.
    const cfg = { tools: ['search'], model: 'gpt-4', systemPrompt: 'p', temperature: 1 }
    const a = cx.analyzeRunDivergence(cfg, { ...cfg, tools: [] }, [cxToolCall(1, 'search')])
    const b = cx.analyzeRunDivergence(cfg, { ...cfg, tools: [] }, [cxToolCall(1, 'search')])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('the query surface resolves the caller BEFORE it observes any id from args', () => {
    // A source-order check, not a runtime one: the ordering IS the security
    // property (a cross-org id and a nonexistent id must reach the same throw on
    // the same line), and it is cheap to regress silently in a refactor.
    const src = readFileSync(new URL('../../convex/divergence.ts', import.meta.url), 'utf8')
    for (const handler of src.split('handler: async (ctx, args) =>').slice(1)) {
      const auth = handler.indexOf('getAuthContext')
      const firstGet = handler.indexOf('ctx.db.get(')
      const resolvePair = handler.indexOf('resolveVersionPair')
      // Either the handler delegates to resolveVersionPair (which does the same
      // thing internally, asserted below) or it authorises before its first read.
      if (resolvePair !== -1 && (auth === -1 || resolvePair < auth)) continue
      expect(auth, 'handler must call getAuthContext').toBeGreaterThanOrEqual(0)
      if (firstGet !== -1) expect(auth).toBeLessThan(firstGet)
    }
    const pair = src.slice(src.indexOf('async function resolveVersionPair'))
    expect(pair.indexOf('getAuthContext')).toBeLessThan(pair.indexOf('ctx.db.get('))
    // Cross-org and nonexistent must be the SAME message, not merely both errors.
    const notFoundMessages = [...src.matchAll(/afrError\("NOT_FOUND",\s*"([^"]+)"/g)].map((m) => m[1])
    expect(notFoundMessages.length).toBeGreaterThan(2)
    expect(new Set(notFoundMessages).size).toBeLessThanOrEqual(2) // "Run not found" / "Agent version not found"
  })
})

// ===========================================================================
// TEETH — every checker above must be capable of FAILING.
// A case that cannot fail is not a test. Each block breaks the subject in
// memory and asserts this suite's own checker rejects it.
// ===========================================================================

describe('teeth', () => {
  it('the proof-citation checker rejects a proven finding with no proof', () => {
    const bad: CxProven = {
      certainty: 'proven',
      kind: 'tool_removed',
      reasonKey: 'tool_removed:x',
      provenClaim: 'x',
      provenBy: [],
    }
    expect(() => expect(bad.provenBy.length).toBeGreaterThan(0)).toThrow()
  })

  it('the proof-citation checker rejects a proof citing an event not in the recording', () => {
    const recorded = new Set([1, 2, 3])
    expect(() => expect(recorded.has(99)).toBe(true)).toThrow()
  })

  it('the past-tense checker rejects a hedged proven claim', () => {
    const hedged = 'This run may have called a tool the target lacks.'
    expect(() => expect(hedged).not.toMatch(/\bmay\b|\bmight\b/i)).toThrow()
  })

  it('the injectivity checker rejects a key builder that truncates the subject', () => {
    // failure_patterns.ts truncates labels at 200 chars. If the divergence
    // reason key ever adopted that, these two distinct tools would merge.
    const truncating = (n: string): string => `tool_removed:${n.slice(0, 200)}`
    const a = 'x'.repeat(300)
    const b = `${'x'.repeat(300)}y`
    expect(a).not.toBe(b)
    expect(() => {
      const seen = new Map<string, string>()
      for (const n of [a, b]) {
        expect(seen.get(truncating(n))).toBeUndefined()
        seen.set(truncating(n), n)
      }
    }).toThrow()
  })

  it('the injectivity checker rejects a key builder that folds case', () => {
    const folding = (n: string): string => `tool_removed:${n.toLowerCase()}`
    expect(() => {
      const seen = new Map<string, string>()
      for (const n of ['getUser', 'getuser']) {
        expect(seen.get(folding(n))).toBeUndefined()
        seen.set(folding(n), n)
      }
    }).toThrow()
  })

  it('the fragmentation checker rejects a key that embeds a run id', () => {
    const fragmenting = ['r1', 'r2', 'r3'].map((r) => `tool_removed:alpha:${r}`)
    expect(() => expect(new Set(fragmenting).size).toBe(1)).toThrow()
  })

  it('the collapse checker rejects a key that drops the subject', () => {
    const collapsing = ['alpha', 'beta'].map(() => 'tool_removed')
    expect(() => expect(new Set(collapsing).size).toBe(2)).toThrow()
  })

  it('the unanalysable checker rejects an engine that reads silence as denial', () => {
    // Silence read as denial is the single most dangerous bug this feature could
    // have, so the checker guarding it must demonstrably fail against it.
    const brokenNormalise = (cfg: Record<string, unknown>): Set<string> =>
      new Set((cfg.tools as string[] | undefined) ?? [])
    const declared = brokenNormalise({ systemPrompt: 'hello' })
    const manufactured = ['search_web'].filter((t) => !declared.has(t))
    expect(() => expect(manufactured).toEqual([])).toThrow()
  })

  it('the truncation checker rejects an engine that grades a capped scan affirmative', () => {
    const brokenVerdict = (proven: unknown[], _truncated: boolean): string =>
      proven.length === 0 ? 'compatible' : 'incompatible'
    expect(() => expect(brokenVerdict([], true)).not.toBe('compatible')).toThrow()
  })

  it('the gap checker rejects an observer that drops an externalized event silently', () => {
    const brokenObservation = { toolCalls: [], gaps: [] as string[] }
    expect(() => expect(brokenObservation.gaps.length).toBeGreaterThan(0)).toThrow()
  })

  it('the tenancy checker rejects distinguishable cross-org and nonexistent messages', () => {
    const leaky = ['Run not found', 'Run belongs to another organization', 'Agent version not found']
    expect(() => expect(new Set(leaky).size).toBeLessThanOrEqual(2)).toThrow()
  })

  it('the suite is bound to the REAL engines, not to local reimplementations', () => {
    // If either module stops exporting what this suite drives, the suite must go
    // red rather than quietly grade something else. This already fired once: the
    // convex engine was rewritten mid-session and the ledger caught it.
    for (const fn of [
      'readConfigSnapshot',
      'analyzeConfigPair',
      'extractRunObservation',
      'analyzeRunDivergence',
      'foldFleetDivergence',
      'mergeFleetAnalyses',
      'computeDivergenceVerdict',
      'isDivergenceCoverageComplete',
      'isFleetScanComplete',
    ] as const) {
      expect(typeof cx[fn], `convex engine must export ${fn}`).toBe('function')
    }
    for (const fn of ['adaptRunReport', 'adaptFleetReport', 'liftUnassessedToIndeterminate'] as const) {
      expect(typeof adapt[fn], `web adapter must export ${fn}`).toBe('function')
    }
  })

  it('the UI service reaches the shipped engine, not a second implementation', () => {
    const svc = readFileSync(
      new URL('../../apps/web/src/lib/services/divergence.ts', import.meta.url),
      'utf8',
    )
    // The UI must reach the SHIPPED engine through the Convex query surface and
    // the adapter — not a second, independently-written analysis. Earlier in
    // this session it did exactly that (a parallel engine under
    // `lib/divergence/{analyze,group}.ts` with a different taxonomy and eight
    // defects of its own), and this assertion is what would catch a relapse.
    expect(svc).toMatch(/convex\.divergence\.analyzeRun/)
    expect(svc).toMatch(/convex\.divergence\.analyzeFleet/)
    expect(svc).toMatch(/adaptRunReport/)
    expect(svc).toMatch(/adaptFleetReport/)
  })
})

// ===========================================================================
// THE LEDGER ASSERTION — declared last so every probe has run.
// ===========================================================================

describe('defect ledger', () => {
  it('observed defects are EXACTLY the known set', () => {
    const observed = [...observedDefects].sort()
    const known = [...KNOWN_DEFECTS].sort()
    if (JSON.stringify(observed) !== JSON.stringify(known)) {
      // eslint-disable-next-line no-console
      console.error(
        'DIVERGENCE LEDGER MISMATCH\n' +
          `  newly observed : ${observed.filter((d) => !known.includes(d)).join(', ') || '(none)'}\n` +
          `  no longer seen : ${known.filter((d) => !observed.includes(d)).join(', ') || '(none)'}\n` +
          'evidence:\n' +
          [...ledgerEvidence.entries()].map(([id, ev]) => `  ${id}: ${JSON.stringify(ev)}`).join('\n'),
      )
    }
    expect(observed).toEqual(known)
  })

  it('every known defect was produced by a probe that ran', () => {
    // Guards the failure mode where a probe is deleted or short-circuited and
    // the ledger entry survives as folklore. Note this loop is VACUOUS on an
    // empty ledger — which is exactly why `ledger/probe-liveness` exists and is
    // not conditional on the ledger having entries.
    for (const id of KNOWN_DEFECTS) {
      expect(ledgerEvidence.has(id), `no probe produced evidence for ${id}`).toBe(true)
      expect(ledgerEvidence.get(id)).toBeDefined()
    }
  })
})

// ===========================================================================
// LEDGER PROBE LIVENESS — the check that makes an empty ledger believable.
// ===========================================================================

/**
 * ── SOURCE-READ AUDIT ──────────────────────────────────────────────────────
 *
 * This suite reads source text in several places. Doing so is legitimate for a
 * STRUCTURAL property ("does this file still redeclare that type") and a trap
 * for a BEHAVIOURAL one ("does this endpoint keep the caveats"), because a
 * named constant is a plausible-looking proxy that stops tracking the behaviour
 * the moment someone implements the same property another way.
 *
 * That is not hypothetical here. This suite asserted against
 * `DIVERGENCE_IDENTITY_FIELDS` and reported a hole that was already closed:
 * the constant was unchanged, but the rule had moved into
 * `validateDivergenceFieldSelection` beside it. A false positive in a ledger is
 * the expensive direction — it blocks a safe change, and a ledger that cries
 * wolf gets ignored exactly like a gate that shrugs.
 *
 * So every source read is classified, and the classification is enforced: if a
 * new one is added without being declared here, this fails. The rule is:
 *
 *   STRUCTURAL  the property IS a fact about the text (a declaration's
 *               presence, an ordering, a literal's uniqueness). Reading is
 *               correct; there is nothing to execute.
 *   EXECUTED    the property is a BEHAVIOUR. Source may be read only to obtain
 *               something that is then CALLED. Asserting on the parsed value
 *               itself is the error above.
 */
describe('suite/source-read-audit', () => {
  const selfSrc = readFileSync(new URL(import.meta.url), 'utf8')

  const CLASSIFIED: ReadonlyArray<{ subject: string; kind: 'STRUCTURAL' | 'EXECUTED'; why: string }> = [
    {
      subject: 'convex/divergence.ts — DIVERGENCE_EVENT_PAGE_SIZE',
      kind: 'STRUCTURAL',
      why: 'a fixture parameter, not an inference: it sizes the page split a probe constructs. No behaviour is concluded from its value.',
    },
    {
      subject: 'convex/divergence.ts — handler auth ordering and NOT_FOUND message uniqueness',
      kind: 'STRUCTURAL',
      why: 'the ordering IS the security property and the messages ARE the oracle surface. There is no Convex runtime here, and the group is labelled `(structural)` precisely so this limit is not mistaken for a runtime proof.',
    },
    {
      subject: 'convex/helpers/divergence.ts — absence of local type redeclarations',
      kind: 'STRUCTURAL',
      why: '"this file does not restate the contract\'s vocabulary" is a fact about the text. There is nothing to call.',
    },
    {
      subject: 'packages/contracts/src/divergence.ts — completeness predicate NAMES',
      kind: 'EXECUTED',
      why: 'source yields the discovered names only; each predicate is then CALLED with zero-evidence inputs. The sweep asserts on return values, never on the parsed list.',
    },
    {
      subject: 'convex/read_api.ts — validateDivergenceFieldSelection',
      kind: 'EXECUTED',
      why: 'the function body and its four tables are extracted and EXECUTED. This is the read that was previously an assertion against DIVERGENCE_IDENTITY_FIELDS, which is why the faithfulness guard exists.',
    },
    {
      subject: 'apps/web/app/api/v1/_lib/*.ts — absence of a reintroduced field mirror',
      kind: 'STRUCTURAL',
      why: 'the property is that these modules do NOT name backend caveat fields. Absence of a mirror is a textual fact.',
    },
    {
      subject: 'apps/web/app/api/v1/**/divergence/route.ts — verbatim forwarding',
      kind: 'STRUCTURAL',
      why: 'the property is that the route does not augment or post-filter. The augmentation itself is asserted by EXECUTION above, at the layer that owns it.',
    },
    {
      subject: 'apps/web/src/lib/services/divergence.ts — wiring to the shipped engine',
      kind: 'STRUCTURAL',
      why: 'which module the service calls is a fact about the text; the behaviour it reaches is asserted directly elsewhere.',
    },
    {
      subject: 'this file — the source-read audit itself',
      kind: 'STRUCTURAL',
      why: 'the audit inspects this file to enforce its own completeness. Counting itself is correct: it is a source read like any other.',
    },
    {
      subject: 'this file — probe-id wiring',
      kind: 'STRUCTURAL',
      why: 'self-inspection, to prove each registered predicate is wired into a probe body rather than merely declared.',
    },
  ]

  it('every source read in this suite is classified', () => {
    // The durable guard. `readFileSync` is the only way this file reads source,
    // so its call count is the complete inventory. Adding a read without
    // classifying it fails here — which is the check that would have forced the
    // constant-versus-function question to be asked the first time.
    const reads = (selfSrc.match(/readFileSync\(/g) ?? []).length
    // One read may serve several classified subjects (the same file is parsed
    // for more than one property), so reads must not EXCEED the classification.
    expect(
      reads,
      `${reads} readFileSync call sites but only ${CLASSIFIED.length} classified subjects — classify the new one as STRUCTURAL or EXECUTED`,
    ).toBeLessThanOrEqual(CLASSIFIED.length)
    // ANTI-VACUITY: the audit must be describing a real, non-trivial inventory.
    expect(reads).toBeGreaterThan(5)
    expect(CLASSIFIED.length).toBeGreaterThan(5)
  })

  it('every EXECUTED subject is actually executed, not asserted on as a value', () => {
    // The two EXECUTED reads must reach a call. If either regressed into a
    // value comparison it would be the original error wearing the audit's
    // approval, so the calls are asserted to exist by name.
    expect(selfSrc).toMatch(/backendSelect\(/)
    expect(selfSrc).toMatch(/fn\(input\)/)
    const executed = CLASSIFIED.filter((c) => c.kind === 'EXECUTED')
    expect(executed.length).toBeGreaterThan(1)
    for (const c of executed) expect(c.why).toMatch(/CALLED|EXECUTED|return values/)
  })

  it('no probe asserts against the constant that misled it', () => {
    // Specific, because this exact constant produced a confident false positive.
    // It may be PARSED (the extracted function needs it injected) but must never
    // be the subject of an assertion about caveat behaviour.
    const seamStart = selfSrc.indexOf("describe('divergence/projection-completeness-seam'")
    expect(seamStart, 'the seam group is gone').toBeGreaterThan(-1)
    // Bounded to the group, not to end-of-file: an unbounded slice matched this
    // audit's OWN assertion text and failed on itself. A self-inspecting test
    // has to exclude itself from its own subject.
    const seamEnd = selfSrc.indexOf('\ndescribe(', seamStart + 10)
    const seam = selfSrc.slice(seamStart, seamEnd > 0 ? seamEnd : undefined)
    expect(seam).not.toMatch(/expect\([^)]*DIVERGENCE_IDENTITY_FIELDS/)
    expect(seam).not.toMatch(/BACKEND_FORCED/)
  })
})

describe('ledger/probe-liveness', () => {
  it('every probe predicate fires against the shape its defect actually had', () => {
    // If this fails, the probe is BLIND and the ledger's silence means nothing.
    // A contracts rename, a changed discriminant, or a dropped field all land
    // here rather than quietly turning the suite green.
    expect(PROBES.length, 'no probe predicates were registered').toBeGreaterThan(0)
    for (const p of PROBES) {
      expect(
        p.detects(p.mutant()),
        `PROBE ${p.id} IS DEAD: its predicate does not fire against the defect it was written for.\n  historically: ${p.wasReal}`,
      ).toBe(true)
    }
  })

  it('every probe predicate is DISCRIMINATING, not a constant true', () => {
    // A predicate that returns true for everything would pass the liveness test
    // while being useless. Each must reject a healthy subject.
    const healthy: Record<string, unknown> = {
      verdict: 'indeterminate',
      window: { runsAnalyzed: 25, runsScanned: 25 },
      fleetVerdict: 'indeterminate',
      adaptedVerdict: 'indeterminate',
      declaredNames: ['search'],
      provenKeys: [],
      toolName: 'github:search',
      claims: ['Called tool "github:search" with an argument object the target rejects'],
      resolved: null,
      budgetFindings: 0,
      serverSays: true,
      contractSays: true,
      targetSetReadable: true,
      targetSetSize: 3,
      recordedEventOfKind: true,
      uncoveredKinds: [],
    }
    for (const p of PROBES) {
      expect(p.detects(healthy), `PROBE ${p.id} fires on a healthy subject`).toBe(false)
    }
  })

  it('every registered probe id is unique and is referenced by a real probe', () => {
    const ids = PROBES.map((p) => p.id)
    expect(new Set(ids).size, 'duplicate probe ids').toBe(ids.length)
    const src = readFileSync(new URL(import.meta.url), 'utf8')
    for (const id of ids) {
      // The predicate must be WIRED INTO a probe body, not merely declared.
      const uses = src.split(`defect(PROBE_`).length - 1
      expect(uses, 'no probe body calls defect() through a registered predicate').toBeGreaterThan(0)
      expect(src).toContain(id)
    }
  })

  it('the ledger machinery itself records what it is given', () => {
    // Positive control for `defect()`: if this mechanism silently no-op'd, every
    // probe above would be reporting into a void.
    const before = observedDefects.length
    defect('self-test/ledger-machinery', { synthetic: true })
    expect(observedDefects).toContain('self-test/ledger-machinery')
    expect(ledgerEvidence.get('self-test/ledger-machinery')).toEqual({ synthetic: true })
    // Remove it again so the exact-set assertion is unaffected by this control.
    observedDefects.splice(observedDefects.indexOf('self-test/ledger-machinery'), 1)
    ledgerEvidence.delete('self-test/ledger-machinery')
    expect(observedDefects).toHaveLength(before)
  })
})
