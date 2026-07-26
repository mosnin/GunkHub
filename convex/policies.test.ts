/* eslint-disable */
// INTEGRATION tests for the declarative policy surface, against the REAL Convex
// functions via convex-test (same harness as backend.test.ts / budgets.test.ts).
//
// VERIFICATION IS THE DELIVERABLE. These claims are the ones the feature is
// worthless — or actively harmful — without:
//
//   1. INGEST STILL ACCEPTS A VIOLATING EVENT, on both write paths, with policies
//      live and matching, AND no ingest module can reach policy code at all.
//   2. `not_evaluable` NEVER BECOMES `satisfied`, over real stored rows —
//      instrumentation, unmapped spans, lossy provenance, a rule that forbids
//      nothing.
//   3. A VIOLATION CITES REAL, OPENABLE EVENTS.
//   4. CROSS-ORG ISOLATION, on every surface that takes an id.
//   5. POLICY WRITES ARE AUDITED, and there is NO DELETE.
//
// See also tests/unit/policy_adversarial_ingest.test.ts (Team D), which attacks
// the same ingest invariant from the refusal-alphabet side.
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

async function seedOrg(t: ReturnType<typeof convexTest>, tag: string, retentionDays?: number) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const org = await ctx.db.insert('organizations', {
      clerkOrgId: `clerk_${tag}`, name: tag, slug: tag, plan: 'free', createdAt: now, updatedAt: now,
      ...(retentionDays !== undefined ? { retentionDays } : {}),
    })
    for (const role of ['viewer', 'member', 'admin'] as const) {
      await ctx.db.insert('user_memberships', { clerkUserId: `${role}_${tag}`, orgId: org, role, joinedAt: now })
    }
    const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
    await ctx.db.insert('api_keys', {
      orgId: org, keyHash: `hash_${tag}`, name: 'k', createdBy: `admin_${tag}`, createdAt: now,
      scopes: ['ingest:write'],
    })
    return { org, project, agent, now }
  })
}

async function seedRun(
  t: ReturnType<typeof convexTest>,
  s: { org: any; project: any; agent: any },
  opts: { status?: string; environment?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert('runs', {
      orgId: s.org, projectId: s.project, agentId: s.agent,
      status: (opts.status ?? 'completed') as any,
      startedAt: Date.now(), metadata: {}, tags: [],
      ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
    }),
  )
}

/** Insert events directly, bypassing the write path — used to set up READ scenarios. */
async function seedEvents(
  t: ReturnType<typeof convexTest>,
  org: any,
  runId: any,
  rows: Array<{ seq: number; type: string; payload: unknown; provenance?: any }>,
) {
  return await t.run(async (ctx) => {
    const ids = []
    for (const r of rows) {
      ids.push(
        await ctx.db.insert('events', {
          runId, orgId: org, type: r.type, sequenceNumber: r.seq,
          timestamp: Date.now() + r.seq, payload: r.payload,
          ...(r.provenance ? { provenance: r.provenance } : {}),
        }),
      )
    }
    return ids
  })
}

const identity = (role: 'viewer' | 'member' | 'admin', tag: string) =>
  ({ subject: `${role}_${tag}`, org_id: `clerk_${tag}` }) as const

const NO_SHELL = {
  name: 'no shell',
  rule: { kind: 'tool_denied' as const, deniedTools: ['shell'] },
  rationale: 'SOC2 CC6.1 — no shell execution from customer-facing agents.',
}
const NO_EVIL = {
  name: 'no evil egress',
  rule: { kind: 'egress_denied' as const, deniedHosts: ['evil.example'] },
  rationale: 'No egress to known-bad hosts.',
}
const ORG = { appliesTo: 'org' as const }

const otelProvenance = (lossy: boolean) => ({
  source: 'otel', traceId: 't', spanId: 'sp', spanName: 'n',
  semconvVersion: '1.0', mapperVersion: '1', lossy, receivedAt: Date.now(),
})

