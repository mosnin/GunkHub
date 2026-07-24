/* eslint-disable */
/**
 * Cross-org EXISTENCE ORACLE tests for the Convex public surface.
 *
 * The property under test (CLAUDE.md Tenancy Rule 3, and its corollary): a
 * document ID belonging to ANOTHER organization must be indistinguishable from
 * a document ID that does not exist at all. Rule 3 says a query for org A must
 * never RETURN a record belonging to org B; the corollary is that it must also
 * never let the caller LEARN that org B's record exists. A function that throws
 * "Run not found" for a missing id but "Unauthorized: not a member of this
 * organization" for a foreign id is an existence oracle — any authenticated
 * caller can present well-formed ids and enumerate another org's data.
 *
 * These tests assert EQUALITY OF THE ACTUAL OUTCOMES. Each call is captured as
 * {ok, value} or {ok, error} and the two are compared with toEqual, so a
 * version that returns a record for one id and null for the other FAILS — not
 * merely a version where one throws and the other does not.
 *
 * The counterweight tests in each block are as important as the oracle tests:
 * collapsing "cross-org" into "nothing here" is correct, but collapsing a
 * GENUINE failure into "nothing here" is the null-conflation that was removed
 * elsewhere this cycle and must not come back. So each block also proves that a
 * legitimate caller still gets real data, that an unauthenticated caller still
 * throws, and (where a role gate exists) that an under-privileged caller still
 * throws.
 *
 * Structure follows convex/projection_verify.test.ts, the reference.
 */
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

/** Capture an outcome as a comparable value: the resolved value or the thrown message. */
async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function seedTwoOrgs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const orgA = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_a', name: 'Org A', slug: 'org-a', plan: 'free', createdAt: now, updatedAt: now,
    })
    const orgB = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_b', name: 'Org B', slug: 'org-b', plan: 'free', createdAt: now, updatedAt: now,
    })

    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const projectB = await ctx.db.insert('projects', { orgId: orgB, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent A', slug: 'a', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projectB, name: 'Agent B', slug: 'b', createdAt: now, updatedAt: now })

    // admin_a / user_a / viewer_a see org A only. user_b sees org B only.
    await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_a', orgId: orgA, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'viewer_a', orgId: orgA, role: 'viewer', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_b', orgId: orgB, role: 'member', joinedAt: now })

    return { orgA, orgB, projectA, projectB, agentA, agentB }
  })
}

async function seedRun(
  t: ReturnType<typeof convexTest>,
  orgId: any,
  projectId: any,
  agentId: any,
  overrides: Record<string, unknown> = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    return await ctx.db.insert('runs', {
      orgId, projectId, agentId, status: 'completed',
      startedAt: now - 1000, endedAt: now, metadata: {}, tags: [],
      ...overrides,
    } as any)
  })
}

/**
 * Produce a syntactically valid Id that refers to no document, by inserting a
 * row and deleting it. A caller probing for ids is doing exactly this:
 * presenting well-formed ids and reading the response.
 */
async function dangling(t: ReturnType<typeof convexTest>, table: string, doc: Record<string, unknown>) {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert(table as any, doc as any)
    await ctx.db.delete(id)
    return id
  })
}

async function danglingRunId(t: ReturnType<typeof convexTest>, orgA: any, projectA: any, agentA: any) {
  const runId = await seedRun(t, orgA, projectA, agentA)
  await t.run(async (ctx) => { await ctx.db.delete(runId) })
  return runId
}

const asAdminA = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'admin_a', org_id: 'clerk_a' })
const asUserA = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
const asViewerA = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'viewer_a', org_id: 'clerk_a' })

// ===========================================================================
// runs.ts
// ===========================================================================

describe('runs.getRun — the confirmed defect', () => {
  it('a cross-org runId and a nonexistent runId produce deep-equal outcomes', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB)
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() => asUserA(t).query(api.runs.getRun, { runId: foreign }))
    const nonexistent = await outcome(() => asUserA(t).query(api.runs.getRun, { runId: missing }))

    // Before the fix: crossOrg.error was "Unauthorized: not a member of this
    // organization" while nonexistent.error was "Run not found" — and
    // apps/web's export route mapped that split onto HTTP 500 vs 404.
    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.ok).toBe(false)
    expect(crossOrg.error).toMatch(/Run not found/)
    expect(crossOrg.error).not.toMatch(/not a member/)
  })

  // --- counterweight ------------------------------------------------------

  it('still returns the real run for a caller who CAN see it', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { tags: ['nightly'] })

    const run = await asUserA(t).query(api.runs.getRun, { runId })
    expect(run._id).toEqual(runId)
    expect(run.orgId).toEqual(orgA)
    expect(run.tags).toEqual(['nightly'])
  })

  it('an unauthenticated caller gets an ERROR, not a silent miss', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    await expect(t.query(api.runs.getRun, { runId })).rejects.toThrow(/Unauthorized/)
  })

  it('a caller with no org context gets an ERROR', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    await expect(
      t.withIdentity({ subject: 'user_a' }).query(api.runs.getRun, { runId }),
    ).rejects.toThrow(/Unauthorized/)
  })

  it('a caller whose active org has no membership row gets an ERROR', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    await expect(
      t.withIdentity({ subject: 'nobody', org_id: 'clerk_a' }).query(api.runs.getRun, { runId }),
    ).rejects.toThrow(/not a member/)
  })
})

