import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, it, expect, afterAll } from 'vitest'

import { analyze, parseConvexModules, parseRefs } from '../../scripts/check-convex-refs.js'

// ---------------------------------------------------------------------------
// Guard-the-guard tests for scripts/check-convex-refs.ts.
//
// The checker exists because apps/web/src/lib/convexFunctions.ts is a
// hand-maintained table of `makeFunctionReference` STRING refs that TypeScript
// cannot validate (convex/_generated/api.ts is an `anyApi` stub). A checker
// that has never been observed catching anything is not a guard, so every
// failure class below is exercised against a synthetic fixture repo: a broken
// ref/call site is planted, and the test asserts the checker reports it with a
// message naming the offending ref.
//
// The last block runs the checker against the REAL repository and asserts that
// no ref-resolution problem exists — that is the standing regression test.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

interface Fixture {
  /** module name -> file body */
  readonly convex: Record<string, string>
  /** body of the refs table (inside `export const convex = { ... }`) */
  readonly refs: string
  /** relative file name -> body, under the fake web src */
  readonly web?: Record<string, string>
  readonly exemptions?: ReadonlyArray<{ ref: string; reason: string }>
}

function run(fixture: Fixture): string[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convex-refs-'))
  tmpDirs.push(root)

  const convexDir = path.join(root, 'convex')
  const webSrc = path.join(root, 'web')
  fs.mkdirSync(convexDir)
  fs.mkdirSync(webSrc, { recursive: true })

  for (const [name, body] of Object.entries(fixture.convex)) {
    fs.writeFileSync(path.join(convexDir, `${name}.ts`), body)
  }
  const refsFile = path.join(webSrc, 'convexFunctions.ts')
  fs.writeFileSync(
    refsFile,
    `import { makeFunctionReference } from 'convex/server'\n` +
      `type Q = 'query'\ntype M = 'mutation'\ntype A = 'action'\n` +
      `export const convex = {\n${fixture.refs}\n} as const\n`,
  )
  for (const [name, body] of Object.entries(fixture.web ?? {})) {
    fs.writeFileSync(path.join(webSrc, name), body)
  }

  const result = analyze({
    convexDir,
    refsFile,
    webSrc,
    exemptions: fixture.exemptions ?? [],
  })
  return result.problems.map((p) => `${p.title}\n${p.lines.join('\n')}`)
}

/** A convex module with one public query, one public mutation, one internal query. */
const RUNS_MODULE = `
import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server.js";

export const getRun = query({
  args: { orgId: v.id("organizations"), runId: v.id("runs") },
  handler: async () => null,
});

export const createRun = mutation({
  args: { orgId: v.id("organizations"), name: v.string(), tags: v.optional(v.array(v.string())) },
  handler: async () => null,
});

export const _internalHelper = internalQuery({
  args: {},
  handler: async () => null,
});
`

const FULL_REFS = `  runs: {
    getRun: makeFunctionReference<Q>('runs:getRun'),
    createRun: makeFunctionReference<M>('runs:createRun'),
  },`

// ---------------------------------------------------------------------------
// A. Parsers
// ---------------------------------------------------------------------------

describe('parseConvexModules', () => {
  it('enumerates public and internal registrations with kind and args validator', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convex-refs-parse-'))
    tmpDirs.push(root)
    fs.writeFileSync(path.join(root, 'runs.ts'), RUNS_MODULE)

    const fns = parseConvexModules(root)

    expect(fns.get('runs:getRun')?.kind).toBe('query')
    expect(fns.get('runs:getRun')?.internal).toBe(false)
    expect(fns.get('runs:createRun')?.kind).toBe('mutation')
    expect(fns.get('runs:_internalHelper')?.internal).toBe(true)
    // args validator, with v.optional() recorded as not-required
    expect([...(fns.get('runs:createRun')?.args?.keys() ?? [])]).toEqual(['orgId', 'name', 'tags'])
    expect(fns.get('runs:createRun')?.args?.get('name')?.required).toBe(true)
    expect(fns.get('runs:createRun')?.args?.get('tags')?.required).toBe(false)
  })

  it('ignores *.test.ts files next to the modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convex-refs-parse2-'))
    tmpDirs.push(root)
    fs.writeFileSync(path.join(root, 'runs.ts'), RUNS_MODULE)
    fs.writeFileSync(
      path.join(root, 'runs.test.ts'),
      `export const notARealFunction = query({ args: {}, handler: async () => null });`,
    )

    const fns = parseConvexModules(root)
    expect(fns.has('runs:getRun')).toBe(true)
    expect(fns.has('runs.test:notARealFunction')).toBe(false)
  })
})

