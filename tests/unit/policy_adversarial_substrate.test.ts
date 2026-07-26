/**
 * DECLARATIVE TOOL POLICY — ADVERSARIAL SUITE, SUBSTRATE LAYER (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * The two properties that must hold for a policy engine to be safe to build at
 * all, both of which are decidable TODAY against the shipped substrate, before
 * a single line of policy code exists:
 *
 *   §1  THE RULING. A policy engine inside a RECORDER must never refuse to
 *       record a violation. This file pins the ingest accept-set as it stands
 *       and proves, by execution and by import closure, that nothing on the
 *       write path can consult a policy.
 *
 *   §2  `not_evaluable` MUST NOT BE `satisfied`. Event Log Rule 3 externalizes
 *       any payload over 10 KB. A `tool.call` that externalizes KEEPS its type
 *       and LOSES its name. A policy about tool names is therefore structurally
 *       unevaluable over exactly the runs with the biggest payloads — and the
 *       runs with the biggest payloads are not a random sample.
 *
 * WHY THIS FILE IS STILL SUBSTRATE-ONLY NOW THAT THE ENGINE EXISTS
 * It was written before `convex/helpers/policy.ts` landed, against
 * `packages/sdk/src/externalize.ts` and `convex/helpers/divergence.ts`, both of
 * which shipped already. It stays that way deliberately: these are facts about
 * the GROUND the engine stands on — what the recorder accepts, and what
 * Event Log Rule 3 destroys — and they must keep holding whatever the engine
 * does next. The engine itself is graded in
 * `policy_adversarial_engine.test.ts`, and the ingest ruling behaviourally in
 * `policy_adversarial_ingest.test.ts`.
 *
 * Every assertion below executes a real function and grades its OUTPUT.
 *
 * THE LESSON THIS SUITE CARRIES FORWARD
 * From `tests/unit/budget_adversarial_engine.test.ts`: this session's most
 * useful finding was that three of my own checks were written in the direction
 * of my own belief and execution caught all three. AN ADVERSARIAL SUITE IS NOT
 * EXEMPT FROM THE FAILURE IT HUNTS. Concretely, applied here:
 *
 *   - Every "the engine reports a gap" assertion is paired with a TEETH
 *     assertion proving the same probe reports NO gap on the honest fixture.
 *     A probe that always fires is not a probe.
 *   - Subjects are enumerated from source or from a function's output. The one
 *     place a literal list appears (`INGEST_REJECTION_REASONS`) is compared
 *     with `toEqual`, so it goes red on ADDITION as loudly as on removal — it
 *     is a ledger, not a filter.
 */
import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'

import { describe, it, expect } from 'vitest'

import { extractRunObservation } from '../../convex/helpers/divergence.js'
import { externalizePayloadIfLarge, payloadByteLength } from '../../packages/sdk/src/externalize.js'

import type { ObservableEvent } from '../../convex/helpers/divergence.js'
import type { ArtifactPointer } from '../../packages/sdk/src/externalize.js'

const REPO = path.resolve(__dirname, '../..')

function srcOf(rel: string): string {
  const abs = path.join(REPO, rel)
  return readFileSync(abs, 'utf8')
}

// ===========================================================================
// SUBJECT DISCOVERY — from the filesystem, never from a hand list.
//
// The policy feature is being built by three other teams while this file is
// written. Nothing below names a policy file: the policy module set is
// DISCOVERED, so a module added after this file was written is attacked
// automatically and a module renamed does not silently drop out of scope.
// ===========================================================================

const SOURCE_ROOTS = [
  'convex',
  'convex/helpers',
  'packages/contracts/src',
  'packages/sdk/src',
  'packages/cli/src',
  'packages/mcp/src',
]

/** Every non-test `.ts` module under the scanned roots, repo-relative. */
function allSourceModules(): string[] {
  const out: string[] = []
  for (const root of SOURCE_ROOTS) {
    const abs = path.join(REPO, root)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.test.ts')) continue
      out.push(path.posix.join(root, entry.name))
    }
  }
  return out.sort()
}

