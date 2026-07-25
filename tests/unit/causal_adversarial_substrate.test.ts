/**
 * CROSS-RUN CAUSAL GRAPH — ADVERSARIAL SUITE, SUBSTRATE LAYER (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * Not the causal feature's own code — the PRIMITIVES it has no choice but to
 * be built from. A traversal cannot be safer than its hop. Every one of the six
 * traps this feature is exposed to already has an instance in
 * `convex/schema.ts`, `convex/runs.ts` and `convex/retention.ts`, and those
 * three files are committed and settled while `apps/web/src/lib/causal/**` is
 * still being written. So this file grades the floor, and
 * `causal_adversarial_engine.test.ts` grades the walk that stands on it.
 *
 * ── THE DISCIPLINE THIS FILE IS UNDER ──────────────────────────────────────
 * Inherited verbatim from `fleet_adversarial_engine.test.ts`, whose header
 * records what four defects in one iteration actually cost:
 *
 *   CARE DOES NOT WORK. Every one of those four was a rule stated correctly by
 *   the same person who then applied it partially. What worked was (a) deleting
 *   the primitive that permits the wrong choice and (b) ENUMERATING SUBJECTS
 *   FROM THE SOURCE OR THE DATA rather than from a hand-maintained list.
 *
 *   A GENERALIZED ATTACK IS ONLY AS GENERAL AS ITS DIMENSIONS. The sweep that
 *   missed a defect was general over functions and blind over collections. It
 *   asked "does it throw" instead of "does it report".
 *
 * So: every sweep below derives its SUBJECTS by parsing the module under test.
 * Classifications are DECLARED in one table, and a subject that matches no
 * entry FAILS LOUDLY rather than being skipped. Adding a field, an index or a
 * query to the backend grades it here without this file changing — and leaves
 * this file red until someone says what the new thing is.
 *
 * ── WHAT IS CLAIMED HERE, AND A CORRECTION ────────────────────────────────
 * These are SOURCE-DERIVED findings. An earlier revision of this header said
 * behavioural Convex tests were IMPOSSIBLE from `tests/` because `convex-test`
 * needs `edge-runtime` and inlined deps from `convex/vitest.config.ts`. THAT
 * WAS FALSE, and it was false in this session's characteristic way: a config
 * file was read, a limit was inferred, and nothing was executed. A per-file
 * `@vitest-environment edge-runtime` docblock plus a relative
 * `import.meta.glob` boots the harness — see
 * `causal_adversarial_component.test.ts` and
 * `causal_adversarial_derived_index.test.ts`, which now carry every claim that
 * needs execution to be honest.
 *
 * What stays here is what source is genuinely the right evidence for: which
 * fields exist, which indexes are org-prefixed, which handlers authorize, and
 * which call sites carry a shape. A source-derived finding about a RETURN SHAPE
 * is decisive — a value never constructed cannot be observed by any caller.
 */

import { readdirSync, readFileSync } from 'node:fs'

import { isCausalTraversalComplete } from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import { foldCausalGraph } from '../../convex/helpers/causal_graph'

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const observedDefects = new Set<string>()
const record = (id: string): void => void observedDefects.add(id)

/**
 * LIVE DEFECTS. Not aspirational: each id below is RE-DERIVED by a test in this
 * file from parsed source, and would disappear from the ledger the moment the
 * underlying shape changes. The ledger assertion at the bottom is `toEqual`,
 * so a FIX turns this file red just as loudly as a REGRESSION does — which is
 * the point. Nobody gets to fix one of these quietly.
 */
const KNOWN_DEFECTS: readonly string[] = ['lost-trail/purge-leaves-a-dangling-parent-pointer']

/**
 * RETIRED, and retired on this suite's standard: each is expressed as a
 * POSITIVE assertion that the specific fix FIRES on the exact shape that used
 * to defeat it, never as "nothing was recorded". An `toEqual([])` ledger passes
 * just as happily when every probe has quietly stopped working.
 *
 *   fanout/child-hop-truncates-without-saying-so
 *     -> `listChildRuns` overfetches by one and returns `complete`/`truncated`/
 *        `nextCursor`. See `RETIRED: the down-hop now REPORTS its bound`.
 *   fanout/short-page-does-not-mean-complete
 *     -> the read moved to the org-prefixed `by_org_parent` index, so nothing
 *        is dropped after the take and a short page means the range ended. The
 *        post-filter is gone. See `RETIRED: a short page now genuinely means`.
 *
 * The remaining entry is NOT retired, and the distinction matters: it names the
 * DANGLE (purge deletes a run and never clears its children's `parentRunId`),
 * not the misreporting. The misreporting IS fixed — the walk folds an
 * unresolvable endpoint into a `LostTrail` rather than a shorter chain, which
 * `causal_adversarial_component.test.ts` verifies BY EXECUTION. The dangling
 * pointer itself is still created, so the entry stands.
 */

function srcOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

const SCHEMA = srcOf('../../convex/schema.ts')
const RUNS = srcOf('../../convex/runs.ts')
const RETENTION = srcOf('../../convex/retention.ts')

// ---------------------------------------------------------------------------
// Subject extraction — from the source, never from a list
// ---------------------------------------------------------------------------

/** The whole `runs: defineTable({...})...` section, indexes included. */
function runsTableSection(schema: string): string {
  const start = schema.indexOf('  runs: defineTable({')
  const end = schema.indexOf('\n  events: defineTable(', start)
  if (start < 0 || end < 0) throw new Error('could not locate the runs table in convex/schema.ts')
  return schema.slice(start, end)
}

/** Top-level field names of the runs table (4-space indent excludes nested objects). */
function runsTableFields(schema: string): string[] {
  const section = runsTableSection(schema)
  const body = section.slice(0, section.indexOf('\n  })'))
  return [...body.matchAll(/^ {4}(\w+): v\./gm)].map((m) => m[1] as string)
}

/** Every index on the runs table, as [name, fields]. */
function runsTableIndexes(schema: string): Array<[string, string[]]> {
  const section = runsTableSection(schema)
  return [...section.matchAll(/\.index\("(\w+)", \[([^\]]*)\]\)/g)].map((m) => [
    m[1] as string,
    [...(m[2] as string).matchAll(/"(\w+)"/g)].map((f) => f[1] as string),
  ])
}

interface ConvexFn {
  name: string
  kind: string
  body: string
}