describe('parseRefs', () => {
  it('resolves the Q/M/A type aliases and records the object path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convex-refs-refs-'))
    tmpDirs.push(root)
    const file = path.join(root, 'convexFunctions.ts')
    fs.writeFileSync(
      file,
      `type Q = 'query'\ntype M = 'mutation'\ntype A = 'action'\n` +
        `export const convex = {\n` +
        `  runs: { getRun: makeFunctionReference<Q>('runs:getRun') },\n` +
        `  jobs: { kick: makeFunctionReference<A>('jobs:kick') },\n` +
        `} as const\n`,
    )

    const refs = parseRefs(file)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({
      objectPath: 'convex.runs.getRun',
      module: 'runs',
      name: 'getRun',
      declaredKind: 'query',
    })
    expect(refs[1]).toMatchObject({ objectPath: 'convex.jobs.kick', declaredKind: 'action' })
  })
})

// ---------------------------------------------------------------------------
// B. Failure classes — each must be CAUGHT
// ---------------------------------------------------------------------------

describe('check 1 — ref resolution', () => {
  it('passes on a fixture where every ref is correct', () => {
    expect(run({ convex: { runs: RUNS_MODULE }, refs: FULL_REFS })).toEqual([])
  })

  it('catches a ref pointing at a function that does not exist', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: `  runs: {
    getRun: makeFunctionReference<Q>('runs:getRun'),
    createRun: makeFunctionReference<M>('runs:createRun'),
    getRunn: makeFunctionReference<Q>('runs:getRunn'),
  },`,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('convex.runs.getRunn — NO SUCH FUNCTION')
    expect(problems[0]).toContain("'runs:getRunn'")
    // The message must name a candidate so the fix needs no investigation.
    expect(problems[0]).toContain('getRun')
  })

  it('catches a ref whose MODULE path is wrong, and points at the right module', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: `  runs: {
    getRun: makeFunctionReference<Q>('runs:getRun'),
    createRun: makeFunctionReference<M>('runs:createRun'),
  },
  explanations: {
    getRun: makeFunctionReference<Q>('run_explanations:getRun'),
  },`,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('convex.explanations.getRun — WRONG MODULE PATH')
    expect(problems[0]).toContain('convex/run_explanations.ts does not exist')
    expect(problems[0]).toContain("Did you mean 'runs:getRun'")
  })

  it('catches a ref typed <Q> that is actually a mutation (the read_api class of bug)', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: `  runs: {
    getRun: makeFunctionReference<Q>('runs:getRun'),
    createRun: makeFunctionReference<Q>('runs:createRun'),
  },`,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('convex.runs.createRun — KIND MISMATCH (declared query, actually mutation)')
    expect(problems[0]).toContain('change the type parameter to <M>')
  })

  it('catches the reverse kind mismatch (<M> for an actual query)', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: `  runs: {
    getRun: makeFunctionReference<M>('runs:getRun'),
    createRun: makeFunctionReference<M>('runs:createRun'),
  },`,
    })
    expect(problems[0]).toContain('KIND MISMATCH (declared mutation, actually query)')
    expect(problems[0]).toContain('change the type parameter to <Q>')
  })

  it('catches a ref pointing at an internal* function (not client-callable)', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: `${FULL_REFS}
  helpers: {
    _internalHelper: makeFunctionReference<Q>('runs:_internalHelper'),
  },`,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('INTERNAL FUNCTION')
    expect(problems[0]).toContain('internal.runs._internalHelper')
  })

  it('catches the same convex function registered twice', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: `${FULL_REFS}
  legacy: {
    getRun: makeFunctionReference<Q>('runs:getRun'),
  },`,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('duplicate ref')
  })
})

