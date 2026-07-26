/* eslint-disable */
/**
 * REPLAY DIVERGENCE — Convex surface verification (convex-test harness, real
 * functions against a real schema).
 *
 * Two properties dominate:
 *
 *  (A) CROSS-ORG ISOLATION IS INDISTINGUISHABLE FROM ABSENCE. Following
 *      convex/tenancy_oracle.test.ts: outcomes are captured as {ok, value} or
 *      {ok, error} and compared with toEqual, so a version that merely throws
 *      DIFFERENT errors for "foreign" vs "missing" still FAILS. This repo has
 *      closed 25 existence oracles; these tests exist so this feature does not
 *      open a 26th.
 *
 *  (B) THE HONESTY PROPERTIES SURVIVE THE PLUMBING. An absent snapshot must
 *      reach the caller as `indeterminate` with a named unassessed reason, a
 *      truncated event scan as `indeterminate`, and a fleet batch must group by
 *      distinct reason — all through the real query, not just the pure engine.
 */
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const CONFIG_A = {
  model: 'gpt-4o',
  systemPrompt: 'be helpful',
  temperature: 0.2,
  max_tokens: 2048,
  capabilities: ['vector_store'],
  tools: [
    { name: 'search_web', parameters: { type: 'object', properties: { query: {} }, required: ['query'] } },
    { name: 'send_email', parameters: { type: 'object', properties: { to: {} }, required: ['to'] } },
  ],
}
/** search_web removed. */
const CONFIG_B = { ...CONFIG_A, tools: [CONFIG_A.tools[1]] }

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const orgA = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_a', name: 'A', slug: 'a', plan: 'free', createdAt: now, updatedAt: now })
    const orgB = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_b', name: 'B', slug: 'b', plan: 'free', createdAt: now, updatedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_a', orgId: orgA, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_b', orgId: orgB, role: 'member', joinedAt: now })

    const projA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const projB = await ctx.db.insert('projects', { orgId: orgB, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projA, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projB, name: 'B', slug: 'b', createdAt: now, updatedAt: now })

    const v1 = await ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: '1.0.0', createdAt: now, configSnapshot: CONFIG_A })
    const v2 = await ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: '2.0.0', createdAt: now, configSnapshot: CONFIG_B })
    const vNoSnapshot = await ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: '3.0.0', createdAt: now })
    const vOtherAgent = await ctx.db.insert('agent_versions', { agentId: agentB, orgId: orgB, version: '1.0.0', createdAt: now, configSnapshot: CONFIG_A })

    // Five runs of v1: three called the removed tool, two did not.
    const runIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const runId = await ctx.db.insert('runs', {
        orgId: orgA, projectId: projA, agentId: agentA, agentVersionId: v1,
        status: 'completed', startedAt: now - i * 1000, endedAt: now, metadata: {}, tags: [],
      })
      runIds.push(runId)
      await ctx.db.insert('events', { runId, orgId: orgA, type: 'run.started', sequenceNumber: 1, timestamp: now, payload: { type: 'run.started' } })
      if (i < 3) {
        await ctx.db.insert('events', { runId, orgId: orgA, type: 'tool.call', sequenceNumber: 2, timestamp: now, payload: { type: 'tool.call', name: 'search_web', input: { query: 'q' }, call_id: 'c' } })
      } else {
        await ctx.db.insert('events', { runId, orgId: orgA, type: 'tool.call', sequenceNumber: 2, timestamp: now, payload: { type: 'tool.call', name: 'send_email', input: { to: 'x' }, call_id: 'c' } })
      }
      await ctx.db.insert('events', { runId, orgId: orgA, type: 'run.completed', sequenceNumber: 3, timestamp: now, payload: { type: 'run.completed' } })
    }

    // A run in org B, for the isolation tests.
    const runB = await ctx.db.insert('runs', {
      orgId: orgB, projectId: projB, agentId: agentB, agentVersionId: vOtherAgent,
      status: 'completed', startedAt: now, endedAt: now, metadata: {}, tags: [],
    })

    // A run that never self-attributed to a version.
    const runNoVersion = await ctx.db.insert('runs', {
      orgId: orgA, projectId: projA, agentId: agentA,
      status: 'completed', startedAt: now, endedAt: now, metadata: {}, tags: [],
    })

    return { orgA, orgB, agentA, v1, v2, vNoSnapshot, vOtherAgent, runIds, runB, runNoVersion }
  })
}

const asA = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
const asB = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'user_b', org_id: 'clerk_b' })

// ===========================================================================
// A. Cross-org isolation
// ===========================================================================