describe('runs — write paths (higher severity than reads)', () => {
  it('updateRunStatus: cross-org and nonexistent are deep-equal, and nothing is written', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'running', endedAt: undefined })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() =>
      asAdminA(t).mutation(api.runs.updateRunStatus, { runId: foreign, status: 'completed' }))
    const nonexistent = await outcome(() =>
      asAdminA(t).mutation(api.runs.updateRunStatus, { runId: missing, status: 'completed' }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)

    // The other org's run is untouched and no audit row was written into it.
    const after = await t.run(async (ctx) => await ctx.db.get(foreign))
    expect(after!.status).toBe('running')
    const audit = await t.run(async (ctx) => await ctx.db.query('audit_log').collect())
    expect(audit).toHaveLength(0)
  })

  it('updateRunTags: cross-org and nonexistent are deep-equal, tags unchanged', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB, { tags: ['orig'] })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() =>
      asAdminA(t).mutation(api.runs.updateRunTags, { runId: foreign, tags: ['pwned'] }))
    const nonexistent = await outcome(() =>
      asAdminA(t).mutation(api.runs.updateRunTags, { runId: missing, tags: ['pwned'] }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
    const after = await t.run(async (ctx) => await ctx.db.get(foreign))
    expect(after!.tags).toEqual(['orig'])
  })

  it('setRunLabels: cross-org and nonexistent are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB)
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() =>
      asUserA(t).mutation(api.runs.setRunLabels, { runId: foreign, labels: ['x'] }))
    const nonexistent = await outcome(() =>
      asUserA(t).mutation(api.runs.setRunLabels, { runId: missing, labels: ['x'] }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
  })

  it('setRunTriage: a foreign FAILED run is indistinguishable from a missing one', async () => {
    // Extra bite here: the run status is part of the response surface
    // ("Triage state can only be set on failed or timed_out runs (current
    // status X)"). A foreign run must not reach that branch at all.
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'failed' })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() =>
      asUserA(t).mutation(api.runs.setRunTriage, { runId: foreign, triageState: 'investigating' }))
    const nonexistent = await outcome(() =>
      asUserA(t).mutation(api.runs.setRunTriage, { runId: missing, triageState: 'investigating' }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
    const after = await t.run(async (ctx) => await ctx.db.get(foreign))
    expect(after!.triageState).toBeUndefined()
  })

  it('listChildRuns: cross-org and nonexistent parents are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreignParent = await seedRun(t, orgB, projectB, agentB)
    await seedRun(t, orgB, projectB, agentB, { parentRunId: foreignParent })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() =>
      asUserA(t).query(api.runs.listChildRuns, { parentRunId: foreignParent }))
    const nonexistent = await outcome(() =>
      asUserA(t).query(api.runs.listChildRuns, { parentRunId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
  })

  // --- counterweight ------------------------------------------------------

  it('a legitimate admin still transitions a run in their own org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'running', endedAt: undefined })

    const updated = await asAdminA(t).mutation(api.runs.updateRunStatus, { runId, status: 'completed' })
    expect(updated!.status).toBe('completed')
  })

  it('a member (non-admin) is still refused updateRunStatus on ROLE grounds', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'running', endedAt: undefined })

    await expect(
      asUserA(t).mutation(api.runs.updateRunStatus, { runId, status: 'completed' }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('a viewer is still refused setRunLabels on ROLE grounds', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    await expect(
      asViewerA(t).mutation(api.runs.setRunLabels, { runId, labels: ['x'] }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('genuine domain errors still surface for a run the caller CAN see', async () => {
    // Not-swallowed check: a real, legitimate validation failure must remain a
    // loud, specific error — it must not be flattened into "Run not found".
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'completed' })

    await expect(
      asUserA(t).mutation(api.runs.setRunTriage, { runId, triageState: 'investigating' }),
    ).rejects.toThrow(/can only be set on failed or timed_out runs/)
  })
})

// ===========================================================================
// events.ts — the append-only log
// ===========================================================================

describe('events — read and append paths', () => {
  it('listEvents: cross-org and nonexistent runs are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB)
    await t.run(async (ctx) => {
      await ctx.db.insert('events', {
        orgId: orgB, runId: foreign, type: 'llm.request', sequenceNumber: 1,
        timestamp: Date.now(), payload: { secret: 'org B data' },
      })
    })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() => asUserA(t).query(api.events.listEvents, { runId: foreign }))
    const nonexistent = await outcome(() => asUserA(t).query(api.events.listEvents, { runId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
  })

  it('getEvent: a cross-org eventId and a nonexistent eventId are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreignRun = await seedRun(t, orgB, projectB, agentB)
    const foreignEvent = await t.run(async (ctx) => await ctx.db.insert('events', {
      orgId: orgB, runId: foreignRun, type: 'llm.request', sequenceNumber: 1,
      timestamp: Date.now(), payload: {},
    }))
    const runA = await seedRun(t, orgA, projectA, agentA)
    const missing = await dangling(t, 'events', {
      orgId: orgA, runId: runA, type: 'custom', sequenceNumber: 1, timestamp: Date.now(), payload: {},
    })

    const crossOrg = await outcome(() => asUserA(t).query(api.events.getEvent, { eventId: foreignEvent }))
    const nonexistent = await outcome(() => asUserA(t).query(api.events.getEvent, { eventId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Event not found/)
  })

  it('createEvent: cross-org and nonexistent runs are deep-equal, and nothing is appended', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'running', endedAt: undefined })
    const missing = await danglingRunId(t, orgA, projectA, agentA)
    const payload = { type: 'custom' as const, sequenceNumber: 1, timestamp: Date.now(), payload: {} }

    const crossOrg = await outcome(() =>
      asUserA(t).mutation(api.events.createEvent, { runId: foreign, ...payload }))
    const nonexistent = await outcome(() =>
      asUserA(t).mutation(api.events.createEvent, { runId: missing, ...payload }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)

    // The append-only log of the other org must be completely untouched.
    const events = await t.run(async (ctx) => await ctx.db.query('events').collect())
    expect(events).toHaveLength(0)
  })

  it('createEvent: a foreign run with an EXISTING (runId, seq) is still indistinguishable', async () => {
    // The idempotency read must not run before the tenancy collapse, or a
    // cross-org caller could learn which sequence numbers exist elsewhere.
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'running', endedAt: undefined })
    await t.run(async (ctx) => {
      await ctx.db.insert('events', {
        orgId: orgB, runId: foreign, type: 'custom', sequenceNumber: 1, timestamp: 1, payload: {},
      })
    })
    const missing = await danglingRunId(t, orgA, projectA, agentA)
    const payload = { type: 'custom' as const, sequenceNumber: 1, timestamp: Date.now(), payload: {} }

    const crossOrg = await outcome(() =>
      asUserA(t).mutation(api.events.createEvent, { runId: foreign, ...payload }))
    const nonexistent = await outcome(() =>
      asUserA(t).mutation(api.events.createEvent, { runId: missing, ...payload }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
  })

  // --- counterweight ------------------------------------------------------

  it('a legitimate member still appends to their own org\'s run and reads it back', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'running', endedAt: undefined })

    const created = await asUserA(t).mutation(api.events.createEvent, {
      runId, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: { k: 'v' },
    })
    expect(created.orgId).toEqual(orgA)

    const page = await asUserA(t).query(api.events.listEvents, { runId })
    expect(page.events).toHaveLength(1)
    expect(page.events[0]!.type).toBe('run.started')

    const one = await asUserA(t).query(api.events.getEvent, { eventId: created._id })
    expect(one._id).toEqual(created._id)
  })

  it('a viewer is still refused createEvent on ROLE grounds', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'running', endedAt: undefined })

    await expect(
      asViewerA(t).mutation(api.events.createEvent, {
        runId, type: 'custom', sequenceNumber: 1, timestamp: Date.now(), payload: {},
      }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('appending to a non-running run in the caller\'s OWN org still fails loudly', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'completed' })

    await expect(
      asUserA(t).mutation(api.events.createEvent, {
        runId, type: 'custom', sequenceNumber: 1, timestamp: Date.now(), payload: {},
      }),
    ).rejects.toThrow(/RUN_NOT_ACTIVE|Cannot append event/)
  })

  it('unauthenticated callers still throw on every events entry point', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'running', endedAt: undefined })

    await expect(t.query(api.events.listEvents, { runId })).rejects.toThrow(/Unauthorized/)
    await expect(t.mutation(api.events.createEvent, {
      runId, type: 'custom', sequenceNumber: 1, timestamp: Date.now(), payload: {},
    })).rejects.toThrow(/Unauthorized/)
  })
})