describe('check 2 — reverse coverage', () => {
  const WEBHOOKS_MODULE = `
import { v } from "convex/values";
import { query, mutation } from "./_generated/server.js";

export const listWebhooks = query({ args: { orgId: v.id("organizations") }, handler: async () => [] });
export const createWebhook = mutation({ args: { orgId: v.id("organizations"), url: v.string() }, handler: async () => null });
`

  it('catches a public function in a web-facing module that has no ref', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE, webhooks: WEBHOOKS_MODULE },
      refs: `${FULL_REFS}
  webhooks: {
    listWebhooks: makeFunctionReference<Q>('webhooks:listWebhooks'),
  },`,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('webhooks:createWebhook — MISSING REF')
    expect(problems[0]).toContain("makeFunctionReference<M>('webhooks:createWebhook')")
  })

  it('does NOT require refs for modules the web app has never referenced', () => {
    // webhooks has zero refs -> module is not web-facing -> not under the rule.
    expect(run({ convex: { runs: RUNS_MODULE, webhooks: WEBHOOKS_MODULE }, refs: FULL_REFS })).toEqual([])
  })

  it('does NOT require refs for internal* functions', () => {
    // runs:_internalHelper is unreferenced and runs IS web-facing.
    expect(run({ convex: { runs: RUNS_MODULE }, refs: FULL_REFS })).toEqual([])
  })

  it('does NOT require refs for other auth surfaces (apiKeyHash / webhookSecret)', () => {
    const problems = run({
      convex: {
        runs: `${RUNS_MODULE}
export const sdkPing = mutation({ args: { apiKeyHash: v.string() }, handler: async () => null });
export const clerkSync = mutation({ args: { webhookSecret: v.string(), clerkOrgId: v.string() }, handler: async () => null });
`,
      },
      refs: FULL_REFS,
    })
    expect(problems).toEqual([])
  })

  it('honours an exemption, and flags one that has gone stale', () => {
    const exempt = [{ ref: 'webhooks:createWebhook', reason: 'no UI surface yet' }]
    const fixture: Fixture = {
      convex: { runs: RUNS_MODULE, webhooks: WEBHOOKS_MODULE },
      refs: `${FULL_REFS}
  webhooks: {
    listWebhooks: makeFunctionReference<Q>('webhooks:listWebhooks'),
  },`,
      exemptions: exempt,
    }
    expect(run(fixture)).toEqual([])

    // Once the ref lands, the exemption must be removed — otherwise it silently
    // mutes the next real miss in that module.
    const stale = run({
      ...fixture,
      refs: `${FULL_REFS}
  webhooks: {
    listWebhooks: makeFunctionReference<Q>('webhooks:listWebhooks'),
    createWebhook: makeFunctionReference<M>('webhooks:createWebhook'),
  },`,
    })
    expect(stale).toHaveLength(1)
    expect(stale[0]).toContain('STALE REVERSE-COVERAGE EXEMPTION (function is now registered)')

    const gone = run({ convex: { runs: RUNS_MODULE }, refs: FULL_REFS, exemptions: exempt })
    expect(gone).toHaveLength(1)
    expect(gone[0]).toContain('STALE REVERSE-COVERAGE EXEMPTION (function no longer exists)')
  })
})