// ===========================================================================
describe('1. INGEST STILL ACCEPTS A VIOLATING EVENT', () => {
  // THE STRONGER FORM. "Ingest did not reject" is a property of code someone
  // wrote; "policy code cannot run in an ingest transaction" is a property of the
  // dependency graph, which no bug inside the policy modules can violate. An
  // evaluation that merely THREW inside ingest would fail the surrounding insert
  // and become a refusal by accident — so the assertion is on the imports.
  it('NO INGEST MODULE IMPORTS THE POLICY MODULES, and nothing schedules an evaluation', async () => {
    const sources = import.meta.glob('./{events,sdk_ingest,otel_ingest,otel_settle,crons}.ts', {
      as: 'raw',
      eager: true,
    }) as Record<string, string>
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(5)
    for (const [file, src] of Object.entries(sources)) {
      const imports = src.match(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?$/gm) ?? []
      for (const line of imports) {
        expect(line, `${file} must not import a policy module`).not.toMatch(/polic(y|ies)/)
      }
      // Nor may it address one by name through makeFunctionReference/scheduler.
      expect(src, `${file} must not schedule a policy evaluation`).not.toMatch(/["']polic(y|ies)[^"']*:/)
    }
  })

  it('the Clerk write path stores a policy-violating tool.call intact, and the SAME event is cited as proof', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'ing1')
    const admin = t.withIdentity(identity('admin', 'ing1'))
    const member = t.withIdentity(identity('member', 'ing1'))

    // A policy that forbids exactly what is about to be recorded, ENABLED and
    // matching, so nothing here depends on the policy being inert.
    await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: { appliesTo: 'agent', agentId: s.agent }, ...NO_SHELL,
    })

    const run = await t.run(async (ctx) =>
      ctx.db.insert('runs', {
        orgId: s.org, projectId: s.project, agentId: s.agent, status: 'running',
        startedAt: Date.now(), metadata: {}, tags: [],
      }),
    )
    await member.mutation(api.events.createEvent, {
      runId: run, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {},
    })
    // THE VIOLATION. It must be ACCEPTED.
    const payload = { name: 'shell', input: { cmd: 'rm -rf /' } }
    const stored = await member.mutation(api.events.createEvent, {
      runId: run, type: 'tool.call', sequenceNumber: 2, timestamp: Date.now(), payload,
    })
    expect(stored).toBeTruthy()

    // ...and stored INTACT: not redacted, flagged, or replaced.
    const readBack = await t.run(async (ctx) => ctx.db.get(stored._id))
    expect(readBack!.type).toBe('tool.call')
    expect(readBack!.payload).toEqual(payload)

    await member.mutation(api.events.createEvent, {
      runId: run, type: 'run.completed', sequenceNumber: 3, timestamp: Date.now(), payload: {},
    })

    // THE POINT: the evidence survived, so the violation is findable.
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes).toHaveLength(1)
    expect(report.outcomes[0].outcome).toBe('violated')
    expect(report.outcomes[0].provenBy[0].citedEvent.eventId).toBe(stored._id)
    expect(report.outcomes[0].provenBy[0].decidedBy).toBe('inline_payload')
    expect(report.counts).toEqual({ violated: 1, satisfied: 0, notEvaluable: 0 })
  })

  it('the API-key ingest path likewise accepts it — a policy is not an ingest gate', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'ing2')
    const admin = t.withIdentity(identity('admin', 'ing2'))
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_EVIL })
    const run = await t.run(async (ctx) =>
      ctx.db.insert('runs', {
        orgId: s.org, projectId: s.project, agentId: s.agent, status: 'running',
        startedAt: Date.now(), metadata: {}, tags: [],
      }),
    )
    const res: any = await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_ing2',
      events: [
        { runId: run, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} },
        { runId: run, type: 'http.request', sequenceNumber: 2, timestamp: Date.now(), payload: { url: 'https://api.evil.example/x' } },
      ],
    })
    expect(res.eventIds ?? res).toBeTruthy()
    const count = await t.run(async (ctx) =>
      (await ctx.db.query('events').withIndex('by_run', (q) => q.eq('runId', run)).collect()).length,
    )
    expect(count).toBe(2)
  })

  it('THE POLICY SURFACE WRITES NOTHING TO events OR runs', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'nowrite')
    const admin = t.withIdentity(identity('admin', 'nowrite'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'run.started', payload: {} },
      { seq: 2, type: 'tool.call', payload: { name: 'shell' } },
      { seq: 3, type: 'run.completed', payload: {} },
    ])

    const snapshot = async () =>
      await t.run(async (ctx) => ({
        events: (await ctx.db.query('events').collect()).map((e) => ({ ...e })),
        runs: (await ctx.db.query('runs').collect()).map((r) => ({ ...r })),
      }))

    const before = await snapshot()
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_SHELL,
    })
    await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    await admin.query(api.policies.scanRunsAgainstPolicy, { policyId })
    await admin.mutation(api.policies.updatePolicy, {
      policyId, rule: { kind: 'tool_denied', deniedTools: ['exec'] },
    })
    await admin.mutation(api.policies.disablePolicy, { policyId, enabled: false, reason: 'superseded' })
    const after = await snapshot()

    expect(after).toEqual(before)
  })
})