// ===========================================================================
// artifacts.ts — note getArtifact returns null rather than throwing
// ===========================================================================

describe('artifacts', () => {
  const artifactDoc = (orgId: any, runId: any) => ({
    orgId, runId, name: 'blob.json', mimeType: 'application/json', size: 10,
    storageKey: 'k', storageBucket: 'b', checksum: 'c', createdAt: Date.now(),
  })

  it('getArtifact: cross-org and nonexistent both return null (deep-equal)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreignRun = await seedRun(t, orgB, projectB, agentB)
    const foreignArtifact = await t.run(async (ctx) =>
      await ctx.db.insert('artifacts', artifactDoc(orgB, foreignRun) as any))
    const runA = await seedRun(t, orgA, projectA, agentA)
    const missing = await dangling(t, 'artifacts', artifactDoc(orgA, runA))

    const crossOrg = await outcome(() =>
      asUserA(t).query(api.artifacts.getArtifact, { artifactId: foreignArtifact }))
    const nonexistent = await outcome(() =>
      asUserA(t).query(api.artifacts.getArtifact, { artifactId: missing }))

    // Before the fix: nonexistent returned null, cross-org THREW. Now both null.
    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.ok).toBe(true)
    expect(crossOrg.value).toBeNull()
  })

  it('listArtifacts: cross-org and nonexistent runs are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreignRun = await seedRun(t, orgB, projectB, agentB)
    await t.run(async (ctx) => { await ctx.db.insert('artifacts', artifactDoc(orgB, foreignRun) as any) })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() => asUserA(t).query(api.artifacts.listArtifacts, { runId: foreignRun }))
    const nonexistent = await outcome(() => asUserA(t).query(api.artifacts.listArtifacts, { runId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
  })

  it('createArtifact: cross-org and nonexistent runs are deep-equal, nothing written', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB)
    const missing = await danglingRunId(t, orgA, projectA, agentA)
    const body = {
      name: 'x.json', mimeType: 'application/json', size: 1,
      storageKey: 'k', storageBucket: 'b', checksum: 'c',
    }

    const crossOrg = await outcome(() =>
      asUserA(t).mutation(api.artifacts.createArtifact, { runId: foreign, ...body }))
    const nonexistent = await outcome(() =>
      asUserA(t).mutation(api.artifacts.createArtifact, { runId: missing, ...body }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
    const rows = await t.run(async (ctx) => await ctx.db.query('artifacts').collect())
    expect(rows).toHaveLength(0)
  })

  // --- counterweight ------------------------------------------------------

  it('a legitimate member still creates, lists and reads their own artifact', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    const created = await asUserA(t).mutation(api.artifacts.createArtifact, {
      runId, name: 'x.json', mimeType: 'application/json', size: 1,
      storageKey: 'k', storageBucket: 'b', checksum: 'c',
    })
    expect(created.orgId).toEqual(orgA)

    expect(await asUserA(t).query(api.artifacts.listArtifacts, { runId })).toHaveLength(1)

    const fetched = await asUserA(t).query(api.artifacts.getArtifact, { artifactId: created._id })
    expect(fetched).not.toBeNull()
    expect(fetched!.name).toBe('x.json')
  })

  it('getArtifact still THROWS (not null) for an unauthenticated caller', async () => {
    // The null collapse must mean "no such artifact you may see", never
    // "something went wrong" — an unauthenticated caller is the latter.
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    const id = await t.run(async (ctx) =>
      await ctx.db.insert('artifacts', artifactDoc(orgA, runId) as any))

    await expect(t.query(api.artifacts.getArtifact, { artifactId: id })).rejects.toThrow(/Unauthorized/)
    await expect(
      t.withIdentity({ subject: 'nobody', org_id: 'clerk_a' }).query(api.artifacts.getArtifact, { artifactId: id }),
    ).rejects.toThrow(/not a member/)
  })

  it('a viewer is still refused createArtifact on ROLE grounds', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    await expect(
      asViewerA(t).mutation(api.artifacts.createArtifact, {
        runId, name: 'x', mimeType: 'application/json', size: 1,
        storageKey: 'k', storageBucket: 'b', checksum: 'c',
      }),
    ).rejects.toThrow(/Forbidden/)
  })
})

// ===========================================================================
// projects.ts / agents.ts / agent_versions.ts — the hierarchy above runs
// ===========================================================================