describe('cross-org isolation (no 26th existence oracle)', () => {
  it('compareVersionConfigs: a foreign version id is indistinguishable from a deleted one', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)

    const foreign = await outcome(() =>
      asB(t).query(api.divergence.compareVersionConfigs, { baselineVersionId: s.v1, targetVersionId: s.v2 }),
    )
    // A genuinely absent id: delete one of org A's versions, then ask as B.
    await t.run(async (ctx) => { await ctx.db.delete(s.v2) })
    const missing = await outcome(() =>
      asB(t).query(api.divergence.compareVersionConfigs, { baselineVersionId: s.v1, targetVersionId: s.v2 }),
    )
    expect(foreign).toEqual(missing)
    expect(foreign.ok).toBe(false)
  })

  it('analyzeRun: a foreign run id is indistinguishable from a deleted one', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)

    const foreign = await outcome(() => asB(t).query(api.divergence.analyzeRun, { runId: s.runIds[0] as any, targetVersionId: s.vOtherAgent }))
    await t.run(async (ctx) => { await ctx.db.delete(s.runIds[0] as any) })
    const missing = await outcome(() => asB(t).query(api.divergence.analyzeRun, { runId: s.runIds[0] as any, targetVersionId: s.vOtherAgent }))
    expect(foreign).toEqual(missing)
    expect(foreign.ok).toBe(false)
  })

  it('analyzeFleet: org B cannot analyse org A version pair, and vice versa', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await outcome(() => asB(t).query(api.divergence.analyzeFleet, { baselineVersionId: s.v1, targetVersionId: s.v2 }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('NOT_FOUND')
  })

  it('analyzeFleet never returns another org\'s runs', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeFleet, { baselineVersionId: s.v1, targetVersionId: s.v2 })
    const ids = [...r.provenReasons, ...r.speculativeReasons].flatMap((g: any) => g.representativeRunIds)
    expect(ids).not.toContain(s.runB)
    expect(ids.every((id: string) => s.runIds.includes(id))).toBe(true)
  })

  it('an unauthenticated caller gets nothing', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await outcome(() => t.query(api.divergence.compareVersionConfigs, { baselineVersionId: s.v1, targetVersionId: s.v2 }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Unauthorized')
  })

  it('COUNTERWEIGHT: a legitimate caller still gets real data', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.compareVersionConfigs, { baselineVersionId: s.v1, targetVersionId: s.v2 })
    expect(r.baselineVersion).toBe('1.0.0')
    expect(r.targetVersion).toBe('2.0.0')
    expect(r.coverage.assessed).toContain('tools')
  })
})

// ===========================================================================
// B. Tier 1 — config-only comparison
// ===========================================================================

describe('compareVersionConfigs (zero run reads)', () => {
  it('echoes the ids it was asked about, so an ignored parameter is detectable', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.compareVersionConfigs, { baselineVersionId: s.v1, targetVersionId: s.v2 })
    expect(r.baselineVersionId).toBe(s.v1)
    expect(r.targetVersionId).toBe(s.v2)
  })

  it('reports which proven kinds are still reachable, and emits no proof of its own', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.compareVersionConfigs, { baselineVersionId: s.v1, targetVersionId: s.v2 })
    expect(r.provenKindsReachable).toContain('tool_removed')
    // TIER 1 reads no events, so it can never emit a proven finding — and it
    // deliberately returns no verdict at all rather than a false clean one.
    expect('verdict' in r).toBe(false)
    expect('proven' in r).toBe(false)
    expect(r.coverage.eventHistoryComplete).toBe(false)
    // A tool a run may never have called is NOT pre-reported as removed.
    expect(r.speculative.map((f: any) => f.kind)).not.toContain('tool_removed')
  })

  it('an ABSENT configSnapshot yields target_config_missing — not "no divergences"', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.compareVersionConfigs, { baselineVersionId: s.v1, targetVersionId: s.vNoSnapshot })
    expect(r.coverage.assessed).toEqual([])
    expect(r.snapshotStatus.target).toBe('absent')
    expect(r.coverage.unassessed.length).toBeGreaterThan(0)
    expect(r.coverage.unassessed.every((u: any) => u.reason === 'target_config_missing')).toBe(true)
    expect(r.provenKindsReachable).toEqual([])
  })

  it('refuses to compare versions of different agents', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const otherAgentSameOrg = await t.run(async (ctx) => {
      const now = Date.now()
      const proj = await ctx.db.query('projects').first()
      const agent = await ctx.db.insert('agents', { orgId: s.orgA, projectId: proj!._id, name: 'Other', slug: 'other', createdAt: now, updatedAt: now })
      return await ctx.db.insert('agent_versions', { agentId: agent, orgId: s.orgA, version: '1.0.0', createdAt: now, configSnapshot: CONFIG_A })
    })
    const r = await outcome(() => asA(t).query(api.divergence.compareVersionConfigs, { baselineVersionId: s.v1, targetVersionId: otherAgentSameOrg }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('INVALID_ARGUMENT')
  })
})