// ===========================================================================
describe('2. not_evaluable NEVER BECOMES satisfied', () => {
  it('THE REPRO: a closed run of nothing but run.started is NOT satisfied, for EITHER rule kind', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'instr')
    const admin = t.withIdentity(identity('admin', 'instr'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'run.started', payload: {} },
      { seq: 2, type: 'run.completed', payload: {} },
    ])
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_SHELL })
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_EVIL })

    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes).toHaveLength(2)
    for (const o of report.outcomes) {
      expect(o.outcome).toBe('not_evaluable')
      expect(o.kind).toBe('instrumentation_undeclared')
      expect(o).not.toHaveProperty('satisfiedPolicyId')
      expect(o).not.toHaveProperty('establishedBy')
    }
    expect(report.counts).toEqual({ violated: 0, satisfied: 0, notEvaluable: 2 })
    // And the coverage statement never reads as an all-clear.
    expect(report.coverageStatement).not.toMatch(/no violations|compliant|clean|passed/i)
  })

  it('a run whose operation was an unmapped OTel span is not_evaluable', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'unmapped')
    const admin = t.withIdentity(identity('admin', 'unmapped'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'run.started', payload: {} },
      { seq: 2, type: 'otel.span.unmapped', payload: { spanName: 'mystery' } },
      { seq: 3, type: 'run.completed', payload: {} },
    ])
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_SHELL })
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes[0].outcome).toBe('not_evaluable')
    expect(report.outcomes[0].notEvaluableBecause).toContain('unmapped OpenTelemetry span')
  })

  it('a LOSSY OTel-derived tool.call is not_evaluable rather than graded', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'lossy')
    const admin = t.withIdentity(identity('admin', 'lossy'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'run.started', payload: {} },
      { seq: 2, type: 'tool.call', payload: { name: 'read_file' }, provenance: otelProvenance(true) },
      { seq: 3, type: 'run.completed', payload: {} },
    ])
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_SHELL })
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes[0].outcome).toBe('not_evaluable')
    // ...and the ordering caveat is forwarded because the run is OTel-derived.
    expect(report.scan.orderingCaveat).toBe(true)
    expect(report.coverageStatement).toContain('ARRIVAL order')
  })

  it('an externalized tool.call payload is evidence_externalized', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'ext')
    const admin = t.withIdentity(identity('admin', 'ext'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'run.started', payload: {} },
      { seq: 2, type: 'tool.call', payload: { type: '_externalized', _artifact: { artifactId: 'a' } } },
      { seq: 3, type: 'run.completed', payload: {} },
    ])
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_SHELL })
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes[0].outcome).toBe('not_evaluable')
    expect(report.outcomes[0].kind).toBe('evidence_externalized')
  })

  it('...but the SAME event PROVES a violation against a rule that forbids the operation itself', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'typealone')
    const admin = t.withIdentity(identity('admin', 'typealone'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'run.started', payload: {} },
      { seq: 2, type: 'tool.call', payload: { type: '_externalized', _artifact: { artifactId: 'a' } } },
      { seq: 3, type: 'run.completed', payload: {} },
    ])
    await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG,
      name: 'no tools at all', rule: { kind: 'tool_denied' }, rationale: 'This agent is read-only.',
    })
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes[0].outcome).toBe('violated')
    expect(report.outcomes[0].provenBy[0].decidedBy).toBe('event_type_alone')
    expect(report.outcomes[0].provenBy[0].observedValue).toBeNull()
  })

  it('a RUNNING run is never satisfied, however clear its prefix', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'inflight')
    const admin = t.withIdentity(identity('admin', 'inflight'))
    const run = await seedRun(t, s, { status: 'running' })
    await seedEvents(t, s.org, run, [{ seq: 1, type: 'tool.call', payload: { name: 'read_file' } }])
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_SHELL })
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes[0].outcome).toBe('not_evaluable')
    expect(report.outcomes[0].kind).toBe('run_in_flight')
  })

  it('WRITE PATH: a rule forbidding nothing is REFUSED', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'emptyrule')
    const admin = t.withIdentity(identity('admin', 'emptyrule'))
    await expect(
      admin.mutation(api.policies.createPolicy, {
        orgId: s.org, subject: ORG,
        name: 'forbids nothing', rule: { kind: 'tool_denied', deniedTools: [] }, rationale: 'x',
      }),
    ).rejects.toThrow(/INVALID_ARGUMENT/)
    // ...and so is a blank entry inside a non-empty list.
    await expect(
      admin.mutation(api.policies.createPolicy, {
        orgId: s.org, subject: ORG,
        name: 'blank entry', rule: { kind: 'tool_denied', deniedTools: ['  '] }, rationale: 'x',
      }),
    ).rejects.toThrow(/INVALID_ARGUMENT/)
  })

  it('ANY OTHER PATH: a stored rule forbidding nothing is policy_unreadable, not satisfied', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'bypass')
    const admin = t.withIdentity(identity('admin', 'bypass'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'run.started', payload: {} },
      { seq: 2, type: 'tool.call', payload: { name: 'shell' } },
      { seq: 3, type: 'run.completed', payload: {} },
    ])
    // Inserted directly — a backup restore, or a row predating the guard.
    const policyId = await t.run(async (ctx) =>
      ctx.db.insert('policies', {
        orgId: s.org, name: 'legacy', rule: { kind: 'tool_denied', deniedTools: [] },
        subject: { appliesTo: 'org' }, rationale: 'written before the guard existed',
        enabled: true, revision: 1, createdAt: Date.now(), createdBy: 'legacy',
      }),
    )
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes[0].outcome).toBe('not_evaluable')
    expect(report.outcomes[0].kind).toBe('policy_unreadable')
    // ...and the LISTING flags it, because the policy list is where an operator
    // looks to believe a control is in force.
    const listed: any = await admin.query(api.policies.listPolicies, { orgId: s.org })
    expect(listed.policies.find((p: any) => p._id === policyId).interpretable).toBe(false)
  })

  it('ZERO RUNS IN SCOPE is its own outcome, never an all-clear', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'norunsatall')
    const admin = t.withIdentity(identity('admin', 'norunsatall'))
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: { appliesTo: 'environment', environment: 'production' }, ...NO_SHELL,
    })
    const report: any = await admin.query(api.policies.scanRunsAgainstPolicy, { policyId })
    expect(report.outcomes).toHaveLength(1)
    expect(report.outcomes[0].kind).toBe('no_runs_in_scope')
    expect(report.counts.satisfied).toBe(0)
  })

  it('A DISABLED POLICY IS REPORTED, not refused and not graded', async () => {
    // A failing scan must not be made to pass by switching its policy off. The
    // outcome is `not_evaluable`, which is wrong in NEITHER direction: it cannot
    // manufacture the violation somebody rolls back on, and it cannot be counted
    // as an all-clear.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'disabledscan')
    const admin = t.withIdentity(identity('admin', 'disabledscan'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'tool.call', payload: { name: 'shell' } },
      { seq: 2, type: 'run.completed', payload: {} },
    ])
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_SHELL, enabled: false,
    })
    const report: any = await admin.query(api.policies.scanRunsAgainstPolicy, { policyId })
    expect(report.counts.violated).toBe(0)
    expect(report.counts.satisfied).toBe(0)
    expect(report.outcomes[0].kind).toBe('policy_disabled')
    // ...and it is not in force for the pre-flight or the per-run evaluation.
    const per: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(per.outcomes).toHaveLength(0)
  })

  it('a VACUOUS ENABLED policy is never silently dropped from a report', async () => {
    // The mirror-image risk of the disabled filter: a rule an operator believes
    // is in force, absent from every report rather than named. `policyGoverns`
    // is enablement AND interpretability, so filtering the loader on it would
    // have hidden exactly this.
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'vacuousvisible')
    const admin = t.withIdentity(identity('admin', 'vacuousvisible'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'tool.call', payload: { name: 'shell' } },
      { seq: 2, type: 'run.completed', payload: {} },
    ])
    await t.run(async (ctx) =>
      ctx.db.insert('policies', {
        orgId: s.org, name: 'legacy', rule: { kind: 'tool_denied', deniedTools: [] },
        subject: { appliesTo: 'org' }, rationale: 'r', enabled: true, revision: 1,
        createdAt: Date.now(), createdBy: 'legacy',
      }),
    )
    const per: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(per.outcomes).toHaveLength(1)
    expect(per.outcomes[0].kind).toBe('policy_unreadable')
  })

  it('the retention horizon is NAMED — a report must not go clear by elapsed time in silence', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'retention', 30)
    const admin = t.withIdentity(identity('admin', 'retention'))
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_SHELL,
    })
    const report: any = await admin.query(api.policies.scanRunsAgainstPolicy, { policyId })
    expect(report.scan.retentionHorizon).not.toBeNull()
    expect(report.coverageStatement).toContain('aged out')
  })

  it('the cross-run scan reports every run in the page, none omitted', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'page')
    const admin = t.withIdentity(identity('admin', 'page'))
    for (let i = 0; i < 3; i++) {
      const r = await seedRun(t, s)
      await seedEvents(t, s.org, r, [
        { seq: 1, type: 'tool.call', payload: { name: 'read_file' } },
        { seq: 2, type: 'run.completed', payload: {} },
      ])
    }
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_SHELL,
    })
    const report: any = await admin.query(api.policies.scanRunsAgainstPolicy, { policyId })
    expect(report.outcomes).toHaveLength(3)
    expect(report.scan.runsInScope).toBe(3)
    expect(report.scan.runsRead).toBe(3)
    expect(report.counts.notEvaluable).toBe(3)
    expect(report.coverageStatement).toContain('could not be settled')
  })
})