describe('projects, agents, agent versions', () => {
  it('getProject: cross-org and nonexistent are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectB } = await seedTwoOrgs(t)
    const missing = await dangling(t, 'projects', {
      orgId: orgA, name: 'gone', slug: 'gone', createdAt: 1, updatedAt: 1,
    })

    const crossOrg = await outcome(() => asUserA(t).query(api.projects.getProject, { projectId: projectB }))
    const nonexistent = await outcome(() => asUserA(t).query(api.projects.getProject, { projectId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Project not found/)
  })

  it('updateProject: cross-org and nonexistent are deep-equal, foreign project unchanged', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectB } = await seedTwoOrgs(t)
    const missing = await dangling(t, 'projects', {
      orgId: orgA, name: 'gone', slug: 'gone', createdAt: 1, updatedAt: 1,
    })

    const crossOrg = await outcome(() =>
      asAdminA(t).mutation(api.projects.updateProject, { projectId: projectB, name: 'pwned' }))
    const nonexistent = await outcome(() =>
      asAdminA(t).mutation(api.projects.updateProject, { projectId: missing, name: 'pwned' }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Project not found/)
    const after = await t.run(async (ctx) => await ctx.db.get(projectB))
    expect(after!.name).toBe('PB')
  })

  it('getAgent / listAgents: cross-org and nonexistent are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, projectB, agentB } = await seedTwoOrgs(t)
    const missingAgent = await dangling(t, 'agents', {
      orgId: orgA, projectId: projectA, name: 'gone', slug: 'gone', createdAt: 1, updatedAt: 1,
    })
    const missingProject = await dangling(t, 'projects', {
      orgId: orgA, name: 'gone', slug: 'gone', createdAt: 1, updatedAt: 1,
    })

    expect(await outcome(() => asUserA(t).query(api.agents.getAgent, { agentId: agentB })))
      .toEqual(await outcome(() => asUserA(t).query(api.agents.getAgent, { agentId: missingAgent })))

    expect(await outcome(() => asUserA(t).query(api.agents.listAgents, { projectId: projectB })))
      .toEqual(await outcome(() => asUserA(t).query(api.agents.listAgents, { projectId: missingProject })))
  })

  it('createAgent: cross-org and nonexistent projects are deep-equal, nothing written', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectB } = await seedTwoOrgs(t)
    const missing = await dangling(t, 'projects', {
      orgId: orgA, name: 'gone', slug: 'gone', createdAt: 1, updatedAt: 1,
    })
    const body = { name: 'Injected', slug: 'injected' }

    const crossOrg = await outcome(() =>
      asAdminA(t).mutation(api.agents.createAgent, { projectId: projectB, ...body }))
    const nonexistent = await outcome(() =>
      asAdminA(t).mutation(api.agents.createAgent, { projectId: missing, ...body }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Project not found/)
    const injected = await t.run(async (ctx) =>
      (await ctx.db.query('agents').collect()).filter((a: any) => a.slug === 'injected'))
    expect(injected).toHaveLength(0)
  })

  it('getAgentVersion: cross-org and nonexistent both return null (deep-equal)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await t.run(async (ctx) => await ctx.db.insert('agent_versions', {
      agentId: agentB, orgId: orgB, version: 'v9', createdAt: Date.now(),
    }))
    const missing = await dangling(t, 'agent_versions', {
      agentId: agentA, orgId: orgA, version: 'gone', createdAt: 1,
    })

    const crossOrg = await outcome(() =>
      asUserA(t).query(api.agent_versions.getAgentVersion, { versionId: foreign }))
    const nonexistent = await outcome(() =>
      asUserA(t).query(api.agent_versions.getAgentVersion, { versionId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.ok).toBe(true)
    expect(crossOrg.value).toBeNull()
  })

  it('listAgentVersions / paginateAgentVersions: cross-org and nonexistent are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentB } = await seedTwoOrgs(t)
    await t.run(async (ctx) => { await ctx.db.insert('agent_versions', {
      agentId: agentB, orgId: orgB, version: 'v9', createdAt: Date.now(),
    }) })
    const missing = await dangling(t, 'agents', {
      orgId: orgA, projectId: projectA, name: 'gone', slug: 'gone', createdAt: 1, updatedAt: 1,
    })

    expect(await outcome(() => asUserA(t).query(api.agent_versions.listAgentVersions, { agentId: agentB })))
      .toEqual(await outcome(() => asUserA(t).query(api.agent_versions.listAgentVersions, { agentId: missing })))

    expect(await outcome(() =>
      asUserA(t).query(api.agent_versions.paginateAgentVersions, { agentId: agentB, cursor: null })))
      .toEqual(await outcome(() =>
        asUserA(t).query(api.agent_versions.paginateAgentVersions, { agentId: missing, cursor: null })))
  })

  it('createAgentVersion: a foreign agent is indistinguishable, including its version names', async () => {
    // The uniqueness scan produces `Version "v9" already exists for this agent`.
    // A cross-org caller must never reach it, or it becomes a second oracle
    // over another org's version strings.
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentB } = await seedTwoOrgs(t)
    await t.run(async (ctx) => { await ctx.db.insert('agent_versions', {
      agentId: agentB, orgId: orgB, version: 'v9', createdAt: Date.now(),
    }) })
    const missing = await dangling(t, 'agents', {
      orgId: orgA, projectId: projectA, name: 'gone', slug: 'gone', createdAt: 1, updatedAt: 1,
    })

    const crossOrg = await outcome(() =>
      asAdminA(t).mutation(api.agent_versions.createAgentVersion, { agentId: agentB, version: 'v9' }))
    const nonexistent = await outcome(() =>
      asAdminA(t).mutation(api.agent_versions.createAgentVersion, { agentId: missing, version: 'v9' }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Agent not found/)
    expect(crossOrg.error).not.toMatch(/already exists/)
  })

  // --- counterweight ------------------------------------------------------

  it('legitimate callers still read and write their own hierarchy', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)

    const project = await asUserA(t).query(api.projects.getProject, { projectId: projectA })
    expect(project.name).toBe('P')

    const agent = await asUserA(t).query(api.agents.getAgent, { agentId: agentA })
    expect(agent.name).toBe('Agent A')

    expect(await asUserA(t).query(api.agents.listAgents, { projectId: projectA })).toHaveLength(1)

    const version = await asAdminA(t).mutation(api.agent_versions.createAgentVersion, {
      agentId: agentA, version: 'v1',
    })
    expect(version.orgId).toEqual(orgA)

    expect(await asUserA(t).query(api.agent_versions.listAgentVersions, { agentId: agentA })).toHaveLength(1)
    const got = await asUserA(t).query(api.agent_versions.getAgentVersion, { versionId: version._id })
    expect(got).not.toBeNull()
    expect(got!.version).toBe('v1')
  })

  it('duplicate-version errors still surface for the caller\'s OWN agent', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seedTwoOrgs(t)
    await asAdminA(t).mutation(api.agent_versions.createAgentVersion, { agentId: agentA, version: 'v1' })

    await expect(
      asAdminA(t).mutation(api.agent_versions.createAgentVersion, { agentId: agentA, version: 'v1' }),
    ).rejects.toThrow(/already exists/)
  })

  it('a member (non-admin) is still refused createAgent and createAgentVersion', async () => {
    const t = convexTest(schema, modules)
    const { projectA, agentA } = await seedTwoOrgs(t)

    await expect(
      asUserA(t).mutation(api.agents.createAgent, { projectId: projectA, name: 'N', slug: 'n' }),
    ).rejects.toThrow(/Forbidden/)
    await expect(
      asUserA(t).mutation(api.agent_versions.createAgentVersion, { agentId: agentA, version: 'v2' }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('getAgentVersion still THROWS (not null) for an unauthenticated caller', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seedTwoOrgs(t)
    const id = await t.run(async (ctx) => await ctx.db.insert('agent_versions', {
      agentId: agentA, orgId: orgA, version: 'v1', createdAt: Date.now(),
    }))

    await expect(t.query(api.agent_versions.getAgentVersion, { versionId: id })).rejects.toThrow(/Unauthorized/)
  })
})

// ===========================================================================
// comments.ts / evals.ts
// ===========================================================================

describe('comments and evals', () => {
  it('resolveComment: cross-org and nonexistent are deep-equal, foreign comment unresolved', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)

    const foreignRun = await seedRun(t, orgB, projectB, agentB)
    const foreign = await t.run(async (ctx) => await ctx.db.insert('comments', {
      orgId: orgB, targetId: String(foreignRun), targetType: 'run',
      authorId: 'user_b', content: 'org B note', createdAt: Date.now(),
    }))
    const missing = await dangling(t, 'comments', {
      orgId: orgA, targetId: 'x', targetType: 'run', authorId: 'user_a', content: 'gone', createdAt: 1,
    })

    const crossOrg = await outcome(() =>
      asUserA(t).mutation(api.comments.resolveComment, { commentId: foreign }))
    const nonexistent = await outcome(() =>
      asUserA(t).mutation(api.comments.resolveComment, { commentId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Comment not found/)
    const after = await t.run(async (ctx) => await ctx.db.get(foreign))
    expect(after!.resolvedAt).toBeUndefined()
  })

  it('recordEval / listEvalsForRun: cross-org and nonexistent runs are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB)
    const missing = await danglingRunId(t, orgA, projectA, agentA)
    const body = { name: 'suite', kind: 'rule' as const, passed: true }

    expect(await outcome(() => asUserA(t).mutation(api.evals.recordEval, { runId: foreign, ...body })))
      .toEqual(await outcome(() => asUserA(t).mutation(api.evals.recordEval, { runId: missing, ...body })))

    expect(await outcome(() => asUserA(t).query(api.evals.listEvalsForRun, { runId: foreign })))
      .toEqual(await outcome(() => asUserA(t).query(api.evals.listEvalsForRun, { runId: missing })))

    const rows = await t.run(async (ctx) => await ctx.db.query('evals').collect())
    expect(rows).toHaveLength(0)
  })

  // --- counterweight ------------------------------------------------------

  it('legitimate comment and eval flows still work end to end', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    const comment = await asUserA(t).mutation(api.comments.createComment, {
      orgId: orgA, targetId: String(runId), targetType: 'run', content: 'looks wrong',
    })
    const resolved = await asUserA(t).mutation(api.comments.resolveComment, { commentId: comment._id })
    expect(resolved!.resolvedAt).toBeDefined()
    expect(resolved!.resolvedBy).toBe('user_a')

    const ev = await asUserA(t).mutation(api.evals.recordEval, {
      runId, name: 'suite', kind: 'rule', passed: false,
    })
    expect(ev.orgId).toEqual(orgA)
    const list = await asUserA(t).query(api.evals.listEvalsForRun, { runId })
    expect(list).toHaveLength(1)
    expect(list[0]!.passed).toBe(false)
  })

  it('resolving an ALREADY-resolved comment in the caller\'s own org still errors specifically', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    const comment = await asUserA(t).mutation(api.comments.createComment, {
      orgId: orgA, targetId: String(runId), targetType: 'run', content: 'x',
    })
    await asUserA(t).mutation(api.comments.resolveComment, { commentId: comment._id })

    await expect(
      asUserA(t).mutation(api.comments.resolveComment, { commentId: comment._id }),
    ).rejects.toThrow(/already resolved/)
  })

  it('a viewer is still refused resolveComment and recordEval', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    const comment = await asUserA(t).mutation(api.comments.createComment, {
      orgId: orgA, targetId: String(runId), targetType: 'run', content: 'x',
    })

    await expect(
      asViewerA(t).mutation(api.comments.resolveComment, { commentId: comment._id }),
    ).rejects.toThrow(/Forbidden/)
    await expect(
      asViewerA(t).mutation(api.evals.recordEval, { runId, name: 's', kind: 'rule', passed: true }),
    ).rejects.toThrow(/Forbidden/)
  })
})