describe('checks 3 & 4 — call sites', () => {
  it('catches a query called with client.mutation()', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: FULL_REFS,
      web: {
        'service.ts': `import { convex } from './convexFunctions'
export async function f(client: any, orgId: string, runId: string) {
  return client.mutation(convex.runs.getRun, { orgId, runId })
}`,
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('CALL-SITE KIND MISMATCH')
    expect(problems[0]).toContain('client.query(...)')
  })

  it('catches an arg the validator does not declare', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: FULL_REFS,
      web: {
        'service.ts': `import { convex } from './convexFunctions'
export async function f(client: any, orgId: string, runId: string) {
  return client.query(convex.runs.getRun, { orgId, runId, includeEvents: true })
}`,
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('UNKNOWN ARG: includeEvents')
  })

  it('catches a required arg the call site drops (the silent-filter bug class)', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: FULL_REFS,
      web: {
        'service.ts': `import { convex } from './convexFunctions'
export async function f(client: any, runId: string) {
  return client.query(convex.runs.getRun, { runId })
}`,
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('MISSING REQUIRED ARG: orgId')
  })

  it('accepts a correct call site, and omitted v.optional() args', () => {
    expect(
      run({
        convex: { runs: RUNS_MODULE },
        refs: FULL_REFS,
        web: {
          'service.ts': `import { convex } from './convexFunctions'
export async function f(client: any, orgId: string, runId: string, name: string) {
  await client.query(convex.runs.getRun, { orgId, runId })
  return client.mutation(convex.runs.createRun, { orgId, name })
}`,
        },
      }),
    ).toEqual([])
  })

  it('does not guess about call sites whose args object contains a spread', () => {
    // Spreads are not statically enumerable — the checker must stay silent
    // rather than emit a false positive.
    expect(
      run({
        convex: { runs: RUNS_MODULE },
        refs: FULL_REFS,
        web: {
          'service.ts': `import { convex } from './convexFunctions'
export async function f(client: any, params: any) {
  return client.query(convex.runs.getRun, { ...params })
}`,
        },
      }),
    ).toEqual([])
  })

  it('checks React hook call sites too (useQuery / useMutation)', () => {
    const problems = run({
      convex: { runs: RUNS_MODULE },
      refs: FULL_REFS,
      web: {
        'panel.tsx': `import { convex } from './convexFunctions'
export function Panel({ orgId, name }: { orgId: string; name: string }) {
  const create = useQuery(convex.runs.createRun, { orgId, name })
  return create
}`,
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('CALL-SITE KIND MISMATCH')
    expect(problems[0]).toContain('useQuery')
  })
})

// ---------------------------------------------------------------------------
// C. Standing regression test against the REAL repository
// ---------------------------------------------------------------------------

describe('the real convexFunctions.ts table', () => {
  const problems = analyze().problems.map((p) => p.title)

  it('has no ref pointing at a missing function or module', () => {
    expect(problems.filter((t) => /NO SUCH FUNCTION|WRONG MODULE PATH|malformed ref/.test(t))).toEqual([])
  })

  it('has no ref whose declared kind disagrees with the convex registration', () => {
    expect(problems.filter((t) => t.includes('KIND MISMATCH'))).toEqual([])
  })

  it('has no ref pointing at an internal* function, and no duplicate refs', () => {
    expect(problems.filter((t) => /INTERNAL FUNCTION|duplicate ref/.test(t))).toEqual([])
  })

  it('registers every public function of every web-facing module', () => {
    expect(problems.filter((t) => /MISSING REF|STALE REVERSE-COVERAGE/.test(t))).toEqual([])
  })

  // NOTE — deliberately not asserted here yet: call-site ARG problems.
  // `pnpm tsx scripts/check-convex-refs.ts` (the CI gate) currently reports one
  // real defect it found on its first run — services/evals.ts calls
  // convex.insights.getRunEvalSummary without the required `orgId`, so that
  // query always fails ArgumentValidationError and the run-detail Evals header
  // silently takes its catch-fallback path. That file is owned by the web team.
  // Once the missing arg lands, add:
  //   expect(problems.filter((t) => /UNKNOWN ARG|MISSING REQUIRED ARG/.test(t))).toEqual([])
  // so the whole class is locked down here as well as in the CI gate.
})