// ===========================================================================
describe('3. A VIOLATION CITES THE EVENTS THAT PROVE IT', () => {
  it('the cited eventId resolves to the stored row whose payload violated', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'cite')
    const admin = t.withIdentity(identity('admin', 'cite'))
    const run = await seedRun(t, s, { environment: 'production' })
    const ids = await seedEvents(t, s.org, run, [
      { seq: 1, type: 'run.started', payload: {} },
      { seq: 2, type: 'http.request', payload: { url: 'https://api.evil.example/v1/x' } },
      { seq: 3, type: 'run.completed', payload: {} },
    ])
    await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: { appliesTo: 'environment', environment: 'production' }, ...NO_EVIL,
    })
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    const o = report.outcomes[0]
    expect(o.outcome).toBe('violated')
    expect(o.provenBy[0].citedEvent.eventId).toBe(ids[1])

    // THE CITATION IS OPENABLE. That is what makes it evidence rather than an
    // assertion — the whole basis for trusting the finding.
    const cited = await t.run(async (ctx) => ctx.db.get(o.provenBy[0].citedEvent.eventId))
    expect(cited!.payload).toEqual({ url: 'https://api.evil.example/v1/x' })
    // ...and the outcome states its own justification.
    expect(o.violatedBecause).toContain('known-bad hosts')
  })

  it('a label-boundary near-miss is NOT a violation — a false accusation is as bad as a false all-clear', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'nearmiss')
    const admin = t.withIdentity(identity('admin', 'nearmiss'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'http.request', payload: { url: 'https://myevil.example/x' } },
      { seq: 2, type: 'run.completed', payload: {} },
    ])
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_EVIL })
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(report.outcomes[0].outcome).toBe('not_evaluable')
  })

  it('an environment policy does not govern a run with no environment recorded', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'envless')
    const admin = t.withIdentity(identity('admin', 'envless'))
    const run = await seedRun(t, s) // no environment field at all
    await seedEvents(t, s.org, run, [{ seq: 1, type: 'http.request', payload: { url: 'https://evil.example/' } }])
    await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: { appliesTo: 'environment', environment: 'production' }, ...NO_EVIL,
    })
    const report: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    // Not governed => no outcome at all. NOT a satisfied one: an unset
    // environment is not the production environment.
    expect(report.outcomes).toHaveLength(0)
    expect(report.scan.policiesInScope).toBe(0)
  })

  it('an environment-scoped report says the label is a SELF-REPORT', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'selfreport')
    const admin = t.withIdentity(identity('admin', 'selfreport'))
    const run = await seedRun(t, s, { environment: 'production' })
    await seedEvents(t, s.org, run, [{ seq: 1, type: 'run.completed', payload: {} }])
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: { appliesTo: 'environment', environment: 'production' }, ...NO_EVIL,
    })
    const report: any = await admin.query(api.policies.scanRunsAgainstPolicy, { policyId })
    expect(report.coverageStatement).toContain('SAID they were')
  })
})