/**
 * Modules that are part of the policy feature, identified by name.
 *
 * Deliberately a SUBSTRING match on the module basename rather than a list of
 * filenames: `policy.ts`, `policies.ts`, `tool_policy.ts`, `policy_engine.ts`
 * and `policy_eval.ts` are all plausible and all caught. The one name this
 * MUST NOT match is `BudgetUnavailablePolicy`, which is a type inside
 * `budgets.ts` and not a module — matching on basename, not on file content,
 * is what keeps that out.
 */
function policyModules(): string[] {
  return allSourceModules().filter((m) => /polic/i.test(path.basename(m)))
}

// ---------------------------------------------------------------------------
// Import-closure walker. Convex modules import siblings as `"./x.js"` and
// helpers as `"./helpers/x.js"`; the `.js` specifier resolves to the `.ts`
// file on disk.
// ---------------------------------------------------------------------------

function importSpecifiers(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) out.push(m[1] as string)
  return out
}

/** Resolve a relative specifier from `fromModule` (repo-relative) to a repo-relative `.ts` path, or null. */
function resolveRelative(fromModule: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const dir = path.posix.dirname(fromModule)
  const joined = path.posix.normalize(path.posix.join(dir, spec))
  const candidates = [joined.replace(/\.js$/, '.ts'), `${joined}.ts`, path.posix.join(joined, 'index.ts')]
  for (const c of candidates) {
    if (existsSync(path.join(REPO, c))) return c
  }
  return null
}

/** Transitive closure of local (relative) imports, INCLUDING the entry points. */
function importClosure(entryPoints: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...entryPoints]
  while (queue.length > 0) {
    const mod = queue.shift() as string
    if (seen.has(mod)) continue
    if (!existsSync(path.join(REPO, mod))) continue
    seen.add(mod)
    for (const spec of importSpecifiers(srcOf(mod))) {
      const resolved = resolveRelative(mod, spec)
      if (resolved !== null) queue.push(resolved)
    }
  }
  return seen
}

// ===========================================================================
// §1 — THE RULING: DEFINING A POLICY MUST NOT MAKE THE RECORDER BLIND
// ===========================================================================

/**
 * The write path. Every door through which a recorded event enters the system.
 *
 * DISCOVERED, not listed: any Convex module exporting a mutation whose handler
 * inserts into the `events` table is an ingest door. Asserted non-empty and
 * asserted to contain the two doors we know about, so a rename cannot silently
 * empty this set.
 */