// ===========================================================================
// alerts.ts / api_keys.ts / webhooks.ts — admin-gated configuration
// ===========================================================================

describe('alerts, api keys, webhooks', () => {
  const ruleDoc = (orgId: any, name = 'R') => ({
    orgId, name, kind: 'run_failed', channels: [{ type: 'email', target: 'x@y.z' }],
    enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
  })
  const keyDoc = (orgId: any) => ({
    orgId, keyHash: 'h', name: 'K', createdBy: 'user_b', createdAt: Date.now(),
  })
  const hookDoc = (orgId: any) => ({
    orgId, url: 'https://example.com/hook', secret: 's', events: ['run.failed'],
    enabled: true, createdAt: Date.now(),
  })

  it('updateAlertRule / deleteAlertRule / listAlertEventsForRule: deep-equal outcomes', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB } = await seedTwoOrgs(t)

    const foreign = await t.run(async (ctx) => await ctx.db.insert('alert_rules', ruleDoc(orgB, 'orgB rule') as any))
    const missing = await dangling(t, 'alert_rules', ruleDoc(orgA, 'gone'))

    expect(await outcome(() => asAdminA(t).mutation(api.alerts.updateAlertRule, { ruleId: foreign, name: 'pwned' })))
      .toEqual(await outcome(() => asAdminA(t).mutation(api.alerts.updateAlertRule, { ruleId: missing, name: 'pwned' })))

    expect(await outcome(() => asAdminA(t).query(api.alerts.listAlertEventsForRule, { ruleId: foreign })))
      .toEqual(await outcome(() => asAdminA(t).query(api.alerts.listAlertEventsForRule, { ruleId: missing })))

    expect(await outcome(() => asAdminA(t).mutation(api.alerts.deleteAlertRule, { ruleId: foreign })))
      .toEqual(await outcome(() => asAdminA(t).mutation(api.alerts.deleteAlertRule, { ruleId: missing })))

    // The other org's rule survived the delete attempt unmodified.
    const after = await t.run(async (ctx) => await ctx.db.get(foreign))
    expect(after).not.toBeNull()
    expect(after!.name).toBe('orgB rule')
  })

  it('revokeApiKey: cross-org and nonexistent are deep-equal, foreign key still live', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB } = await seedTwoOrgs(t)

    const foreign = await t.run(async (ctx) => await ctx.db.insert('api_keys', keyDoc(orgB) as any))
    const missing = await dangling(t, 'api_keys', keyDoc(orgA))

    const crossOrg = await outcome(() => asAdminA(t).mutation(api.api_keys.revokeApiKey, { keyId: foreign }))
    const nonexistent = await outcome(() => asAdminA(t).mutation(api.api_keys.revokeApiKey, { keyId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/API key not found/)
    const after = await t.run(async (ctx) => await ctx.db.get(foreign))
    expect(after!.revokedAt).toBeUndefined()
  })

  it('deleteWebhook / listWebhookDeliveries: deep-equal outcomes, foreign hook survives', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB } = await seedTwoOrgs(t)

    const foreign = await t.run(async (ctx) => await ctx.db.insert('webhook_targets', hookDoc(orgB) as any))
    const missing = await dangling(t, 'webhook_targets', hookDoc(orgA))

    expect(await outcome(() => asAdminA(t).query(api.webhooks.listWebhookDeliveries, { webhookId: foreign })))
      .toEqual(await outcome(() => asAdminA(t).query(api.webhooks.listWebhookDeliveries, { webhookId: missing })))

    expect(await outcome(() => asAdminA(t).mutation(api.webhooks.deleteWebhook, { webhookId: foreign })))
      .toEqual(await outcome(() => asAdminA(t).mutation(api.webhooks.deleteWebhook, { webhookId: missing })))

    const after = await t.run(async (ctx) => await ctx.db.get(foreign))
    expect(after).not.toBeNull()
  })

  // --- counterweight ------------------------------------------------------

  it('a legitimate admin still manages their own org\'s configuration', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)

    const rule = await t.run(async (ctx) => await ctx.db.insert('alert_rules', ruleDoc(orgA, 'mine') as any))
    const updated = await asAdminA(t).mutation(api.alerts.updateAlertRule, { ruleId: rule, name: 'renamed' })
    expect(updated!.name).toBe('renamed')
    expect(await asAdminA(t).query(api.alerts.listAlertEventsForRule, { ruleId: rule })).toEqual([])
    expect(await asAdminA(t).mutation(api.alerts.deleteAlertRule, { ruleId: rule })).toEqual({ deleted: true })

    const key = await t.run(async (ctx) => await ctx.db.insert('api_keys', keyDoc(orgA) as any))
    const revoked = await asAdminA(t).mutation(api.api_keys.revokeApiKey, { keyId: key })
    expect(revoked!.revokedAt).toBeDefined()

    const hook = await t.run(async (ctx) => await ctx.db.insert('webhook_targets', hookDoc(orgA) as any))
    expect(await asAdminA(t).query(api.webhooks.listWebhookDeliveries, { webhookId: hook })).toEqual([])
    expect(await asAdminA(t).mutation(api.webhooks.deleteWebhook, { webhookId: hook })).toEqual({ deleted: true })
  })

  it('revoking an ALREADY-revoked key in the caller\'s own org still errors specifically', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const key = await t.run(async (ctx) => await ctx.db.insert('api_keys', {
      ...keyDoc(orgA), revokedAt: Date.now(),
    } as any))

    await expect(
      asAdminA(t).mutation(api.api_keys.revokeApiKey, { keyId: key }),
    ).rejects.toThrow(/already revoked/)
  })

  it('a member (non-admin) is still refused every admin-gated entry point', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const rule = await t.run(async (ctx) => await ctx.db.insert('alert_rules', ruleDoc(orgA) as any))
    const key = await t.run(async (ctx) => await ctx.db.insert('api_keys', keyDoc(orgA) as any))
    const hook = await t.run(async (ctx) => await ctx.db.insert('webhook_targets', hookDoc(orgA) as any))

    await expect(asUserA(t).mutation(api.alerts.updateAlertRule, { ruleId: rule, name: 'x' })).rejects.toThrow(/Forbidden/)
    await expect(asUserA(t).mutation(api.alerts.deleteAlertRule, { ruleId: rule })).rejects.toThrow(/Forbidden/)
    await expect(asUserA(t).mutation(api.api_keys.revokeApiKey, { keyId: key })).rejects.toThrow(/Forbidden/)
    await expect(asUserA(t).mutation(api.webhooks.deleteWebhook, { webhookId: hook })).rejects.toThrow(/Forbidden/)
    await expect(asUserA(t).query(api.webhooks.listWebhookDeliveries, { webhookId: hook })).rejects.toThrow(/Forbidden/)
  })
})