// ===========================================================================
describe('4. CROSS-ORG ISOLATION', () => {
  it("a policy never sees another org's runs", async () => {
    const t = convexTest(schema, modules)
    const a = await seedOrg(t, 'orgA')
    const b = await seedOrg(t, 'orgB')
    const adminA = t.withIdentity(identity('admin', 'orgA'))

    const runB = await seedRun(t, b)
    await seedEvents(t, b.org, runB, [{ seq: 1, type: 'tool.call', payload: { name: 'shell' } }])
    const runA = await seedRun(t, a)
    await seedEvents(t, a.org, runA, [
      { seq: 1, type: 'tool.call', payload: { name: 'read_file' } },
      { seq: 2, type: 'run.completed', payload: {} },
    ])

    const { policyId } = await adminA.mutation(api.policies.createPolicy, {
      orgId: a.org, subject: ORG, ...NO_SHELL,
    })
    const report: any = await adminA.query(api.policies.scanRunsAgainstPolicy, { policyId })
    expect(report.counts.violated).toBe(0)
    expect(report.outcomes).toHaveLength(1)
    expect(report.scan.runsInScope).toBe(1)
  })

  it("evaluating another org's run is NOT_FOUND — indistinguishable from a run that does not exist", async () => {
    const t = convexTest(schema, modules)
    await seedOrg(t, 'x1')
    const b = await seedOrg(t, 'x2')
    const runB = await seedRun(t, b)
    await expect(
      t.withIdentity(identity('admin', 'x1')).query(api.policies.evaluateRunAgainstPolicies, { runId: runB }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  it("another org's policy is NOT_FOUND on get, scan, update and disable", async () => {
    const t = convexTest(schema, modules)
    await seedOrg(t, 'y1')
    const b = await seedOrg(t, 'y2')
    const { policyId: policyB } = await t
      .withIdentity(identity('admin', 'y2'))
      .mutation(api.policies.createPolicy, { orgId: b.org, subject: ORG, ...NO_SHELL })
    const adminA = t.withIdentity(identity('admin', 'y1'))
    await expect(adminA.query(api.policies.getPolicy, { policyId: policyB })).rejects.toThrow(/NOT_FOUND/)
    await expect(adminA.query(api.policies.scanRunsAgainstPolicy, { policyId: policyB })).rejects.toThrow(/NOT_FOUND/)
    await expect(adminA.mutation(api.policies.updatePolicy, { policyId: policyB, name: 'z' })).rejects.toThrow(/NOT_FOUND/)
    await expect(
      adminA.mutation(api.policies.disablePolicy, { policyId: policyB, enabled: false, reason: 'r' }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  it("a policy cannot name another org's agent or project as its subject", async () => {
    const t = convexTest(schema, modules)
    const a = await seedOrg(t, 'z1')
    const b = await seedOrg(t, 'z2')
    const adminA = t.withIdentity(identity('admin', 'z1'))
    await expect(
      adminA.mutation(api.policies.createPolicy, {
        orgId: a.org, subject: { appliesTo: 'agent', agentId: b.agent }, ...NO_SHELL,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      adminA.mutation(api.policies.createPolicy, {
        orgId: a.org, subject: { appliesTo: 'project', projectId: b.project }, ...NO_SHELL,
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  it('writes require admin; a member and a viewer are refused', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'role')
    for (const role of ['member', 'viewer'] as const) {
      await expect(
        t.withIdentity(identity(role, 'role')).mutation(api.policies.createPolicy, {
          orgId: s.org, subject: ORG, ...NO_SHELL,
        }),
      ).rejects.toThrow(/Forbidden/)
    }
  })

  it('an unauthenticated caller reads nothing', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'anon')
    await expect(t.query(api.policies.listPolicies, { orgId: s.org })).rejects.toThrow(/Unauthorized/)
  })
})

// ===========================================================================
describe('5. POLICY WRITES ARE AUDITED, AND THERE IS NO DELETE', () => {
  const auditFor = async (t: ReturnType<typeof convexTest>, org: any) =>
    await t.run(async (ctx) =>
      (await ctx.db.query('audit_log').withIndex('by_org', (q) => q.eq('orgId', org)).collect())
        .filter((r) => r.action.startsWith('policy.')),
    )

  it('THERE IS NO deletePolicy MUTATION — a policy that judged recorded runs is not removable', async () => {
    // Asserted on the SOURCE rather than on `api.policies`, because the
    // hand-authored `_generated/api.ts` is `anyApi` — every name resolves to a
    // proxy, so a `toBeUndefined()` there would pass for a mutation that exists
    // and fail for one that does not. The source is the fact.
    const src = (
      import.meta.glob('./policies.ts', { as: 'raw', eager: true }) as Record<string, string>
    )['./policies.ts']
    expect(src).not.toMatch(/export const deletePolicy/)
    expect(src).not.toMatch(/ctx\.db\.delete\(/)
  })

  it('create / update / disable each write one audit row, and return the receipt', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'aud')
    const admin = t.withIdentity(identity('admin', 'aud'))
    const created = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_SHELL,
    })
    expect(created.auditLogId).toBeTruthy()
    await admin.mutation(api.policies.updatePolicy, {
      policyId: created.policyId, rule: { kind: 'tool_denied', deniedTools: ['exec'] },
    })
    await admin.mutation(api.policies.disablePolicy, {
      policyId: created.policyId, enabled: false, reason: 'superseded by the exec rule',
    })

    const rows = await auditFor(t, s.org)
    expect(rows.map((r) => r.action)).toEqual(['policy.created', 'policy.updated', 'policy.enabled_changed'])
    for (const r of rows) {
      expect(r.actorClerkUserId).toBe('admin_aud')
      expect(r.targetId).toBe(created.policyId)
    }
    const receipt = await t.run(async (ctx) => ctx.db.get(created.auditLogId))
    expect(receipt!.action).toBe('policy.created')
  })

  it("a DISABLED policy's terms remain reconstructible, and the ROW SURVIVES", async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'aud2')
    const admin = t.withIdentity(identity('admin', 'aud2'))
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_EVIL,
    })
    await admin.mutation(api.policies.disablePolicy, { policyId, enabled: false, reason: 'vendor retired' })

    const disabled = (await auditFor(t, s.org)).find((r) => r.action === 'policy.enabled_changed')!
    expect(disabled.metadata.rule).toEqual({ kind: 'egress_denied', deniedHosts: ['evil.example'] })
    expect(disabled.metadata.reason).toBe('vendor retired')
    // A past outcome that cited this policy stays interpretable.
    expect(await t.run(async (ctx) => ctx.db.get(policyId))).not.toBeNull()
  })

  it('disable requires a reason', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'aud3')
    const admin = t.withIdentity(identity('admin', 'aud3'))
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_SHELL,
    })
    await expect(
      admin.mutation(api.policies.disablePolicy, { policyId, enabled: false, reason: '  ' }),
    ).rejects.toThrow(/INVALID_ARGUMENT/)
  })

  it('an update BUMPS the revision and stamps the old terms; enable/disable does NOT bump', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'rev')
    const admin = t.withIdentity(identity('admin', 'rev'))
    const run = await seedRun(t, s)
    await seedEvents(t, s.org, run, [
      { seq: 1, type: 'tool.call', payload: { name: 'shell' } },
      { seq: 2, type: 'run.completed', payload: {} },
    ])
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_SHELL,
    })
    const before: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    expect(before.outcomes[0].violatedPolicyRevision).toBe(1)

    await admin.mutation(api.policies.updatePolicy, {
      policyId, rule: { kind: 'tool_denied', deniedTools: ['exec'] },
    })
    const after: any = await admin.query(api.policies.evaluateRunAgainstPolicies, { runId: run })
    // The same run, judged under a different revision, now yields a different
    // outcome — and the revision is what makes the two reports distinguishable.
    expect(after.outcomes[0].outcome).toBe('not_evaluable')
    expect(after.outcomes[0].undecidedPolicyRevision).toBe(2)

    const updated = (await auditFor(t, s.org)).find((r) => r.action === 'policy.updated')!
    expect(updated.metadata.previousRule).toEqual({ kind: 'tool_denied', deniedTools: ['shell'] })

    await admin.mutation(api.policies.disablePolicy, { policyId, enabled: true, reason: 'r' })
    expect(await t.run(async (ctx) => (await ctx.db.get(policyId))!.revision)).toBe(2)
  })
})