function ingestModules(): string[] {
  return allSourceModules().filter((m) => {
    if (!m.startsWith('convex/')) return false
    const src = srcOf(m)
    return /export const \w+ = (?:internal)?mutation\(/.test(src) && /db\.insert\(\s*["']events["']/.test(src)
  })
}

describe('§1 THE RULING — a policy may never make a violating event harder to record', () => {
  it('the write path is discovered from source and is not empty (teeth)', () => {
    const doors = ingestModules()
    expect(doors.length).toBeGreaterThan(0)
    // If either of these stops being an ingest door, the discovery predicate
    // has drifted and every assertion below it is measuring nothing.
    expect(doors).toContain('convex/sdk_ingest.ts')
    expect(doors).toContain('convex/events.ts')
  })

  it('the import closure walker actually resolves imports (teeth)', () => {
    const closure = importClosure(['convex/sdk_ingest.ts'])
    // The entry point plus at least its own helpers. A walker that resolved
    // nothing would return a 1-element set and make §1's real assertion vacuous.
    expect(closure.size).toBeGreaterThan(3)
    expect(closure).toContain('convex/sdk_ingest.ts')
    expect(closure).toContain('convex/helpers/errors.ts')
  })

  it('NO ingest door can reach a policy module, transitively', () => {
    const policy = policyModules()
    const closure = importClosure(ingestModules())
    const reachable = policy.filter((p) => closure.has(p))
    // The message names the offender rather than asserting a bare boolean, so
    // a failure is a bug report rather than a puzzle.
    expect({ policyModulesReachableFromIngest: reachable }).toEqual({ policyModulesReachableFromIngest: [] })
  })

  /**
   * THE LEDGER. Every distinct TYPED refusal the SDK ingest module can raise,
   * extracted from its source. Compared with `toEqual`, so a NEW reason —
   * `POLICY_VIOLATION`, say — turns this file red and has to be argued for.
   *
   * This is the standing proof the brief asks for: the accept-set may not
   * shrink because a policy was defined.
   *
   * SCOPE IS THE MODULE, NOT ONE MUTATION, and deliberately: `sdk_ingest.ts`
   * also carries the artifact-upload and eval-record doors, and a policy check
   * bolted onto the artifact upload would starve the event path just as
   * effectively as one bolted onto `sdkCreateEvents` (Event Log Rule 3 routes
   * every oversized payload through it). Hence `ARTIFACT_LIMIT_EXCEEDED` and
   * `INVALID_ARGUMENT` belong here.
   *
   * THIS LIST WAS WRONG WHEN FIRST WRITTEN — hand-transcribed from a grep and
   * missing two members — and the assertion below caught it. Recorded rather
   * than quietly corrected, because it is the same failure this suite hunts:
   * a check written in the direction of its author's belief. Do not replace
   * this with a list; replace it only by re-running the extractor.
   */
  const INGEST_REJECTION_REASONS: readonly string[] = [
    'ARTIFACT_LIMIT_EXCEEDED',
    'EVENT_LIMIT_EXCEEDED',
    'INVALID_ARGUMENT',
    'RATE_LIMITED',
    'RUN_NOT_ACTIVE',
    'SEQUENCE_CONFLICT',
  ].sort()

  it('the set of TYPED ingest refusals is unchanged (ledger — red on addition too)', () => {
    const src = srcOf('convex/sdk_ingest.ts')
    const found = [...src.matchAll(/afrError\(\s*"([A-Z_]+)"/g)].map((m) => m[1] as string)
    const unique = [...new Set(found)].sort()
    expect(unique.length).toBeGreaterThan(0) // teeth: the extractor found something
    expect(unique).toEqual([...INGEST_REJECTION_REASONS])
  })

  it('no ingest door mentions policy in any form', () => {
    // The cheap complement to the import-closure check: a policy consulted via
    // a string key, a dynamic import, or an inlined predicate would evade the
    // closure walker but not this. Both are needed; neither is sufficient.
    const offenders = ingestModules().filter((m) => /\bpolic(y|ies)\b/i.test(srcOf(m)))
    expect({ ingestModulesMentioningPolicy: offenders }).toEqual({ ingestModulesMentioningPolicy: [] })
  })
})

// ===========================================================================
// §2 — `not_evaluable` IS NOT `satisfied`
//
// The substrate fact, established by EXECUTING the shipped code rather than by
// reading its doc comments.
// ===========================================================================

const FORBIDDEN_TOOL = 'prod-db:delete_all_rows'

const POINTER: ArtifactPointer = {
  artifactId: 'art_1',
  storageKey: 'k',
  storageBucket: 'b',
  checksum: 'sha256:abc',
  size: 999_999,
}

/** A real `tool.call` payload naming the forbidden tool, sized by `padBytes`. */
function toolCallPayload(padBytes: number): Record<string, unknown> {
  return {
    type: 'tool.call',
    name: FORBIDDEN_TOOL,
    call_id: 'call_1',
    input: { sql: 'x'.repeat(padBytes) },
  }
}

async function externalize(payload: unknown): Promise<unknown> {
  return await externalizePayloadIfLarge('run_1', 'tool.call', payload, async () => POINTER)
}

describe('§2 the recorded evidence for a tool-name policy is destroyed by Event Log Rule 3', () => {
  it('TEETH — a SMALL tool.call keeps its name through the externalization decision', async () => {
    const small = toolCallPayload(10)
    expect(payloadByteLength(JSON.stringify(small))).toBeLessThan(10 * 1024)
    const stored = await externalize(small)
    // The name survives, so the probe below is capable of finding a name at all.
    expect(JSON.stringify(stored)).toContain(FORBIDDEN_TOOL)
  })

  it('a LARGE tool.call loses the tool name entirely — the policy subject is gone', async () => {
    const large = toolCallPayload(20 * 1024)
    expect(payloadByteLength(JSON.stringify(large))).toBeGreaterThan(10 * 1024)
    const stored = await externalize(large)

    // The whole stored record, serialized. Not a field-by-field check: the
    // question is whether the name survives ANYWHERE the engine could read it.
    expect(JSON.stringify(stored)).not.toContain(FORBIDDEN_TOOL)
    // And what DID survive is the event type — so the engine knows a tool was
    // called and cannot know which. This is the exact `not_evaluable` shape.
    expect(stored).toMatchObject({ type: '_externalized', originalType: 'tool.call' })
  })

  it('the ONE salvage field the SDK preserves is errorSummary, and it is run.failed-only', async () => {
    // Enumerated from the function's OUTPUT, not from its source comment: the
    // keys an externalized envelope can carry. If a future change adds a
    // `toolName` salvage sibling, this goes red and §2's premise is retired —
    // which would be excellent news and must not happen silently.
    const withSummary = await externalizePayloadIfLarge(
      'run_1',
      'run.failed',
      { type: 'run.failed', errorSummary: 'boom', error: { message: 'x'.repeat(20 * 1024) } },
      async () => POINTER,
    )
    const toolCallKeys = Object.keys((await externalize(toolCallPayload(20 * 1024))) as object).sort()
    const failedKeys = Object.keys(withSummary as object).sort()

    expect(toolCallKeys).toEqual(['_artifact', 'originalType', 'type'])
    expect(failedKeys).toEqual(['_artifact', 'errorSummary', 'originalType', 'type'])
    // The salvage set for a tool.call is EMPTY.
    expect(failedKeys.filter((k) => !toolCallKeys.includes(k))).toEqual(['errorSummary'])
  })
})

// ===========================================================================
// §2b — THE STANDARD THE POLICY ENGINE MUST MEET, EXECUTED ON THE SUBSTRATE
//
// `extractRunObservation` already faces this exact problem for the divergence
// feature and answers it honestly. It is the reference: absence of evidence is
// recorded as a GAP, never folded into "no tool calls".
// ===========================================================================

function eventsWith(payload: unknown): ObservableEvent[] {
  return [
    { type: 'run.started', sequenceNumber: 1, payload: { type: 'run.started', input: {}, config: {} } },
    { type: 'tool.call', sequenceNumber: 2, payload },
  ]
}

describe('§2b the shipped reference treats an unreadable tool name as a GAP, not as absence', () => {
  it('TEETH — an inline tool.call yields a NAMED observation and NO gap', () => {
    const obs = extractRunObservation(eventsWith(toolCallPayload(10)))
    expect(obs.toolCalls.map((t) => t.name)).toEqual([FORBIDDEN_TOOL])
    expect(obs.unnamedToolCallSeqs).toEqual([])
    expect(obs.gaps).toEqual([])
  })

  it('an externalized tool.call yields ZERO named calls but is NOT reported as zero calls', async () => {
    const stored = await externalize(toolCallPayload(20 * 1024))
    const obs = extractRunObservation(eventsWith(stored))

    // The trap, stated as the engine sees it: nothing to match a policy against.
    expect(obs.toolCalls).toEqual([])
    // And the three things that stop that from reading as "no violations":
    expect(obs.toolCallCount).toBe(1)
    expect(obs.unnamedToolCallSeqs).toEqual([2])
    expect(obs.gaps).toContain('EXTERNALIZED_PAYLOAD')
  })

  it('a truncated scan is distinguishable from a complete one at the substrate', () => {
    const complete = extractRunObservation(eventsWith(toolCallPayload(10)), { scanTruncated: false })
    const partial = extractRunObservation(eventsWith(toolCallPayload(10)), { scanTruncated: true })
    // Identical events, identical findings — and NOT identical reports.
    expect(partial.toolCalls).toEqual(complete.toolCalls)
    expect(complete.gaps).toEqual([])
    expect(partial.gaps).toContain('SCAN_TRUNCATED')
  })
})