// ===========================================================================
// run_explanations.ts — including the regenerate ACTION (write path)
// ===========================================================================

describe('run_explanations', () => {
  it('getRunExplanation: cross-org and nonexistent runs are deep-equal', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'failed' })
    await t.run(async (ctx) => { await ctx.db.insert('run_explanations', {
      orgId: orgB, runId: foreign, kind: 'heuristic', summary: 'org B secret',
      rootCause: 'rc', citedSequenceNumbers: [], failureClass: 'tool_error',
      generatedAt: Date.now(), version: 1,
    } as any) })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() =>
      asUserA(t).query(api.run_explanations.getRunExplanation, { runId: foreign }))
    const nonexistent = await outcome(() =>
      asUserA(t).query(api.run_explanations.getRunExplanation, { runId: missing }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
    expect(crossOrg.error).not.toMatch(/not a member/)
  })

  it('regenerateRunExplanation: cross-org and nonexistent runs throw the SAME error', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'failed' })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() =>
      asAdminA(t).action(api.run_explanations.regenerateRunExplanation, { runId: foreign }))
    const nonexistent = await outcome(() =>
      asAdminA(t).action(api.run_explanations.regenerateRunExplanation, { runId: missing }))

    expect(crossOrg.ok).toBe(false)
    expect(nonexistent.ok).toBe(false)
    expect(crossOrg.error).toEqual(nonexistent.error)
    expect(crossOrg.error).toMatch(/Run not found/)
  })

  it('regenerating a cross-org run writes NOTHING into the other org', async () => {
    // This is the write-path property that matters most: before the fix the
    // authorization was performed against run.orgId, i.e. against whichever org
    // the record belonged to.
    const t = convexTest(schema, modules)
    const { orgB, projectB, agentB } = await seedTwoOrgs(t)
    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'failed' })

    await expect(
      asAdminA(t).action(api.run_explanations.regenerateRunExplanation, { runId: foreign }),
    ).rejects.toThrow(/Run not found/)

    expect(await t.run(async (ctx) => await ctx.db.query('run_explanations').collect())).toHaveLength(0)
    expect(await t.run(async (ctx) => await ctx.db.query('audit_log').collect())).toHaveLength(0)
  })

  it('a NON-ADMIN member probing a foreign run cannot learn their own role either', async () => {
    // The old code produced three distinguishable outcomes: "Run not found",
    // "not a member of this organization", and "Forbidden: admin role
    // required" — the last of which leaked membership tier as well. The role
    // gate now precedes any observation of the run, so a non-admin gets the
    // SAME answer for a foreign run as for one in their own org.
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'failed' })
    const own = await seedRun(t, orgA, projectA, agentA, { status: 'failed' })

    const onForeign = await outcome(() =>
      asUserA(t).action(api.run_explanations.regenerateRunExplanation, { runId: foreign }))
    const onOwn = await outcome(() =>
      asUserA(t).action(api.run_explanations.regenerateRunExplanation, { runId: own }))

    expect(onForeign).toEqual(onOwn)
    expect(onForeign.error).toMatch(/Forbidden/)
  })

  // --- counterweight ------------------------------------------------------

  it('still returns a real explanation for a run the caller CAN see', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'failed' })
    await t.run(async (ctx) => { await ctx.db.insert('run_explanations', {
      orgId: orgA, runId, kind: 'heuristic', summary: 'tool blew up',
      rootCause: 'rc', citedSequenceNumbers: [], failureClass: 'tool_error',
      generatedAt: Date.now(), version: 1,
    } as any) })

    const res = await asUserA(t).query(api.run_explanations.getRunExplanation, { runId })
    expect(res.status).toBe('ready')
    expect(res.explanation!.summary).toBe('tool blew up')
  })

  it('a non-eligible run in the caller\'s own org still reports not_eligible, not an error', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'completed' })

    const res = await asUserA(t).query(api.run_explanations.getRunExplanation, { runId })
    expect(res.status).toBe('not_eligible')
    expect(res.explanation).toBeNull()
  })

  it('unauthenticated callers still throw on both entry points', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'failed' })

    await expect(t.query(api.run_explanations.getRunExplanation, { runId })).rejects.toThrow(/Unauthorized/)
    await expect(
      t.action(api.run_explanations.regenerateRunExplanation, { runId }),
    ).rejects.toThrow(/Unauthorized/)
  })

  it('an authenticated caller with NO org context still throws on the regenerate action', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, { status: 'failed' })

    await expect(
      t.withIdentity({ subject: 'admin_a' }).action(api.run_explanations.regenerateRunExplanation, { runId }),
    ).rejects.toThrow(/Unauthorized/)
  })
})