// ===========================================================================
// C. Tier 2 — single run
// ===========================================================================

describe('analyzeRun', () => {
  it('proves the removed tool the run actually called, citing the real sequence number', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeRun, { runId: s.runIds[0] as any, targetVersionId: s.v2 })
    expect(r.verdict).toBe('incompatible')
    expect(r.proven.map((p: any) => p.reasonKey)).toContain('tool_removed:search_web')
    const proof = r.proven[0].provenBy[0]
    expect(proof.citedEvent.sequenceNumber).toBe(2)
    expect(proof.citedEvent.eventType).toBe('tool.call')
    expect(proof.targetValue).toBeNull()
    expect(r.nextEventCursor).toBeNull()
  })

  it('a run that used no removed capability is compatible', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeRun, { runId: s.runIds[4] as any, targetVersionId: s.v2 })
    expect(r.proven).toEqual([])
    expect(r.verdict).toBe('compatible')
  })

  it('the same version against itself is compatible', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeRun, { runId: s.runIds[0] as any, targetVersionId: s.v1 })
    expect(r.verdict).toBe('compatible')
  })

  it('an absent target snapshot is indeterminate, not clean', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeRun, { runId: s.runIds[0] as any, targetVersionId: s.vNoSnapshot })
    expect(r.verdict).toBe('indeterminate')
    expect(r.coverage.assessed).toEqual([])
  })

  it('a run with NO recorded agentVersionId is still analysed for PROOF', async () => {
    // The naive design refuses outright. Proven kinds need only the target, so
    // refusing would throw away the answer most worth having.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('events', {
        runId: s.runNoVersion as any, orgId: s.orgA, type: 'tool.call', sequenceNumber: 1, timestamp: Date.now(),
        payload: { type: 'tool.call', name: 'search_web', input: { query: 'q' }, call_id: 'c' },
      })
    })
    const r = await asA(t).query(api.divergence.analyzeRun, { runId: s.runNoVersion as any, targetVersionId: s.v2 })
    expect(r.baselineVersionId).toBeNull()
    expect(r.verdict).toBe('incompatible')
    expect(r.proven.map((p: any) => p.reasonKey)).toContain('tool_removed:search_web')
    expect(r.coverage.unassessed.every((u: any) => u.reason === 'baseline_config_missing')).toBe(true)
  })

  it('a truncated event page is reported and forbids compatible', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    // Run 4 is otherwise compatible; force a one-event page so the scan truncates.
    const r = await asA(t).query(api.divergence.analyzeRun, { runId: s.runIds[4] as any, targetVersionId: s.v1, limit: 1 })
    expect(r.coverage.eventHistoryComplete).toBe(false)
    expect(r.verdict).toBe('indeterminate')
    expect(r.nextEventCursor).not.toBeNull()
  })
})

// ===========================================================================
// D. Tier 3 — fleet
// ===========================================================================

describe('analyzeFleet', () => {
  it('groups the population by distinct reason with accurate counts', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeFleet, { baselineVersionId: s.v1, targetVersionId: s.v2 })

    expect(r.window.runsAnalyzed).toBe(5)
    expect(r.window.runsUnassessable).toBe(0)
    expect(r.runsWithProvenDivergence).toBe(3)
    expect(r.provenReasons).toHaveLength(1)
    expect(r.provenReasons[0].reasonKey).toBe('tool_removed:search_web')
    expect(r.provenReasons[0].affectedRunCount).toBe(3)
    expect(r.verdict).toBe('incompatible')
  })

  it('pages, and an unfinished page is never reported complete', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const first = await asA(t).query(api.divergence.analyzeFleet, { baselineVersionId: s.v1, targetVersionId: s.v1, limit: 2 })
    expect(first.window.runsAnalyzed).toBe(2)
    // Nothing found, but the scan stopped early — that must not read as clean.
    // Expressed as `nextCursor`, not `scanTruncated`: a full, clean page is
    // indistinguishable from a finished scan without it.
    expect(first.window.nextCursor).toBeDefined()
    expect(first.verdict).toBe('indeterminate')
    expect(first.nextCursor).not.toBeNull()

    const second = await asA(t).query(api.divergence.analyzeFleet, { baselineVersionId: s.v1, targetVersionId: s.v1, limit: 2, cursor: first.nextCursor! })
    expect(second.window.runsAnalyzed).toBe(2)
  })

  it('an identical version pair over a complete scan is compatible', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeFleet, { baselineVersionId: s.v1, targetVersionId: s.v1 })
    expect(r.provenReasons).toEqual([])
    expect(r.speculativeReasons).toEqual([])
    expect(r.window.scanTruncated).toBe(false)
    expect(r.window.nextCursor).toBeUndefined()
    expect(r.verdict).toBe('compatible')
  })

  it('an absent snapshot makes the whole fleet indeterminate rather than clean', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeFleet, { baselineVersionId: s.v1, targetVersionId: s.vNoSnapshot })
    expect(r.provenReasons).toEqual([])
    // Every run assessed NOTHING, so every run is unassessable — not clean.
    expect(r.window.runsUnassessable).toBe(5)
    expect(r.verdict).toBe('indeterminate')
  })

  it('echoes the version ids and the agent it scanned', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.divergence.analyzeFleet, { baselineVersionId: s.v1, targetVersionId: s.v2 })
    expect(r.agentId).toBe(s.agentA)
    expect(r.baselineVersionId).toBe(s.v1)
    expect(r.targetVersionId).toBe(s.v2)
  })
})