/** Every exported query/mutation/action in a Convex module, with its full body. */
function convexFns(src: string): ConvexFn[] {
  const out: ConvexFn[] = []
  const header = /export const (\w+) = (query|mutation|internalQuery|internalMutation|action|internalAction)\(\{/g
  for (const m of src.matchAll(header)) {
    const from = m.index as number
    const next = src.indexOf('\nexport const ', from + 1)
    out.push({
      name: m[1] as string,
      kind: m[2] as string,
      body: src.slice(from, next < 0 ? src.length : next),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. INFERRED-AS-RECORDED: which stored fields may become an edge
// ---------------------------------------------------------------------------

/**
 * THE CATASTROPHIC DIRECTION. Two runs adjacent in time, sharing a session, or
 * touching one resource are NOT causally linked. The only defensible edge is
 * one a record asserts.
 *
 * DECLARED, and complete by construction: a runs-table field that matches no
 * entry fails the sweep by name. The point is not that this table is right
 * today — it is that a NEW field cannot slip into edge-eligibility unnoticed,
 * which is exactly how proximity becomes a link.
 */
type EdgeRole =
  /** Identifies the run or its tenancy. Never an edge between runs. */
  | 'identity'
  /** A stored assertion that ANOTHER RUN produced this one. The only edge source. */
  | 'recorded_causal_edge'
  /** Groups runs that ran near each other. Correlation. NEVER an edge. */
  | 'proximity_key'
  /** Says nothing about any other run at all. */
  | 'non_relational'

const EDGE_ROLES: Readonly<Record<string, EdgeRole>> = {
  orgId: 'identity',
  projectId: 'identity',
  agentId: 'identity',

  parentRunId: 'recorded_causal_edge',

  // Every one of these groups runs. NOT ONE of them says a run caused a run.
  agentVersionId: 'proximity_key',
  sessionId: 'proximity_key',
  otelTraceId: 'proximity_key',
  environment: 'proximity_key',
  labels: 'proximity_key',
  tags: 'proximity_key',
  triggeredBy: 'proximity_key',

  status: 'non_relational',
  startedAt: 'non_relational',
  endedAt: 'non_relational',
  metadata: 'non_relational',
  sdkVersion: 'non_relational',
  triageState: 'non_relational',
  tokensIn: 'non_relational',
  tokensOut: 'non_relational',
  searchText: 'non_relational',
  modelsSeen: 'non_relational',
  otelRoot: 'non_relational',
  otelRootStartNano: 'non_relational',
  otelMaxInstantNano: 'non_relational',
  derivedEventCount: 'non_relational',
  otelUnkeyedDerivedCount: 'non_relational',
  otelLastAppendAt: 'non_relational',
}

describe('edge-sources', () => {
  it('every runs-table field is classified, and a new one fails loudly', () => {
    const fields = runsTableFields(SCHEMA)
    // Anti-vacuity: the extractor must actually have found the table.
    expect(fields.length).toBeGreaterThan(20)
    expect(fields).toContain('parentRunId')
    expect(fields).toContain('sessionId')

    const unclassified = fields.filter((f) => EDGE_ROLES[f] === undefined)
    expect(unclassified).toEqual([])
  })

  it('the classification is not merely a relabelling of "has an id type"', () => {
    // TEETH. `agentVersionId` and `parentRunId` are both `v.id(...)` fields.
    // If the table had been filled in by pattern-matching on the type rather
    // than by asking what the field ASSERTS, these two would share a role.
    expect(EDGE_ROLES['agentVersionId']).toBe('proximity_key')
    expect(EDGE_ROLES['parentRunId']).toBe('recorded_causal_edge')
    expect(EDGE_ROLES['agentVersionId']).not.toBe(EDGE_ROLES['parentRunId'])
  })

  it('EXACTLY ONE field is a recorded run->run edge, and the data says which', () => {
    // Derived from the schema, not asserted from the table above: the only
    // self-referential foreign key in the runs table is the edge.
    const section = runsTableSection(SCHEMA)
    const body = section.slice(0, section.indexOf('\n  })'))
    const selfRefs = [...body.matchAll(/^ {4}(\w+): v\.(?:optional\(v\.)?id\("runs"\)/gm)].map((m) => m[1] as string)
    expect(selfRefs).toEqual(['parentRunId'])

    // ...and the declared table agrees with the data. Two independent
    // derivations of the same fact; they are asserted against each other.
    const declaredEdges = Object.entries(EDGE_ROLES)
      .filter(([, role]) => role === 'recorded_causal_edge')
      .map(([f]) => f)
    expect(declaredEdges.sort()).toEqual(selfRefs.sort())
  })

  it('the proximity keys really are stored on runs and really are not edges', () => {
    // Anti-vacuity: prove the proximity classification is about fields that
    // EXIST, so the set cannot be padded with names that were never there.
    const fields = new Set(runsTableFields(SCHEMA))
    const proximity = Object.entries(EDGE_ROLES)
      .filter(([, r]) => r === 'proximity_key')
      .map(([f]) => f)
    expect(proximity.length).toBeGreaterThan(4)
    for (const f of proximity) expect(fields.has(f)).toBe(true)

    // And none of them is a reference to another run — which is precisely why
    // a walk that follows one is inventing the link it reports.
    const section = runsTableSection(SCHEMA)
    for (const f of proximity) {
      const decl = new RegExp(`^ {4}${f}: v\\..*$`, 'm').exec(section)?.[0] ?? ''
      expect(decl.length).toBeGreaterThan(0)
      expect(decl).not.toContain('v.id("runs")')
    }
  })
})

// ---------------------------------------------------------------------------
// 2. DEPTH AND FAN-OUT: is the bound reported, or silent?
// ---------------------------------------------------------------------------

/**
 * The incident-time truncation problem. The graph is largest exactly when
 * someone needs it, and a walk down from a run uses ONE primitive to get a
 * run's children. If that primitive cannot say "there were more", then no
 * amount of care in the traversal above it can recover the fact.
 */

/** Classify a Convex function's paging posture from its own body. */
function pagingPosture(fn: ConvexFn): 'cursored' | 'capped' | 'single' {
  if (/\.paginate\(/.test(fn.body)) return 'cursored'
  if (/\.take\(/.test(fn.body)) return 'capped'
  return 'single'
}

/** Does the function hand the caller anything that could mean "there is more"? */
function reportsItsBound(fn: ConvexFn): boolean {
  const returns = [...fn.body.matchAll(/return \{[\s\S]*?\};/g)].map((m) => m[0]).join('\n')
  return /nextCursor|hasMore|Truncated|isDone|continueCursor/.test(returns)
}

/**
 * Every named function in a module — Convex entry points AND module-local
 * helpers, because authorization in this backend routinely happens one call
 * down (`resolveVersionPair`, `resolveReadApiKey`).
 */
function allNamedFns(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const header = /(?:export )?(?:async )?function (\w+)\(|export const (\w+) = (?:query|mutation|internalQuery|internalMutation|action|internalAction)\(\{/g
  const hits = [...src.matchAll(header)]
  hits.forEach((m, i) => {
    const name = (m[1] ?? m[2]) as string
    const from = m.index as number
    const to = i + 1 < hits.length ? (hits[i + 1] as RegExpMatchArray).index as number : src.length
    out.set(name, src.slice(from, to))
  })
  return out
}

/**
 * Every non-test backend module, enumerated from the FILESYSTEM.
 *
 * The auth closure below spans all of them, because a hand-picked module list
 * fails in exactly the way the closure's old hand-picked NAME list failed:
 * `resolveReadApiKey` delegates to `resolveApiKey` in another file, so a
 * closure scoped to four modules stopped one hop short and produced two more
 * false positives. Enumerating the backend removes the choice.
 */
function backendModules(): Array<[string, string]> {
  const roots = ['../../convex/', '../../convex/helpers/']
  const out: Array<[string, string]> = []
  for (const root of roots) {
    const dir = new URL(root, import.meta.url)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
      out.push([`${root}${f}`, readFileSync(new URL(f, dir), 'utf8')])
    }
  }
  return out
}

/**
 * The transitive closure of "functions that establish who the caller is",
 * seeded from the PRIMITIVES rather than from a list of helper names.
 */
function authorizingFunctions(modules: Array<[string, string]>): Set<string> {
  const defs = new Map<string, string>()
  for (const [, src] of modules) for (const [n, b] of allNamedFns(src)) defs.set(n, b)

  const PRIMITIVE = /ctx\.auth\.getUserIdentity\(|\.query\("api_keys"\)/
  const authorizers = new Set<string>()
  for (const [n, b] of defs) if (PRIMITIVE.test(b)) authorizers.add(n)

  // Fixpoint: anything that calls an authorizer is one.
  for (let changed = true; changed; ) {
    changed = false
    for (const [n, b] of defs) {
      if (authorizers.has(n)) continue
      if ([...authorizers].some((a) => new RegExp(`\\b${a}\\(`).test(b))) {
        authorizers.add(n)
        changed = true
      }
    }
  }
  return authorizers
}

/** Functions that hand back a SET of runs — i.e. anything a walk can hop with. */
function runSetQueries(src: string): ConvexFn[] {
  return convexFns(src).filter((f) => f.kind === 'query' && /return \{[\s\S]*?\bruns\b/.test(f.body))
}

describe('fan-out', () => {
  it('every run-set query is classified, and its bound-reporting is derived not assumed', () => {
    const qs = runSetQueries(RUNS)
    // Anti-vacuity: the extractor found real subjects.
    const names = qs.map((q) => q.name).sort()
    expect(names.length).toBeGreaterThanOrEqual(4)
    expect(names).toContain('listChildRuns')
    expect(names).toContain('listRuns')

    // Every subject lands in exactly one posture; nothing is skipped.
    for (const q of qs) expect(['cursored', 'capped', 'single']).toContain(pagingPosture(q))

    // The split is DERIVED. A cursored query reports its bound; a capped one
    // is only safe if it does too.
    const silentlyCapped = qs.filter((q) => pagingPosture(q) === 'capped' && !reportsItsBound(q)).map((q) => q.name)

    // ONCE a finding, now a retirement: `listChildRuns` is the only primitive
    // that turns a run into its children, and it has LEFT this list. The
    // enumeration below is what keeps that meaningful — a new silent hop
    // rejoins it and fails loudly.
    expect(silentlyCapped).not.toContain('listChildRuns')
    expect(silentlyCapped.length).toBeGreaterThan(0)
  })

  it('RETIRED: the down-hop now REPORTS its bound, and overfetches by one to know it', () => {
    // `fanout/child-hop-truncates-without-saying-so` is RETIRED. Expressed as a
    // POSITIVE assertion that the fix is present and load-bearing, never as
    // "nothing was recorded" — an absent probe would satisfy that just as well.
    const child = runSetQueries(RUNS).find((q) => q.name === 'listChildRuns')
    expect(child).toBeDefined()
    const body = (child as ConvexFn).body

    // The overfetch is what makes the distinction knowable at all: `limit + 1`
    // is the only way to tell "exactly `limit` children" from "at least
    // `limit`, and there are more".
    expect(body).toMatch(/\.take\(limit \+ 1\)/)
    expect(body).toMatch(/const truncated = page\.length > limit;/)
    // ...and all three signals reach the caller.
    expect(reportsItsBound(child as ConvexFn)).toBe(true)
    expect(body).toMatch(/complete: !truncated,/)
    expect(body).toMatch(/truncated,/)
    expect(body).toMatch(/nextCursor:/)

    // TEETH: the retirement's own probe can fail against a handler that lost
    // the property, so a green here is not a grep that matches anything.
    expect(reportsItsBound({ name: 'x', kind: 'query', body: 'return { runs };' })).toBe(false)
    expect(/\.take\(limit \+ 1\)/.test('.take(limit)')).toBe(false)
  })

  it('RETIRED: a short page now genuinely means the range ended', () => {
    // `fanout/short-page-does-not-mean-complete` is RETIRED, and the reason is
    // structural rather than cosmetic: the read moved to an ORG-PREFIXED index,
    // so a foreign child is not in the range at all and NOTHING is dropped
    // after the take. The post-filter that made a full page arrive short is
    // gone — asserted by its absence AND by the presence of what replaced it.
    const child = runSetQueries(RUNS).find((q) => q.name === 'listChildRuns') as ConvexFn
    expect(child.body).toMatch(/withIndex\("by_org_parent", \(q\) =>/)
    expect(child.body).toMatch(/q\.eq\("orgId", orgId\)\.eq\("parentRunId", args\.parentRunId\)/)
    // No filter between the take and the return any more.
    const takeIdx = child.body.indexOf('.take(limit + 1)')
    expect(takeIdx).toBeGreaterThan(0)
    expect(child.body.slice(takeIdx)).not.toMatch(/\.filter\(\(c\) => c\.orgId === orgId\)/)

    // The old unsoundness, kept as an executable REMINDER of what the fix buys.
    // Take-then-filter still confuses 350 children with 50; the shipped handler
    // no longer composes that way, which is the whole retirement.
    const takeThenFilter = (rows: string[], limit: number): string[] =>
      rows.slice(0, limit).filter((r) => r === 'mine')
    const LIMIT = 200
    expect(
      takeThenFilter([...Array<string>(50).fill('mine'), ...Array<string>(300).fill('foreign')], LIMIT).length
    ).toBe(takeThenFilter(Array<string>(50).fill('mine'), LIMIT).length)

    // ...and the shipped composition — overfetch, then slice, no filter —
    // reports the truncation those two populations differ by.
    const overfetchThenSlice = (n: number, limit: number): { runs: number; complete: boolean } => {
      const page = Math.min(n, limit + 1)
      const truncated = page > limit
      return { runs: truncated ? limit : page, complete: !truncated }
    }
    expect(overfetchThenSlice(350, LIMIT)).toEqual({ runs: 200, complete: false })
    expect(overfetchThenSlice(50, LIMIT)).toEqual({ runs: 50, complete: true })
  })

  it('the cursored siblings prove the repo CAN report a bound — so this WAS a choice', () => {
    // Anti-vacuity, and now also the standard the retirement above was held to.
    const cursored = runSetQueries(RUNS).filter((q) => pagingPosture(q) === 'cursored')
    expect(cursored.length).toBeGreaterThan(0)
    for (const q of cursored) expect(reportsItsBound(q)).toBe(true)
  })

  it('the silently-capped set is now enumerated, so a NEW silent hop fails here', () => {
    // The sweep that produced the retired findings, kept live and generalised.
    // Subjects come from the module; any run-set query that caps without
    // reporting is named. `listChildRuns` has left this list — and if a new
    // query joins it, this test says which one.
    const silentlyCapped = runSetQueries(RUNS)
      .filter((q) => pagingPosture(q) === 'capped' && !reportsItsBound(q))
      .map((q) => q.name)
      .sort()
    expect(silentlyCapped).not.toContain('listChildRuns')
    // Anti-vacuity: the classifier still finds capped queries at all, so the
    // exclusion above is a real result rather than an empty sweep.
    expect(runSetQueries(RUNS).filter((q) => pagingPosture(q) === 'capped').length).toBeGreaterThan(0)
    // The remaining silent ones, named rather than tolerated. These are not
    // causal hops — no traversal turns a run into other runs through them —
    // which is why they are reported here and not ledgered.
    expect(silentlyCapped).toEqual(['listSessionRuns', 'searchRuns'])
  })

  it('the posture classifier has teeth on synthetic subjects', () => {
    const fake = (body: string): ConvexFn => ({ name: 'x', kind: 'query', body })
    expect(pagingPosture(fake('.paginate({ numItems: 10 })'))).toBe('cursored')
    expect(pagingPosture(fake('.take(limit)'))).toBe('capped')
    expect(pagingPosture(fake('await ctx.db.get(id)'))).toBe('single')
    expect(reportsItsBound(fake('return { runs, nextCursor };'))).toBe(true)
    expect(reportsItsBound(fake('return { runs };'))).toBe(false)
    // ...and is not fooled by the word appearing outside the return shape.
    expect(reportsItsBound(fake('// nextCursor was removed\nreturn { runs };'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. CYCLES: is acyclicity ENFORCED, or merely BELIEVED?
// ---------------------------------------------------------------------------

/**
 * `convex/schema.ts` and `convex/runs.ts` both state that cycles are
 * "structurally impossible", resting on two premises: a parent must already
 * exist when the child names it, and `parentRunId` is NEVER MUTATED after
 * creation. The first is checked in code. The SECOND IS NOT CHECKED ANYWHERE —
 * it is a property of the current set of write sites.
 *
 * That is not a defect today. It is an unguarded premise, and the traversal
 * being built now is the first consumer that would loop forever if it broke.
 * So the sweep is over WRITE SITES, derived from source.
 */

/** Every place in convex/ that writes the parentRunId field. */
function parentRunIdWriteSites(src: string, file: string): Array<{ file: string; line: number; text: string }> {
  const lines = src.split('\n')
  const out: Array<{ file: string; line: number; text: string }> = []
  lines.forEach((text, i) => {
    // A write is `parentRunId:` appearing inside an insert/patch/replace object.
    if (!/^\s*parentRunId:/.test(text)) return
    const before = lines.slice(Math.max(0, i - 25), i).join('\n')
    if (/ctx\.db\.(insert|patch|replace)\(/.test(before)) out.push({ file, line: i + 1, text: text.trim() })
  })
  return out
}

describe('cycles', () => {
  it('the acyclicity claim is stated in source, so its premises are checkable', () => {
    expect(SCHEMA).toMatch(/Cycles are structurally impossible/)
    expect(RUNS).toMatch(/Cycles are structurally impossible/)
    expect(RUNS).toMatch(/parentRunId is never mutated after creation/)
  })

  it('EVERY parentRunId write in convex/ is an INSERT — the premise holds, and is now watched', () => {
    const files: Array<[string, string]> = [
      ['convex/runs.ts', RUNS],
      ['convex/sdk_ingest.ts', srcOf('../../convex/sdk_ingest.ts')],
      ['convex/otel_ingest.ts', srcOf('../../convex/otel_ingest.ts')],
      ['convex/retention.ts', RETENTION],
    ]
    const sites = files.flatMap(([f, s]) => parentRunIdWriteSites(s, f))

    // Anti-vacuity: an empty result would pass a "no patches" assertion just as
    // happily as a correct one. There must BE writes, and they must be inserts.
    expect(sites.length).toBeGreaterThan(0)

    const mutating = sites.filter((s) => {
      const src = files.find(([f]) => f === s.file)?.[1] ?? ''
      const before = src.split('\n').slice(Math.max(0, s.line - 26), s.line - 1).join('\n')
      return /ctx\.db\.(patch|replace)\(/.test(before)
    })
    // A patch or replace touching parentRunId would make a cycle constructible
    // and every claim of termination in the traversal above it unfounded.
    expect(mutating.map((m) => `${m.file}:${m.line}`)).toEqual([])
  })

  it('acyclicity is EMERGENT, not enforced — nothing checks for a cycle', () => {
    // The honest statement of the residual risk, asserted rather than asserted-
    // about. There is no visited-set, no depth guard, no ancestry check on the
    // run graph anywhere in the backend.
    expect(RUNS).not.toMatch(/visited/i)
    // The one depth bound in the repo is over EVENTS, not runs — so it does not
    // protect a run walk. Proven by locating it where it actually lives.
    const replay = srcOf('../../convex/helpers/replay_projection.ts')
    expect(replay).toMatch(/MAX_REPLAY_DEPTH/)
    expect(replay).toMatch(/parentEventId/)
    expect(RUNS).not.toMatch(/MAX_REPLAY_DEPTH/)
  })

  it('the write-site classifier flags a synthetic patch', () => {
    // TEETH: prove the sweep above would fire, rather than being always-green.
    const synthetic = [
      'export const relink = mutation({',
      '  handler: async (ctx, args) => {',
      '    await ctx.db.patch(args.runId, {',
      '      parentRunId: args.newParent,',
      '    });',
      '  },',
      '});',
    ].join('\n')
    const found = parentRunIdWriteSites(synthetic, 'synthetic.ts')
    expect(found.length).toBe(1)
    const before = synthetic.split('\n').slice(0, (found[0] as { line: number }).line - 1).join('\n')
    expect(/ctx\.db\.(patch|replace)\(/.test(before)).toBe(true)

    // ...and does NOT flag an insert, so it is not simply always-on.
    const insertOnly = synthetic.replace('ctx.db.patch(args.runId, {', 'ctx.db.insert("runs", {')
    const beforeInsert = insertOnly
      .split('\n')
      .slice(0, (parentRunIdWriteSites(insertOnly, 's.ts')[0] as { line: number }).line - 1)
      .join('\n')
    expect(/ctx\.db\.(patch|replace)\(/.test(beforeInsert)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. LOST TRAIL vs ORIGIN
// ---------------------------------------------------------------------------

/**
 * "The origin is run X" says the investigation is over. "We lost the trail at
 * X" says it is not. ADR-001 retention makes the second reachable TODAY and
 * gives it a shape nobody handles: a child whose `parentRunId` points at a run
 * that has been purged out from under it.
 */
describe('lost-trail', () => {
  it('DEFECT: purging a run leaves its children pointing at a document that is gone', () => {
    // The purge deletes the run document...
    expect(RETENTION).toMatch(/await ctx\.db\.delete\(runId\)/)

    // ...and nowhere in the whole backend is parentRunId ever cleared, so the
    // child keeps a pointer that no longer resolves. Derived, not assumed: if
    // ANY module patched the field to undefined, this would find it.
    const modules: Array<[string, string]> = [
      ['convex/retention.ts', RETENTION],
      ['convex/runs.ts', RUNS],
      ['convex/sdk_ingest.ts', srcOf('../../convex/sdk_ingest.ts')],
    ]
    const clears = modules.flatMap(([f, s]) =>
      [...s.matchAll(/parentRunId:\s*undefined/g)].map(() => f)
    )
    // `createRun` passes `args.parentRunId` through, which may be undefined —
    // that is construction, not repair. A literal clear would appear here.
    expect(clears).toEqual([])

    // The purge walks a documented dependency order and runs is not in it as a
    // REFERRER — only as the thing being deleted.
    expect(RETENTION).toMatch(/in dependency order/)
    expect(RETENTION).not.toMatch(/by_parent/)

    record('lost-trail/purge-leaves-a-dangling-parent-pointer')
  })

  it('a dangling pointer is INDISTINGUISHABLE from a live one at the field level', () => {
    // This is what makes the defect above a lost-trail defect rather than a
    // referential-integrity nit. The only up-hop available is `getRun`, and its
    // failure mode for a purged parent is identical to its failure mode for
    // another org's run: one message, deliberately.
    const getRun = convexFns(RUNS).find((f) => f.name === 'getRun')
    expect(getRun).toBeDefined()
    expect((getRun as ConvexFn).body).toMatch(/if \(!run \|\| run\.orgId !== orgId\) [\s\S]*?Run not found/)

    // So an up-walk sees exactly three states and can name only two of them:
    //   parentRunId absent            -> could be origin, could be uninstrumented
    //   parentRunId present, resolves -> a real hop
    //   parentRunId present, "not found" -> purged, OR another org's, OR never existed
    // The third collapses a data-lifecycle fact and a tenancy denial into one
    // string. An operator told "not found" cannot learn that the trail was
    // real and has been aged out.
    const notFoundSites = [...RUNS.matchAll(/Run not found/g)].length
    expect(notFoundSites).toBeGreaterThan(1)
  })

  it('nothing in the backend records a POSITIVE origin declaration', () => {
    // The UI's interim contract (apps/web/src/lib/causal/types.ts) states the
    // requirement outright: absence of an inbound edge is NOT an origin, and an
    // origin claim needs a record that licenses it. Confirm the backend does
    // not have one — so any "origin" a traversal reports today is inferred from
    // an absence, which is the exact conflation the feature exists to prevent.
    for (const s of [SCHEMA, RUNS]) {
      expect(s).not.toMatch(/originDeclar/i)
      expect(s).not.toMatch(/noCausalInput/i)
    }
    const fields = runsTableFields(SCHEMA)
    expect(fields.some((f) => /origin/i.test(f))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. TENANCY, HOP BY HOP
// ---------------------------------------------------------------------------

/**
 * Org isolation at the first hop is not isolation. The sharpest structural
 * hazard here is in the schema: `by_parent` is the ONLY index a down-hop can
 * use and it is NOT org-prefixed, so the index range physically spans every
 * tenant. Nothing about that is wrong on its own — it is wrong the moment a
 * caller forgets the post-filter, and the traversal being written now will
 * call it once per node.
 */
describe('tenancy', () => {
  it('the runs indexes split into org-ranged and cross-org, derived from the schema', () => {
    const idx = runsTableIndexes(SCHEMA)
    expect(idx.length).toBeGreaterThan(8)

    const crossOrg = idx.filter(([, fields]) => fields[0] !== 'orgId').map(([n]) => n)
    // Not asserted as a constant: `by_parent` is on this list because of what
    // the schema says, and it is the hop primitive's index.
    expect(crossOrg).toContain('by_parent')

    const byParent = idx.find(([n]) => n === 'by_parent')
    expect(byParent?.[1]).toEqual(['parentRunId'])
  })

  it('every use of a cross-org runs index re-establishes the org in the same handler', () => {
    // THE HOP-BY-HOP SWEEP. Subjects are the cross-org index names from the
    // schema; call sites are found by scanning the backend for them. Neither
    // side is a hand list, so a new cross-org index or a new call site is
    // graded without this file changing.
    //
    // THE FIRST VERSION OF THIS SWEEP REPORTED THREE FALSE POSITIVES, and it
    // did so in the exact shape this file's header warns about: the SUBJECTS
    // were derived from source, but the PREDICATE — "what counts as
    // authorizing" — was a hand-maintained list of helper names. It knew
    // `getAuthContext` and not `resolveVersionPair`, so three handlers that
    // authorize through one indirection were accused of not authorizing at
    // all. A generalized attack is only as general as its dimensions, and
    // the dimension I had not enumerated was the predicate's own vocabulary.
    //
    // So the auth vocabulary is now DERIVED TOO: seeded from the primitive
    // that actually establishes a caller (`ctx.auth.getUserIdentity`, or an
    // api-key row lookup) and closed transitively over every function that
    // calls one. A new auth helper is understood without this file changing.
    const crossOrg = runsTableIndexes(SCHEMA)
      .filter(([, f]) => f[0] !== 'orgId')
      .map(([n]) => n)
    expect(crossOrg.length).toBeGreaterThan(0)

    const modules = backendModules()
    expect(modules.length).toBeGreaterThan(10)

    const authorizers = authorizingFunctions(modules)
    // Anti-vacuity on the PREDICATE, in BOTH directions. A closure that found
    // nothing would make every handler look unguarded; one that matched
    // everything would make every handler look guarded. Both are asserted
    // against, including the two indirections that produced this sweep's
    // false positives (`resolveVersionPair`, `resolveReadApiKey`) and a pure
    // analysis function that must never be mistaken for authorization.
    expect(authorizers.has('getAuthContext')).toBe(true)
    expect(authorizers.has('requireOrgMembership')).toBe(true)
    expect(authorizers.has('resolveVersionPair')).toBe(true)
    expect(authorizers.has('resolveReadApiKey')).toBe(true)
    expect(authorizers.has('analyzeConfigPair')).toBe(false)
    expect(authorizers.has('computeCausalVerdict')).toBe(false)

    // THE THIRD DIMENSION THIS SWEEP WAS BLIND TO. Widening it to the whole
    // backend surfaced four more hits — and all four are `internal*`
    // functions invoked by crons, which have NO CALLER to authorize and which
    // legitimately span orgs (the stale-run sweep and the daily rollups are
    // exactly what `by_status_started` exists for). "Authorize the caller" is
    // not a question one can ask of them.
    //
    // They are therefore EXEMPT — but exempt by their DECLARATION KEYWORD,
    // read from source, never by name. A caller-facing `query` or `mutation`
    // cannot reach the exempt bucket however it is named, and a new cron is
    // exempted without this file changing.
    const CALLER_FACING = new Set(['query', 'mutation', 'action'])

    const unguarded: string[] = []
    const systemInvoked: string[] = []
    let inspected = 0
    for (const [file, src] of modules) {
      for (const fn of convexFns(src)) {
        for (const name of crossOrg) {
          if (!fn.body.includes(`withIndex("${name}"`)) continue
          inspected++
          if (!CALLER_FACING.has(fn.kind)) {
            systemInvoked.push(`${file}:${fn.name}:${fn.kind}`)
            continue
          }
          // The handler must both AUTHORIZE the caller and COMPARE an org.
          const authorizes = [...authorizers].some((a) => new RegExp(`\\b${a}\\(`).test(fn.body))
          const comparesOrg = /orgId !== |\.orgId === |eq\("orgId"/.test(fn.body)
          if (!authorizes || !comparesOrg) unguarded.push(`${file}:${fn.name}:${name}`)
        }
      }
    }

    // Anti-vacuity: the sweep must have found real call sites to grade, and
    // must have graded caller-facing ones rather than exempting them all.
    expect(inspected).toBeGreaterThan(8)
    expect(inspected - systemInvoked.length).toBeGreaterThan(3)

    // Every exemption is genuinely an internal declaration, re-derived here
    // from the keyword rather than taken from the loop's word for it.
    for (const s of systemInvoked) expect(s).toMatch(/:internal(Query|Mutation|Action)$/)

    // THE FINDING: no caller-facing handler walks a cross-org runs index
    // without both authorizing and comparing. Every hop is checked, not just
    // the first. This sweep found nothing — after three rounds of it finding
    // only its own blind spots.
    expect(unguarded).toEqual([])
  })

  it('the hop-by-hop sweep has teeth: a handler that skips the org check is caught', () => {
    // The counterweight to the fix above. Widening a predicate to silence
    // false positives is exactly how a sweep goes quietly blind, so prove the
    // widened one still fires on the thing it exists to catch.
    const authorizers = new Set(['getAuthContext'])
    const grade = (body: string): boolean => {
      const authorizes = [...authorizers].some((a) => new RegExp(`\\b${a}\\(`).test(body))
      const comparesOrg = /orgId !== |\.orgId === |eq\("orgId"/.test(body)
      return authorizes && comparesOrg
    }
    // A faithful down-hop: authorized, and filters its results.
    expect(
      grade('const { orgId } = await getAuthContext(ctx);\nreturn { runs: kids.filter((c) => c.orgId === orgId) };')
    ).toBe(true)
    // The breach: authorized once, then walks the un-prefixed index and hands
    // back whatever it found. This is the hop-by-hop failure in miniature.
    expect(grade('const { orgId } = await getAuthContext(ctx);\nreturn { runs: kids };')).toBe(false)
    // ...and an unauthenticated handler is caught even if it does compare.
    expect(grade('return { runs: kids.filter((c) => c.orgId === orgId) };')).toBe(false)
  })

  it('the down-hop now constrains its RESULTS IN THE INDEX RANGE, not by a post-filter', () => {
    // STRONGER than what this test used to assert. Checking the parent's org
    // authorizes the QUESTION; a post-filter constrained the ANSWER but only
    // after the take, which is what made a full page arrive short. The read is
    // now keyed `(orgId, parentRunId)`, so a foreign child is not in the range
    // at all — the constraint moved from after the bound to inside it.
    const child = convexFns(RUNS).find((f) => f.name === 'listChildRuns') as ConvexFn
    expect(child).toBeDefined()
    expect(child.body).toMatch(/withIndex\("by_org_parent", \(q\) =>/)
    expect(child.body).toMatch(/q\.eq\("orgId", orgId\)\.eq\("parentRunId", args\.parentRunId\)/)
    // The anchor check remains — both are required.
    expect(/if \(!parent \|\| parent\.orgId !== orgId\)/.test(child.body)).toBe(true)

    // Order matters: the caller is resolved BEFORE the parent is read, so a
    // cross-org parent id is not an existence oracle.
    const authIdx = child.body.indexOf('getAuthContext(ctx)')
    const readIdx = child.body.indexOf('ctx.db.get(args.parentRunId)')
    expect(authIdx).toBeGreaterThan(-1)
    expect(readIdx).toBeGreaterThan(authIdx)

    // And the index it relies on really is org-prefixed, per the schema.
    expect(runsTableIndexes(SCHEMA).find(([n]) => n === 'by_org_parent')?.[1]).toEqual(['orgId', 'parentRunId'])

    // TEETH.
    expect(/withIndex\("by_org_parent"/.test('withIndex("by_parent"')).toBe(false)
  })

})

// ---------------------------------------------------------------------------
// 6. VACUITY
// ---------------------------------------------------------------------------

/**
 * Completeness predicates built only from negative clauses have produced
 * defects in four layers of this repo. The run-graph substrate has the same
 * shape waiting: an isolated run, an empty child list, a graph of one node.
 */
describe('vacuity', () => {
  it('RETIRED: an empty child list now means exactly ONE thing', () => {
    // This used to be a vacuity finding: `{ runs: [] }` was produced by a real
    // leaf, by a full page of cross-org rows the post-filter ate, or by a cap —
    // three populations, one indistinguishable answer. With the org constraint
    // inside the index range and an explicit `complete` flag, an empty page
    // now says one thing and says it positively.
    const child = convexFns(RUNS).find((f) => f.name === 'listChildRuns') as ConvexFn
    expect(child.body).not.toMatch(/\.filter\(\(c\) => c\.orgId === orgId\)/)
    expect(child.body).toMatch(/complete: !truncated,/)

    // The shipped composition, modelled and executed: an empty result is
    // reported COMPLETE, and a clipped one is not — the two populations that
    // used to collide.
    const shipped = (childrenInOrg: number, limit: number) => {
      const page = Math.min(childrenInOrg, limit + 1)
      const truncated = page > limit
      return { runs: truncated ? limit : page, complete: !truncated }
    }
    expect(shipped(0, 200)).toEqual({ runs: 0, complete: true })
    expect(shipped(500, 200)).toEqual({ runs: 200, complete: false })
    // ...and the two are distinguishable, which is the whole retirement.
    expect(shipped(0, 200).complete).not.toBe(shipped(500, 200).complete)
  })

  it('THE FIFTH-LAYER SHAPE: inline `.every()` call sites, keyed on SYMBOLS not lines', () => {
    // The vacuity shape has appeared in five layers across three iterations.
    // My predicate sweep enumerates exported `is*Complete` FUNCTIONS, and all
    // but one of those five were an INLINE `.every()` at a call site, which an
    // export-level sweep is structurally blind to. This scans call sites.
    //
    // ── A LEDGER-HYGIENE CORRECTION, AND IT IS MINE ─────────────────────────
    // The first version of this sweep keyed its findings on `file:LINE`. One of
    // them moved from :787 to :803 because COMMENTS MOVED — the code was
    // untouched — and the entry went stale. A line number is a position, not a
    // property; keying on it makes every refactor a false positive. Findings
    // are now keyed `file::enclosingSymbol::receiver`, which survives anything
    // that does not change what the code DOES.
    const roots = ['../../convex/', '../../convex/helpers/', '../../packages/contracts/src/']
    const sites: string[] = []
    let totalEveryCalls = 0
    for (const root of roots) {
      const dir = new URL(root, import.meta.url)
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
        const src = readFileSync(new URL(f, dir), 'utf8')
        const lines = src.split('\n')
        totalEveryCalls += [...src.matchAll(/\w\??\.every\(/g)].length
        lines.forEach((line, i) => {
          if (/^\s*(\*|\/\/)/.test(line)) return
          const m = /(\w+)\??\.every\(/.exec(line)
          if (!m) return
          const recv = m[1] as string
          const win = lines.slice(Math.max(0, i - 25), i + 8).join('\n')
          const guarded =
            new RegExp(`${recv}[\\s\\S]{0,60}?\\.length\\s*(>|>=|!==|===)`).test(win) ||
            /\.length\s*>\s*0/.test(win) ||
            /\.length\s*===\s*0/.test(win)
          if (guarded) return
          // STABLE KEY: the nearest enclosing declaration, not a position.
          let symbol = '(top-level)'
          for (let j2 = i; j2 >= 0; j2--) {
            const d = /^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*[:=]|^ {2}(\w+):\s/.exec(
              lines[j2] as string
            )
            if (d) {
              symbol = (d[1] ?? d[2] ?? d[3]) as string
              break
            }
          }
          sites.push(`${root.replace('../../', '')}${f}::${symbol}::${recv}`)
        })
      }
    }

    // Anti-vacuity on the SWEEP: it must have found `.every()` calls at all,
    // or "two unguarded sites" would be an artefact of an empty scan.
    expect(totalEveryCalls).toBeGreaterThanOrEqual(8)

    // TWO remain, both `citations.every(...)` over a possibly-empty citation
    // array — and both are CONTAINED by a separate rule that rejects an empty
    // citation list outright (`edge_cites_nothing` in causality; the analogous
    // evidence rule in fleet_health). Named, not counted.
    expect(sites.sort()).toEqual([
      'packages/contracts/src/causality.ts::edgeIncoherences::citations',
      'packages/contracts/src/fleet_health.ts::scan::citations',
    ])

    // TEETH: the keying is genuinely position-independent. Inserting comment
    // lines shifts every line number and must not change a single key.
    const key = (src: string): string[] => {
      const lines = src.split('\n')
      const out: string[] = []
      lines.forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return
        const m = /(\w+)\??\.every\(/.exec(line)
        if (!m) return
        let symbol = '(top-level)'
        for (let j2 = i; j2 >= 0; j2--) {
          const d = /^(?:export )?(?:async )?function (\w+)/.exec(lines[j2] as string)
          if (d) {
            symbol = d[1] as string
            break
          }
        }
        out.push(`${symbol}::${m[1] as string}`)
      })
      return out
    }
    const before = 'function f() {\n  return xs.every(ok)\n}'
    const after = '// a new comment\n// and another\nfunction f() {\n  return xs.every(ok)\n}'
    expect(key(after)).toEqual(key(before))
    expect(key(before)).toEqual(['f::xs'])
  })


  it('RETIRED: the fold\'s `edgeSetsComplete` now carries its OWN positive clause', () => {
    // The sixth instance was `edgeSetsComplete: input.nodes.every(...)`, which
    // is `true` over an empty node set — a walk that visited nothing claiming
    // every edge set it read was read completely. It was CONTAINED, but by two
    // distant guards (an emitted `trail_lost` terminus, and `runsVisited > 0`
    // in the completeness predicate) rather than by anything local. Containment
    // at a distance is how the next refactor reintroduces a defect.
    //
    // It now carries its own positive clause, so the field is honest on its own
    // terms and no longer depends on two mechanisms in other files.
    const folded = foldCausalGraph({
      analyzedAt: 1,
      focusRunId: 'A',
      direction: 'upstream',
      nodes: [],
      edges: [],
      frontier: [],
      depthBudget: 8,
      nodeBudget: 200,
      fanoutBudget: 64,
      edgeBudget: 2_000,
      scanTruncated: false,
    } as never)

    // THE RETIREMENT, asserted positively on the exact empty-walk fixture.
    expect(folded.scan.runsVisited).toBe(0)
    expect(folded.scan.edgeSetsComplete).toBe(false)

    // The two distant containments still hold, and are still asserted — the
    // point of the fix is that they are no longer the ONLY thing standing
    // between an empty walk and a false clean.
    expect(folded.termini.length).toBeGreaterThan(0)
    expect(folded.termini.every((t) => t.terminus === 'trail_lost')).toBe(true)
    expect(isCausalTraversalComplete(folded)).toBe(false)
    expect(folded.verdict).toBe('indeterminate')

    // COUNTERWEIGHT: a real walk that DID read its edge sets in full still
    // reports `true`, so the new clause is not a blanket false.
    const real = foldCausalGraph({
      analyzedAt: 1,
      focusRunId: 'A',
      direction: 'upstream',
      nodes: [{ runId: 'A', agentId: 'ag', status: 'failed', startedAt: 1, expanded: true, onwardReadComplete: true, onwardCount: 0 }],
      edges: [],
      frontier: [],
      depthBudget: 8,
      nodeBudget: 200,
      fanoutBudget: 64,
      edgeBudget: 2_000,
      scanTruncated: false,
    } as never)
    expect(real.scan.runsVisited).toBe(1)
    expect(real.scan.edgeSetsComplete).toBe(true)
  })


  it('THE SIXTH DIMENSION: a defect with a TEST ASSERTING IT — partially reachable', () => {
    // The evals vacuity had a companion: `convex/helpers/evals.test.ts` carried
    // `it("handles an empty rule list as vacuously passing")` expecting
    // `overallPassed: true`. That is why it survived review — it did not look
    // like an oversight, it looked like a DECISION, with a name and a rationale.
    //
    // Every technique in these four files is blind to that. The call-site sweep
    // reads source, not tests. The behavioural suites assert what the code
    // does. A defect with a passing test that asserts it is, to all of them,
    // correct behaviour.
    //
    // IS IT DETECTABLE? PARTIALLY, AND THE HONEST ANSWER IS "AS A DETECTOR, NOT
    // A GATE". A broad detector — "test whose subject is empty and whose
    // assertion certifies" — returns 48 candidates on this repo, almost all of
    // them legitimate (an empty input with a correctly-earned answer). Gating
    // on that number would be exactly the false-positive generator the
    // line-number keying already proved I am prone to.
    //
    // What IS gateable is the HIGH-SIGNAL form, which is how the real one
    // announced itself: a test name that says the certification is VACUOUS.
    // An author who writes that word has stated the defect in the test's own
    // title, and no legitimate assertion needs it.
    const testFiles: Array<[string, string]> = []
    for (const root of ['../../convex/', '../../convex/helpers/', '../../tests/unit/']) {
      const dir = new URL(root, import.meta.url)
      for (const f of readdirSync(dir)) {
        if (!/\.test\.tsx?$/.test(f)) continue
        // Skip THIS file: it contains the scanning regex as a string literal,
        // which its own scan matches. A sweep that reports itself is noise.
        if (f === 'causal_adversarial_substrate.test.ts') continue
        testFiles.push([`${root}${f}`, readFileSync(new URL(f, dir), 'utf8')])
      }
    }
    // Anti-vacuity: the sweep must have found test files and test cases.
    expect(testFiles.length).toBeGreaterThan(50)

    const CERTIFIES =
      /toBe\(true\)|toBe\('(isolated|healthy|passed|ok)'\)|(overallPassed|complete|passed|valid|trustworthy)\s*:\s*true/
    // FIRST CUT OF THIS DETECTOR HAD ZERO PRECISION: two candidates, both
    // false. One was THIS FILE matching its own scanning regex; the other was
    // `otel_ordering_adversarial.test.ts`'s "...so no case is silently
    // vacuous" — an ANTI-vacuity name. Same lesson a third time: I wrote the
    // check in the direction of my own belief and did not run it before
    // believing it.
    //
    // The discriminator is the POLARITY of the word. The evals test said the
    // certification WAS vacuous and asserted it as correct. Every legitimate
    // use says something is NOT vacuous.
    const NEGATED = /\bno\b|\bnot\b|\bnever\b|n't\b|\bwould\b/i
    const detect = (name: string, body: string): boolean =>
      /vacuous/i.test(name) && !NEGATED.test(name) && CERTIFIES.test(body)

    const offenders: string[] = []
    let casesScanned = 0
    for (const [file, src] of testFiles) {
      const re = /\bit\(\s*(['"`])([\s\S]*?)\1\s*,/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        casesScanned++
        const name = m[2] as string
        const start = m.index
        const next = src.indexOf('\n  it(', start + 5)
        const body = src.slice(start, next < 0 ? Math.min(src.length, start + 2600) : next)
        if (detect(name, body)) offenders.push(`${file} :: ${name.slice(0, 80)}`)
      }
    }
    expect(casesScanned).toBeGreaterThan(500)

    // Currently clean. Every occurrence of "vacuous" in this repo's tests is
    // now in an ANTI-vacuity guard, never in a certifying assertion.
    expect(offenders).toEqual([])

    // TEETH, AND THIS IS THE WHOLE VALUE OF THE TEST. The detector is run
    // against the EXACT assertion that shipped the evals defect, quoted from
    // the replacement test's own comment. If the detector could not catch the
    // one instance we know existed, "currently clean" would mean nothing.
    const historical = "handles an empty rule list as vacuously passing"
    expect(detect(historical, "expect(result.overallPassed).toBe(true);")).toBe(true)
    // ...and it does NOT fire on the corrected version, so it is not simply
    // matching the word wherever it appears.
    expect(detect('does NOT treat an empty rule list as passing', 'expect(result.overallPassed).toBe(false);')).toBe(
      false
    )
    // ...nor on an anti-vacuity guard that legitimately certifies something else.
    expect(detect('no predicate is vacuously true on an empty walk', 'expect(x.complete).toBe(false)')).toBe(false)
    // ...nor on the real anti-vacuity name that defeated the first cut, even
    // though its BODY does certify.
    expect(
      detect('the mapper reports a temporal instant, so no case is silently vacuous', 'expect(ok).toBe(true)')
    ).toBe(false)

    // The historical assertion is quoted in the replacement, which is what
    // makes this teeth-case anchorable rather than folklore. Assert the anchor
    // still exists, so a future edit that drops the quote is noticed.
    expect(srcOf('../../convex/helpers/evals.test.ts')).toContain('vacuously passing')
    expect(srcOf('../../convex/helpers/evals.test.ts')).toContain('PREVIOUSLY ASSERTED THE OPPOSITE')
  })

  it('ATTACK on the chosen fix: `false` for "nothing ran" now DISAGREES with the reader', () => {
    // Team A flagged this as a judgement call, so it gets attacked rather than
    // accepted. On zero rules `overallPassed` is now `false`. That is not a
    // failure — nothing was tested — and `false` was chosen as the safe
    // direction, which is right on its own terms: a false PASS certifies a bad
    // run as good, a false FAIL is noisy and visible.
    //
    // THE FINDING IS NOT THE DIRECTION, IT IS THE DISAGREEMENT. The same
    // question — "did the evals pass?" — is now answered in two different
    // representations at two layers:
    const primitive = srcOf('../../convex/helpers/evals.ts')
    const reader = srcOf('../../convex/insights.ts')

    // The PRIMITIVE is two-valued and folds "nothing ran" into `false`...
    expect(primitive).toMatch(/overallPassed: boolean;/)
    expect(primitive).toMatch(/overallPassed: results\.length > 0 && results\.every/)
    // ...while the READER is three-valued and gives "nothing ran" its own word.
    expect(reader).toMatch(/overallPassed: boolean \| null;/)
    expect(reader).toMatch(/overallPassed: rows\.length > 0 \? failed === 0 : null/)

    // Both carry the POSITIVE clause, which is the part that matters and which
    // both got right. What differs is the ENCODING of the third state, under
    // one field name, across a layer boundary — the type-conflation shape this
    // repo has an entire test file about elsewhere.
    //
    // The consequence is concrete: a caller cannot write one predicate. Modelled
    // and executed rather than described, because the two encodings are the
    // whole point.
    const primitiveSaysFailing = (overallPassed: boolean): boolean => overallPassed === false
    const readerSaysFailing = (overallPassed: boolean | null): boolean => overallPassed === false
    // Nothing ran, as each layer reports it:
    expect(primitiveSaysFailing(false)).toBe(true) // FALSE ALARM
    expect(readerSaysFailing(null)).toBe(false) // correct
    // A genuine failure, as each layer reports it — indistinguishable at the
    // primitive from the case above.
    expect(primitiveSaysFailing(false)).toBe(true)
    expect(readerSaysFailing(false)).toBe(true)

    // THE MITIGATION IS REAL AND IS ASSERTED, which is why this is a residual
    // and not a ledgered defect: `rulesEvaluated` is REQUIRED, so the
    // information is never lost, and the one production caller guards on it
    // before either value can be read.
    expect(primitive).toMatch(/rulesEvaluated: number;/)
    expect(reader).toMatch(/result\.rulesEvaluated === 0/)
    expect(reader).toMatch(/reason: "no_rules"/)

    // The residual: `rulesEvaluated` is a SECOND field a caller must remember
    // to read, and "a rule applied at N call sites" is the shape that has now
    // produced defects in six layers of this repo. The reader's `boolean | null`
    // needs no such discipline — the third state is unspellable as a boolean.
    // TEETH on the source probes.
    expect(/overallPassed: boolean \| null;/.test('overallPassed: boolean;')).toBe(false)
  })

  it('HANDOFF: the causal contract HAS landed, so the vacuity attack moves up a layer', () => {
    // This started as a standing guard asserting the contract did not exist.
    // It fired mid-session, which is what it was for. Rather than delete it —
    // deleting a guard that fired is how a suite goes quietly green — it is
    // inverted into the handoff it always implied: the contract is here, it
    // exports a completeness predicate, and grading THAT is
    // `causal_adversarial_engine.test.ts`'s job.
    const contractsIndex = srcOf('../../packages/contracts/src/index.ts')
    expect(contractsIndex).toMatch(/export \* from "\.\/causality\.js";/)

    const causality = srcOf('../../packages/contracts/src/causality.ts')
    expect(causality).toMatch(/export function isCausalTraversalComplete/)

    // The substrate findings above are about the backend floor and remain
    // valid regardless: the contract cannot report a bound the hop never gave
    // it. Named here so the two files are read together.
    expect(srcOf('./causal_adversarial_engine.test.ts')).toContain('isCausalTraversalComplete')
  })

  it('SCOPE: the backend walk has landed, and it does NOT inherit two of the three findings', () => {
    // Honesty about blast radius, which is what makes the other findings
    // usable. `convex/causality.ts` arrived mid-session and deliberately
    // ROUTES AROUND two of this file's defects rather than inheriting them:
    //
    //   fanout/*  — the walk does not call `listChildRuns`. It uses its own
    //               org-prefixed `by_org_parent` read with a per-node fan-out
    //               budget it REPORTS (`fanoutTruncatedAt`). The
    //               `listChildRuns` findings remain true OF `listChildRuns`,
    //               which the run-detail page still calls.
    //   lost-trail/* — the dangling pointer is still created by the purge, but
    //               the walk observes every hop through an org check and folds
    //               an unresolvable endpoint into an `AbsentCausalLink` rather
    //               than an origin.
    //
    // All three findings stand as statements about the primitives. Only their
    // reach into the causal feature is narrowed, and it is narrowed HERE
    // rather than left for a reader to discover.
    const walk = srcOf('../../convex/causality.ts')
    expect(walk).toMatch(/withIndex\("by_org_parent"/)
    expect(walk).not.toMatch(/listChildRuns/)

    // A PREVIOUS REVISION OF THIS TEST GREPPED FOR `fanoutTruncatedAt`, a field
    // from a superseded draft of the walk. That is the constant-versus-function
    // failure in its grep form: the string was never the property, and once the
    // field was renamed the probe was asserting the existence of something that
    // had never shipped. The bound-reporting claim is now made where it can
    // only be made honestly — against the walk's OUTPUT, in
    // `causal_adversarial_component.test.ts`, which drives a real fan-out past
    // the budget and reads what comes back.
    expect(srcOf('./causal_adversarial_component.test.ts')).toContain('budget_exhausted')

    // What IS safely source-derived: the tenancy and termination structure.
    expect(walk).toMatch(/if \(!run \|\| run\.orgId !== orgId\) return null;/)
    expect(walk).toMatch(/observeRun\(ctx, [\w.]+, [\w.]+\)/)
    expect(walk).toMatch(/visited\.has\(/)

    // The index it relies on is org-prefixed — unlike `by_parent`, which is
    // what made this file's tenancy section necessary in the first place.
    const orgParent = runsTableIndexes(SCHEMA).find(([n]) => n === 'by_org_parent')
    expect(orgParent?.[1]).toEqual(['orgId', 'parentRunId'])

    // TEETH on these greps.
    expect(/listChildRuns/.test('const { runs } = await listChildRuns(id)')).toBe(true)
    expect(/fanoutTruncatedAt/.test('// budget hit, said nothing')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LEDGER
// ---------------------------------------------------------------------------

describe('defect ledger', () => {
  it('observed defects are EXACTLY the known set', () => {
    // `toEqual`, deliberately. A FIX turns this red just as loudly as a
    // regression — the ledger is a record of what is true, not a floor.
    expect([...observedDefects].sort()).toEqual([...KNOWN_DEFECTS].sort())
  })

  it('every ledgered defect was recorded by a test that derived it, not by a constant', () => {
    const self = srcOf('./causal_adversarial_substrate.test.ts')
    for (const id of KNOWN_DEFECTS) {
      // Each id appears twice: once in KNOWN_DEFECTS, once at its `record(...)`
      // call inside the test that derives it from parsed source.
      expect(self.split(`'${id}'`).length - 1).toBeGreaterThanOrEqual(2)
      expect(self).toContain(`record('${id}')`)
    }
  })
})