// ===========================================================================
describe('the pre-flight gate is advisory and key-scoped', () => {
  it('returns governing definitions, no verdict field, and the contract shelf life', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'pf1')
    const admin = t.withIdentity(identity('admin', 'pf1'))
    await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: { appliesTo: 'agent', agentId: s.agent }, ...NO_SHELL,
    })
    const snap: any = await t.query(api.policy_gate.sdkCheckPolicy, {
      apiKeyHash: 'hash_pf1', agentId: s.agent,
    })
    expect(snap.policies).toHaveLength(1)
    expect(snap.policies[0].rule).toEqual({ kind: 'tool_denied', deniedTools: ['shell'] })
    expect(snap.policies[0].rationale).toContain('SOC2')
    for (const forbidden of ['allowed', 'decision', 'deny', 'blocked', 'permitted', 'verdict']) {
      expect(snap).not.toHaveProperty(forbidden)
    }
    expect(snap.shelfLifeMs).toBe(600_000)
    expect(snap.subject).toEqual({ appliesTo: 'agent', agentId: s.agent })
  })

  it('scope comes from the key, so a caller cannot name another org', async () => {
    const t = convexTest(schema, modules)
    await seedOrg(t, 'pf2')
    const b = await seedOrg(t, 'pf3')
    await t.withIdentity(identity('admin', 'pf3')).mutation(api.policies.createPolicy, {
      orgId: b.org, subject: ORG, ...NO_SHELL,
    })
    const snap: any = await t.query(api.policy_gate.sdkCheckPolicy, { apiKeyHash: 'hash_pf2' })
    expect(snap.policies).toHaveLength(0)
    await expect(
      t.query(api.policy_gate.sdkCheckPolicy, { apiKeyHash: 'hash_pf2', agentId: b.agent }),
    ).rejects.toThrow(/NOT_FOUND/)
  })

  it('a revoked key is rejected, and a key without ingest:write is refused', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'pf4')
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', {
        orgId: s.org, keyHash: 'hash_readonly', name: 'r', createdBy: 'u', createdAt: Date.now(),
        scopes: ['read'],
      })
      const k = await ctx.db.query('api_keys').withIndex('by_key_hash', (q) => q.eq('keyHash', 'hash_pf4')).unique()
      await ctx.db.patch(k!._id, { revokedAt: Date.now() })
    })
    await expect(t.query(api.policy_gate.sdkCheckPolicy, { apiKeyHash: 'hash_pf4' })).rejects.toThrow(/Unauthorized/)
    await expect(t.query(api.policy_gate.sdkCheckPolicy, { apiKeyHash: 'hash_readonly' })).rejects.toThrow(/Forbidden/)
  })

  it('a disabled policy is not in force and is not listed', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'pf5')
    const admin = t.withIdentity(identity('admin', 'pf5'))
    const { policyId } = await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: ORG, ...NO_SHELL, enabled: false,
    })
    const a: any = await t.query(api.policy_gate.sdkCheckPolicy, { apiKeyHash: 'hash_pf5' })
    expect(a.policies).toHaveLength(0)
    await admin.mutation(api.policies.disablePolicy, { policyId, enabled: true, reason: 'back in force' })
    const b: any = await t.query(api.policy_gate.sdkCheckPolicy, { apiKeyHash: 'hash_pf5' })
    expect(b.policies).toHaveLength(1)
  })

  it('an under-specified question WIDENS rather than returning an empty list', async () => {
    const t = convexTest(schema, modules)
    const s = await seedOrg(t, 'pf6')
    const admin = t.withIdentity(identity('admin', 'pf6'))
    await admin.mutation(api.policies.createPolicy, { orgId: s.org, subject: ORG, ...NO_SHELL })
    await admin.mutation(api.policies.createPolicy, {
      orgId: s.org, subject: { appliesTo: 'agent', agentId: s.agent },
      name: 'agent rule', rule: { kind: 'tool_denied', deniedTools: ['exec'] }, rationale: 'r',
    })
    // Naming nothing: the org rule applies, the agent rule does not.
    const wide: any = await t.query(api.policy_gate.sdkCheckPolicy, { apiKeyHash: 'hash_pf6' })
    expect(wide.policies).toHaveLength(1)
    expect(wide.policies[0].subject).toEqual({ appliesTo: 'org' })
    // Naming the agent: both.
    const narrow: any = await t.query(api.policy_gate.sdkCheckPolicy, {
      apiKeyHash: 'hash_pf6', agentId: s.agent,
    })
    expect(narrow.policies).toHaveLength(2)
  })
})