// ===========================================================================
// E. Field projection must never strip the evidence that an answer is partial
// ===========================================================================

describe('read API field projection', () => {
  async function seedKey(t: ReturnType<typeof convexTest>, orgId: any) {
    return await t.run(async (ctx) => {
      return await ctx.db.insert('api_keys', {
        orgId, name: 'k', keyHash: 'hash_a', createdBy: 'user_a', createdAt: Date.now(), scopes: ['read'],
      })
    })
  }

  it('asking only for `verdict` still returns coverage and the cursor', async () => {
    // The most reasonable request an integrator can make used to produce a
    // conclusion with nothing to caveat it.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await seedKey(t, s.orgA)
    const r: any = await t.mutation(api.read_api.apiGetRunDivergence, {
      apiKeyHash: 'hash_a', runId: s.runIds[0], targetVersionId: s.v2, fields: ['verdict'],
    })
    expect(r.verdict).toBeDefined()
    expect(r).toHaveProperty('coverage')
    expect(r).toHaveProperty('nextEventCursor')
    expect(r.runId).toBe(s.runIds[0])
    expect(r.targetVersionId).toBe(s.v2)
  })

  it('asking only for `proven` also pulls the caveats — an empty array is a conclusion too', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await seedKey(t, s.orgA)
    const r: any = await t.mutation(api.read_api.apiGetRunDivergence, {
      apiKeyHash: 'hash_a', runId: s.runIds[4], targetVersionId: s.v2, fields: ['proven'],
    })
    expect(r.proven).toEqual([])
    expect(r).toHaveProperty('coverage')
    expect(r).toHaveProperty('nextEventCursor')
  })

  it('the fleet form keeps `window` and `nextCursor` — the cursor is what makes exit 11 stick', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await seedKey(t, s.orgA)
    for (const field of ['verdict', 'provenReasons', 'runsWithProvenDivergence']) {
      const r: any = await t.mutation(api.read_api.apiGetFleetDivergence, {
        apiKeyHash: 'hash_a', baselineVersionId: s.v1, targetVersionId: s.v2, limit: 2, fields: [field],
      })
      expect(r, field).toHaveProperty('window')
      expect(r, field).toHaveProperty('nextCursor')
      expect(r.nextCursor).not.toBeNull()
    }
  })

  it('the config tier always carries the reason it cannot prove anything', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await seedKey(t, s.orgA)
    const r: any = await t.mutation(api.read_api.apiCompareVersionConfigs, {
      apiKeyHash: 'hash_a', baselineVersionId: s.v1, targetVersionId: s.v2, fields: ['speculative'],
    })
    expect(r).toHaveProperty('provenKindsReachable')
    expect(r).toHaveProperty('provenUnavailableBecause')
    expect(r).toHaveProperty('snapshotStatus')
  })

  it('a metadata-only projection is left alone — the token saving survives', async () => {
    // No claim is being made, so there is nothing to caveat.
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await seedKey(t, s.orgA)
    const r: any = await t.mutation(api.read_api.apiGetRunDivergence, {
      apiKeyHash: 'hash_a', runId: s.runIds[0], targetVersionId: s.v2, fields: ['analyzedAt'],
    })
    expect(r).not.toHaveProperty('coverage')
    expect(r).not.toHaveProperty('verdict')
    expect(Object.keys(r).sort()).toEqual(['analyzedAt', 'runId', 'targetVersionId'])
  })
})