// ===========================================================================
// sdk_ingest.ts — the API-key surface
//
// These functions authenticate with an API key rather than a Clerk session, but
// the tenancy property is identical: a key belongs to exactly one org, and it
// must not be able to tell "this run does not exist" from "this run belongs to
// someone else". Note the ID arguments here are declared v.string() and cast at
// the call site, so a caller can present ANY well-formed Convex ID — including
// one harvested from another tenant — which makes the collapse load-bearing.
// ===========================================================================

describe('sdk_ingest — API-key authenticated surface', () => {
  const KEY_A = 'hash_a'
  const KEY_B = 'hash_b'

  async function seedKeys(t: ReturnType<typeof convexTest>, orgA: any, orgB: any) {
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: KEY_A, name: 'A', createdBy: 'user_a', createdAt: now })
      await ctx.db.insert('api_keys', { orgId: orgB, keyHash: KEY_B, name: 'B', createdBy: 'user_b', createdAt: now })
    })
  }

  it('checkIngestAuth: cross-org and nonexistent runs are deep-equal', async () => {
    // The worst instance: a side-effect-free, unrate-limited pre-flight query.
    // Before the fix it answered "Run not found" vs "Unauthorized", which is a
    // free run-ID existence oracle over every tenant in the deployment.
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)

    const foreign = await seedRun(t, orgB, projectB, agentB)
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() =>
      t.query(api.sdk_ingest.checkIngestAuth, { apiKeyHash: KEY_A, runId: String(foreign) }))
    const nonexistent = await outcome(() =>
      t.query(api.sdk_ingest.checkIngestAuth, { apiKeyHash: KEY_A, runId: String(missing) }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
    expect(crossOrg.error).not.toMatch(/Unauthorized/)
  })

  it('sdkCreateRun: a cross-org agentId is indistinguishable from a missing one', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentB } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)

    const missing = await dangling(t, 'agents', {
      orgId: orgA, projectId: projectA, name: 'gone', slug: 'gone', createdAt: 1, updatedAt: 1,
    })

    const crossOrg = await outcome(() =>
      t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: KEY_A, agentId: String(agentB) }))
    const nonexistent = await outcome(() =>
      t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: KEY_A, agentId: String(missing) }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Agent not found/)

    // No run was created in the other org.
    const runs = await t.run(async (ctx) => await ctx.db.query('runs').collect())
    expect(runs.filter((r: any) => r.orgId === orgB)).toHaveLength(0)
  })

  it('sdkCreateEvents: cross-org and nonexistent runs are deep-equal, log untouched', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)

    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'running', endedAt: undefined })
    const missing = await danglingRunId(t, orgA, projectA, agentA)
    const evt = { type: 'custom', sequenceNumber: 1, timestamp: Date.now(), payload: {} }

    const crossOrg = await outcome(() => t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: KEY_A, events: [{ runId: String(foreign), ...evt }],
    }))
    const nonexistent = await outcome(() => t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: KEY_A, events: [{ runId: String(missing), ...evt }],
    }))

    // The message embeds the probed id, so compare the shape rather than the
    // literal string: both must be the SAME "Run not found: <id>" form, and
    // neither may be the old "Unauthorized".
    expect(crossOrg.ok).toBe(false)
    expect(nonexistent.ok).toBe(false)
    expect(crossOrg.error).toEqual(`Run not found: ${String(foreign)}`)
    expect(nonexistent.error).toEqual(`Run not found: ${String(missing)}`)
    expect(crossOrg.error).not.toMatch(/Unauthorized/)

    const events = await t.run(async (ctx) => await ctx.db.query('events').collect())
    expect(events).toHaveLength(0)
  })

  it('sdkUpdateRunStatus: cross-org and nonexistent are deep-equal, foreign run unchanged', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)

    const foreign = await seedRun(t, orgB, projectB, agentB, { status: 'running', endedAt: undefined })
    const missing = await danglingRunId(t, orgA, projectA, agentA)

    const crossOrg = await outcome(() => t.mutation(api.sdk_ingest.sdkUpdateRunStatus, {
      apiKeyHash: KEY_A, runId: String(foreign), status: 'failed',
    }))
    const nonexistent = await outcome(() => t.mutation(api.sdk_ingest.sdkUpdateRunStatus, {
      apiKeyHash: KEY_A, runId: String(missing), status: 'failed',
    }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
    const after = await t.run(async (ctx) => await ctx.db.get(foreign))
    expect(after!.status).toBe('running')
  })

  it('sdkCreateArtifact: cross-org and nonexistent are deep-equal, nothing written', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)

    const foreign = await seedRun(t, orgB, projectB, agentB)
    const missing = await danglingRunId(t, orgA, projectA, agentA)
    const body = {
      apiKeyHash: KEY_A, name: 'x', mimeType: 'application/json', size: 1,
      storageKey: 'k', storageBucket: 'b', checksum: 'sha',
    }

    const crossOrg = await outcome(() =>
      t.mutation(api.sdk_ingest.sdkCreateArtifact, { ...body, runId: String(foreign) }))
    const nonexistent = await outcome(() =>
      t.mutation(api.sdk_ingest.sdkCreateArtifact, { ...body, runId: String(missing) }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
    expect(await t.run(async (ctx) => await ctx.db.query('artifacts').collect())).toHaveLength(0)
  })

  it('sdkRecordEval: cross-org and nonexistent are deep-equal, nothing written', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)

    const foreign = await seedRun(t, orgB, projectB, agentB)
    const missing = await danglingRunId(t, orgA, projectA, agentA)
    const body = { apiKeyHash: KEY_A, name: 'suite', kind: 'rule' as const, passed: true }

    const crossOrg = await outcome(() =>
      t.mutation(api.sdk_ingest.sdkRecordEval, { ...body, runId: String(foreign) }))
    const nonexistent = await outcome(() =>
      t.mutation(api.sdk_ingest.sdkRecordEval, { ...body, runId: String(missing) }))

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.error).toMatch(/Run not found/)
    expect(await t.run(async (ctx) => await ctx.db.query('evals').collect())).toHaveLength(0)
  })

  // --- counterweight ------------------------------------------------------

  it('a legitimate key still drives a full ingest lifecycle in its OWN org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, agentA } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)

    const created = await t.mutation(api.sdk_ingest.sdkCreateRun, {
      apiKeyHash: KEY_A, agentId: String(agentA),
    })
    const runId = String(created.id)

    expect(await t.query(api.sdk_ingest.checkIngestAuth, { apiKeyHash: KEY_A, runId }))
      .toEqual({ ok: true })

    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: KEY_A,
      events: [{ runId, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} }],
    })
    expect(await t.run(async (ctx) => await ctx.db.query('events').collect())).toHaveLength(1)

    await t.mutation(api.sdk_ingest.sdkCreateArtifact, {
      apiKeyHash: KEY_A, runId, name: 'x', mimeType: 'application/json', size: 1,
      storageKey: 'k', storageBucket: 'b', checksum: 'sha',
    })
    await t.mutation(api.sdk_ingest.sdkRecordEval, {
      apiKeyHash: KEY_A, runId, name: 'suite', kind: 'rule', passed: true,
    })
    await t.mutation(api.sdk_ingest.sdkUpdateRunStatus, {
      apiKeyHash: KEY_A, runId, status: 'completed',
    })

    const run = await t.run(async (ctx) => await ctx.db.get(runId as any))
    expect((run as any).status).toBe('completed')
    expect((run as any).orgId).toEqual(orgA)
  })

  it('a bad / revoked / unscoped key still throws Unauthorized — auth failures stay loud', async () => {
    // The collapse must not have turned genuine key-auth failures into
    // "Run not found". A caller with no valid key is a broken request, not a
    // caller looking at a run that does not exist.
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentA } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)
    const runId = await seedRun(t, orgA, projectA, agentA)

    await expect(
      t.query(api.sdk_ingest.checkIngestAuth, { apiKeyHash: 'no_such_key', runId: String(runId) }),
    ).rejects.toThrow(/Unauthorized/)

    await t.run(async (ctx) => {
      const key = await ctx.db.query('api_keys').filter((q) => q.eq(q.field('keyHash'), KEY_A)).unique()
      await ctx.db.patch(key!._id, { revokedAt: Date.now() })
    })
    await expect(
      t.query(api.sdk_ingest.checkIngestAuth, { apiKeyHash: KEY_A, runId: String(runId) }),
    ).rejects.toThrow(/Unauthorized/)
  })

  it('org B\'s own key still reaches org B\'s run — the collapse is not blanket denial', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)
    await seedKeys(t, orgA, orgB)
    const runB = await seedRun(t, orgB, projectB, agentB)

    expect(await t.query(api.sdk_ingest.checkIngestAuth, { apiKeyHash: KEY_B, runId: String(runB) }))
      .toEqual({ ok: true })
  })
})
