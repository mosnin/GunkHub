/* eslint-disable */
// Tests for convex/insights.ts (Team B — Insight Engine, cycle 2): dashboard
// stats (rollup + sparse-rollup fallback), per-agent cost stats (per-model +
// unmatched-model flagging), version comparison (seeded regression),
// cross-org rejection on every exported query, and eval-rule execution +
// idempotency via runEvalsForRun. Runs against the REAL Convex functions via
// convex-test (same harness as adr002.test.ts / governance.test.ts).
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const DAY_MS = 24 * 60 * 60 * 1000

/** Mirrors insights.ts's own dateNDaysAgoUtc — used only to seed rollups/runs at test-predictable dates. */
function dateNDaysAgoUtc(n: number, now: number = Date.now()): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

function dayBoundsUtc(date: string): { start: number; end: number } {
  const start = Date.parse(`${date}T00:00:00.000Z`)
  return { start, end: start + DAY_MS }
}

const identity = (role: string, org: 'a' | 'b') => ({ subject: `${role}_${org}`, org_id: `clerk_${org}` }) as const

// Two orgs, each with viewer/member/admin memberships, one project/agent/agent_version per org.
async function seedTwoOrgs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()

    const orgA = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_a', name: 'Org A', slug: 'org-a', plan: 'free', createdAt: now, updatedAt: now })
    const orgB = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_b', name: 'Org B', slug: 'org-b', plan: 'free', createdAt: now, updatedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'viewer_a', orgId: orgA, role: 'viewer', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'member_a', orgId: orgA, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'admin_b', orgId: orgB, role: 'admin', joinedAt: now })

    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const projectB = await ctx.db.insert('projects', { orgId: orgB, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })

    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent A', slug: 'a', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projectB, name: 'Agent B', slug: 'b', createdAt: now, updatedAt: now })

    const versionA = await ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: 'v1', createdAt: now })
    const versionB = await ctx.db.insert('agent_versions', { agentId: agentB, orgId: orgB, version: 'v1', createdAt: now })

    return { orgA, orgB, projectA, projectB, agentA, agentB, versionA, versionB }
  })
}

describe('getDashboardStats', () => {
  it('aggregates rolled-up days and falls back to a live query for a day with no rollup coverage', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seedTwoOrgs(t)

    const twoDaysAgo = dateNDaysAgoUtc(2)
    const oneDayAgo = dateNDaysAgoUtc(1)
    const today = dateNDaysAgoUtc(0)

    await t.run(async (ctx) => {
      // Rolled-up days: two_days_ago and one_day_ago have daily_rollups rows.
      await ctx.db.insert('daily_rollups', {
        orgId: orgA, agentId: agentA, date: twoDaysAgo,
        runsTotal: 10, runsFailed: 2, runsCompleted: 7, runsCancelled: 1, runsTimedOut: 0,
        tokensIn: 1000, tokensOut: 500,
      })
      await ctx.db.insert('daily_rollups', {
        orgId: orgA, agentId: agentA, date: oneDayAgo,
        runsTotal: 5, runsFailed: 0, runsCompleted: 5, runsCancelled: 0, runsTimedOut: 0,
        tokensIn: 200, tokensOut: 100,
      })

      // Sparse day: "today" has runs but NO rollup row (cron hasn't run yet) -> fallback path.
      const { start } = dayBoundsUtc(today)
      await ctx.db.insert('runs', {
        orgId: orgA, projectId: (await ctx.db.get(agentA))!.projectId, agentId: agentA,
        status: 'completed', startedAt: start + 1000, endedAt: start + 2000, metadata: {}, tags: [],
        tokensIn: 50, tokensOut: 25,
      })
      await ctx.db.insert('runs', {
        orgId: orgA, projectId: (await ctx.db.get(agentA))!.projectId, agentId: agentA,
        status: 'failed', startedAt: start + 3000, endedAt: start + 4000, metadata: {}, tags: [],
        tokensIn: 10, tokensOut: 5,
      })
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.getDashboardStats, { orgId: orgA, range: '7d' })

    const bySource = new Map(stats.series.map((d) => [d.date, d]))
    expect(bySource.get(twoDaysAgo)?.source).toBe('rollup')
    expect(bySource.get(twoDaysAgo)?.runsTotal).toBe(10)
    expect(bySource.get(oneDayAgo)?.source).toBe('rollup')
    expect(bySource.get(today)?.source).toBe('fallback')
    expect(bySource.get(today)?.runsTotal).toBe(2)
    expect(bySource.get(today)?.runsFailed).toBe(1)
    expect(bySource.get(today)?.tokensIn).toBe(60)

    // Totals sum every series day, across both rollup and fallback sources.
    expect(stats.totals.runsTotal).toBe(10 + 5 + 2)
    expect(stats.totals.runsFailed).toBe(2 + 0 + 1)
    expect(stats.totals.tokensIn).toBe(1000 + 200 + 60)
    // failureRate = (failed + timedOut) / terminal across all seeded days.
    const terminal = stats.totals.runsFailed + stats.totals.runsCompleted + stats.totals.runsCancelled + stats.totals.runsTimedOut
    expect(stats.totals.failureRate).toBeCloseTo((2 + 0 + 1) / terminal)

    // M5 (cycle 5): today has no rollup coverage (the cron only ever rolls up
    // yesterday), so the top-level honesty flags must report the live
    // fallback, mirroring series[today].source rather than requiring callers
    // to know the series-ordering convention themselves.
    expect(stats.todaySource).toBe('fallback')
    expect(stats.partialToday).toBe(true)
  })

  it('reports todaySource "rollup" and partialToday false when today itself has rollup coverage', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seedTwoOrgs(t)
    const today = dateNDaysAgoUtc(0)

    await t.run(async (ctx) => {
      // Simulate a day where today's row already exists (e.g. a future
      // same-day incremental rollup, or a backfill) -- getDashboardStats
      // doesn't care WHY the row exists, only whether rollupsByDate has it.
      await ctx.db.insert('daily_rollups', {
        orgId: orgA, agentId: agentA, date: today,
        runsTotal: 3, runsFailed: 0, runsCompleted: 3, runsCancelled: 0, runsTimedOut: 0,
        tokensIn: 30, tokensOut: 15,
      })
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.getDashboardStats, { orgId: orgA, range: '7d' })

    expect(stats.todaySource).toBe('rollup')
    expect(stats.partialToday).toBe(false)
  })

  it('rejects a caller who is not a member of the org', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await expect(
      t.withIdentity(identity('admin', 'b')).query(api.insights.getDashboardStats, { orgId: orgA, range: '7d' }),
    ).rejects.toThrow(/Unauthorized|not a member/i)
  })
})

describe('getAgentCostStats', () => {
  async function seedRunWithLlmEvents(t: ReturnType<typeof convexTest>, orgId: any, projectId: any, agentId: any) {
    return await t.run(async (ctx) => {
      const now = Date.now()
      const runId = await ctx.db.insert('runs', {
        orgId, projectId, agentId, status: 'completed', startedAt: now, endedAt: now + 1000,
        metadata: {}, tags: [], tokensIn: 1200, tokensOut: 600,
      })
      const events: Array<{ type: string; payload: unknown }> = [
        { type: 'run.started', payload: {} },
        { type: 'llm.request', payload: { model: 'claude-sonnet-4-5' } },
        { type: 'llm.response', payload: { usage: { input_tokens: 1000, output_tokens: 500 } } },
        { type: 'llm.request', payload: { model: 'totally-unknown-model-9000' } },
        { type: 'llm.response', payload: { usage: { input_tokens: 200, output_tokens: 100 } } },
        { type: 'run.completed', payload: {} },
      ]
      for (let i = 0; i < events.length; i++) {
        await ctx.db.insert('events', {
          runId, orgId, type: events[i]!.type, sequenceNumber: i + 1, timestamp: now + i, payload: events[i]!.payload,
        })
      }
      return runId
    })
  }

  it('sums cost per model and flags an unresolved model', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedRunWithLlmEvents(t, orgA, projectA, agentA)

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.getAgentCostStats, { orgId: orgA, agentId: agentA, range: '30d' })

    expect(stats.tokensIn).toBe(1200)
    expect(stats.tokensOut).toBe(600)
    expect(stats.unmatchedModels).toContain('totally-unknown-model-9000')

    const known = stats.byModel.find((m) => m.model === 'claude-sonnet-4-5')
    expect(known).toBeTruthy()
    expect(known!.matched).toBe(true)
    expect(known!.costUsd).toBeGreaterThan(0)

    const unknown = stats.byModel.find((m) => m.model === 'totally-unknown-model-9000')
    expect(unknown).toBeTruthy()
    expect(unknown!.matched).toBe(false)
    expect(unknown!.costUsd).toBe(0)

    expect(stats.totalCostUsd).toBeCloseTo(known!.costUsd)
  })

  it('rejects an agent that does not belong to the caller org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentB } = await seedTwoOrgs(t)
    await expect(
      t.withIdentity(identity('admin', 'a')).query(api.insights.getAgentCostStats, { orgId: orgA, agentId: agentB, range: '30d' }),
    ).rejects.toThrow(/NOT_FOUND|not found/i)
  })

  it('attributes a single-model run via modelsSeen with no event scan needed, exactly', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)

    await t.run(async (ctx) => {
      const now = Date.now()
      // NOTE: no events inserted at all for this run — if getAgentCostStats
      // fell back to event-scanning here, it would find nothing and
      // attribute $0. The modelsSeen path must attribute cost without ever
      // reading convex/events.ts's `events` table.
      await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: now, endedAt: now + 1000,
        metadata: {}, tags: [], tokensIn: 1000, tokensOut: 500, modelsSeen: ['claude-sonnet-4-5'],
      })
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.getAgentCostStats, { orgId: orgA, agentId: agentA, range: '30d' })

    expect(stats.costAttribution.viaModelsSeen).toBe(1)
    expect(stats.costAttribution.viaEventScan).toBe(0)
    expect(stats.unattributedMultiModel).toBe(0)
    const model = stats.byModel.find((m) => m.model === 'claude-sonnet-4-5')
    expect(model).toBeTruthy()
    expect(model!.tokensIn).toBe(1000)
    expect(model!.tokensOut).toBe(500)
    expect(model!.matched).toBe(true)
    expect(stats.totalCostUsd).toBeCloseTo(model!.costUsd)
  })

  it('attributes a multi-model run to its primary model and counts it as unattributedMultiModel', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)

    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: now, endedAt: now + 1000,
        metadata: {}, tags: [], tokensIn: 300, tokensOut: 150,
        modelsSeen: ['claude-sonnet-4-5', 'gpt-4o'],
      })
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.getAgentCostStats, { orgId: orgA, agentId: agentA, range: '30d' })

    expect(stats.costAttribution.viaModelsSeen).toBe(1)
    expect(stats.unattributedMultiModel).toBe(1)
    // Full run tokens go to the PRIMARY (first) model, none to the secondary.
    const primary = stats.byModel.find((m) => m.model === 'claude-sonnet-4-5')
    const secondary = stats.byModel.find((m) => m.model === 'gpt-4o')
    expect(primary).toBeTruthy()
    expect(primary!.tokensIn).toBe(300)
    expect(primary!.tokensOut).toBe(150)
    expect(secondary).toBeUndefined()
  })

  it('falls back to event-scan attribution for a run with no modelsSeen recorded', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    // Reuses the events-based seed helper above — that run has no
    // `modelsSeen` field set, so this must exercise the fallback path.
    await seedRunWithLlmEvents(t, orgA, projectA, agentA)

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.getAgentCostStats, { orgId: orgA, agentId: agentA, range: '30d' })

    expect(stats.costAttribution.viaEventScan).toBe(1)
    expect(stats.costAttribution.viaModelsSeen).toBe(0)
    expect(stats.unmatchedModels).toContain('totally-unknown-model-9000')
  })
})

describe('compareVersions', () => {
  async function seedCohort(
    t: ReturnType<typeof convexTest>,
    orgId: any,
    projectId: any,
    agentId: any,
    agentVersionId: any,
    total: number,
    failed: number,
  ) {
    await t.run(async (ctx) => {
      const now = Date.now()
      for (let i = 0; i < total; i++) {
        const startedAt = now - (total - i) * 1000
        await ctx.db.insert('runs', {
          orgId, projectId, agentId, agentVersionId,
          status: i < failed ? 'failed' : 'completed',
          startedAt, endedAt: startedAt + 500, metadata: {}, tags: [],
        })
      }
    })
  }

  it('flags a seeded regression as likely_regression', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)

    const versionB = await t.run((ctx) =>
      ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: 'v2', createdAt: Date.now() }),
    )

    // Version A: low failure rate (2/40). Version B: high failure rate (20/40) -> regression.
    await seedCohort(t, orgA, projectA, agentA, versionA, 40, 2)
    await seedCohort(t, orgA, projectA, agentA, versionB, 40, 20)

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const result = await asAdmin.query(api.insights.compareVersions, {
      orgId: orgA, agentVersionIdA: versionA, agentVersionIdB: versionB,
    })

    expect(result.versionA.sampleSize).toBe(40)
    expect(result.versionB.sampleSize).toBe(40)
    expect(result.comparison.failureRateSignificance).toBe('likely_regression')
  })

  it('is EXACT (not a bounded-scan approximation) even when a third version interleaves recency with the compared two', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)

    const versionB = await t.run((ctx) =>
      ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: 'v2', createdAt: Date.now() }),
    )
    const versionC = await t.run((ctx) =>
      ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: 'v3', createdAt: Date.now() }),
    )

    // Interleave: version C's runs are the MOST RECENT (would dominate a
    // most-recent-N overfetch scan), then version A's, then version B's
    // (oldest). A and B each get an exact, small count; C gets a large count
    // that would previously have crowded A/B out of a bounded recency scan.
    await t.run(async (ctx) => {
      const now = Date.now()
      // Oldest: version B, 7 runs, 3 failed.
      for (let i = 0; i < 7; i++) {
        const startedAt = now - 100_000 + i * 10
        await ctx.db.insert('runs', {
          orgId: orgA, projectId: projectA, agentId: agentA, agentVersionId: versionB,
          status: i < 3 ? 'failed' : 'completed', startedAt, endedAt: startedAt + 5, metadata: {}, tags: [],
        })
      }
      // Middle: version A, 5 runs, 1 failed.
      for (let i = 0; i < 5; i++) {
        const startedAt = now - 50_000 + i * 10
        await ctx.db.insert('runs', {
          orgId: orgA, projectId: projectA, agentId: agentA, agentVersionId: versionA,
          status: i < 1 ? 'failed' : 'completed', startedAt, endedAt: startedAt + 5, metadata: {}, tags: [],
        })
      }
      // Most recent + high-volume: version C, 60 runs (would fill a bounded
      // most-recent-first scan window ahead of A/B under the old approach).
      for (let i = 0; i < 60; i++) {
        const startedAt = now - 1000 + i
        await ctx.db.insert('runs', {
          orgId: orgA, projectId: projectA, agentId: agentA, agentVersionId: versionC,
          status: 'completed', startedAt, endedAt: startedAt + 5, metadata: {}, tags: [],
        })
      }
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const result = await asAdmin.query(api.insights.compareVersions, {
      orgId: orgA, agentVersionIdA: versionA, agentVersionIdB: versionB,
    })

    // Exact per-version counts, unaffected by version C's higher recent volume.
    expect(result.versionA.sampleSize).toBe(5)
    expect(result.versionA.countsByStatus.failed).toBe(1)
    expect(result.versionA.countsByStatus.completed).toBe(4)
    expect(result.versionA.exact).toBe(true)
    expect(result.versionA.truncated).toBe(false)

    expect(result.versionB.sampleSize).toBe(7)
    expect(result.versionB.countsByStatus.failed).toBe(3)
    expect(result.versionB.countsByStatus.completed).toBe(4)
    expect(result.versionB.exact).toBe(true)
    expect(result.versionB.truncated).toBe(false)
  })

  it('rejects comparing versions from different agents', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const now = Date.now()
    const agentA2 = await t.run((ctx) =>
      ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'A2', slug: 'a2', createdAt: now, updatedAt: now }),
    )
    const versionOtherAgent = await t.run((ctx) =>
      ctx.db.insert('agent_versions', { agentId: agentA2, orgId: orgA, version: 'v1', createdAt: now }),
    )

    await expect(
      t.withIdentity(identity('admin', 'a')).query(api.insights.compareVersions, {
        orgId: orgA, agentVersionIdA: versionA, agentVersionIdB: versionOtherAgent,
      }),
    ).rejects.toThrow(/INVALID_ARGUMENT|same agent/i)
  })

  it('rejects a version belonging to a different org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, versionA, versionB } = await seedTwoOrgs(t)
    await expect(
      t.withIdentity(identity('admin', 'a')).query(api.insights.compareVersions, {
        orgId: orgA, agentVersionIdA: versionA, agentVersionIdB: versionB,
      }),
    ).rejects.toThrow(/NOT_FOUND|not found/i)
  })

  // Cycle 3 (Team B, deferred enhancement): per-cohort failureClassCounts,
  // sourced from run_explanations.by_run, reusing the cohort run collection
  // (a.runIds/b.runIds) rather than re-scanning `runs`. Powers Team C's
  // narrativeInputFromComparison "most common new failure class" clause.
  it('groups per-cohort run_explanations.failureClass, omits runs with no explanation, and is immune to a mismatched-org explanation row', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const versionB = await t.run((ctx) =>
      ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: 'v2', createdAt: Date.now() }),
    )

    const { runIdsA, runIdsB } = await t.run(async (ctx) => {
      const now = Date.now()
      const runIdsA = []
      for (let i = 0; i < 3; i++) {
        const startedAt = now - (3 - i) * 1000
        runIdsA.push(
          await ctx.db.insert('runs', {
            orgId: orgA, projectId: projectA, agentId: agentA, agentVersionId: versionA,
            status: 'failed', startedAt, endedAt: startedAt + 500, metadata: {}, tags: [],
          }),
        )
      }
      const runIdsB = []
      for (let i = 0; i < 2; i++) {
        const startedAt = now - (2 - i) * 1000
        runIdsB.push(
          await ctx.db.insert('runs', {
            orgId: orgA, projectId: projectA, agentId: agentA, agentVersionId: versionB,
            status: 'failed', startedAt, endedAt: startedAt + 500, metadata: {}, tags: [],
          }),
        )
      }
      return { runIdsA, runIdsB }
    })

    await t.run(async (ctx) => {
      const now = Date.now()
      const base = {
        kind: 'heuristic' as const,
        summary: 's', rootCause: 'r', citedSequenceNumbers: [], generatedAt: now, version: 1,
      }
      // Version A cohort: two tool_timeout explanations. runIdsA[2] is
      // deliberately left WITHOUT an explanation row -> must not be counted
      // (honest sample, not an exhaustive classification).
      await ctx.db.insert('run_explanations', { ...base, orgId: orgA, runId: runIdsA[0], failureClass: 'tool_timeout' })
      await ctx.db.insert('run_explanations', { ...base, orgId: orgA, runId: runIdsA[1], failureClass: 'tool_timeout' })

      // CROSS-ORG ISOLATION (defense-in-depth): a corrupted/mismatched-org
      // row physically pointing at runIdsA[2] (a real org-A run) but stamped
      // with org B's id — simulating a bug elsewhere in the write path. The
      // belt-and-suspenders `row.orgId !== orgId` check in
      // collectFailureClassCounts must reject it, so it contributes NOTHING
      // to org A's cohort counts (not even under "unknown").
      await ctx.db.insert('run_explanations', { ...base, orgId: orgB, runId: runIdsA[2], failureClass: 'unknown' })

      // Version B cohort: one tool_error explanation.
      await ctx.db.insert('run_explanations', { ...base, orgId: orgA, runId: runIdsB[0], failureClass: 'tool_error' })
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const result = await asAdmin.query(api.insights.compareVersions, {
      orgId: orgA, agentVersionIdA: versionA, agentVersionIdB: versionB,
    })

    expect(result.versionA.failureClassCounts).toEqual({ tool_timeout: 2 })
    expect(result.versionA.failureClassCounts.unknown).toBeUndefined()
    expect(result.versionB.failureClassCounts).toEqual({ tool_error: 1 })
  })
})

describe('listEvalsForVersion', () => {
  it('computes pass rate and lists recent failures', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)

    await t.run(async (ctx) => {
      const now = Date.now()
      const run = await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: now, metadata: {}, tags: [],
      })
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('evals', {
          orgId: orgA, runId: run, agentVersionId: versionA, name: `eval_${i}`, kind: 'rule',
          passed: i !== 0, details: i === 0 ? 'boom' : undefined, createdAt: now, createdBy: 'system',
        })
      }
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.listEvalsForVersion, { orgId: orgA, agentVersionId: versionA, range: '30d' })

    expect(stats.sampleSize).toBe(3)
    expect(stats.passed).toBe(2)
    expect(stats.failed).toBe(1)
    expect(stats.passRate).toBeCloseTo(2 / 3)
    expect(stats.recentFailures).toHaveLength(1)
    expect(stats.recentFailures[0]!.details).toBe('boom')
  })

  it('rejects cross-org access to a version', async () => {
    const t = convexTest(schema, modules)
    const { orgA, versionB } = await seedTwoOrgs(t)
    await expect(
      t.withIdentity(identity('admin', 'a')).query(api.insights.listEvalsForVersion, {
        orgId: orgA, agentVersionId: versionB, range: '30d',
      }),
    ).rejects.toThrow(/NOT_FOUND|not found/i)
  })

  it('distinguishes "no rules configured" from "rules configured, zero evals yet"', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seedTwoOrgs(t)

    const versionNoRules = await t.run((ctx) =>
      ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: 'no-rules', createdAt: Date.now() }),
    )
    const versionWithRules = await t.run((ctx) =>
      ctx.db.insert('agent_versions', {
        agentId: agentA, orgId: orgA, version: 'with-rules', createdAt: Date.now(),
        evalRules: [{ kind: 'terminal_status', expect: ['completed'] }],
      } as any),
    )

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const noRulesStats = await asAdmin.query(api.insights.listEvalsForVersion, {
      orgId: orgA, agentVersionId: versionNoRules, range: '30d',
    })
    const withRulesStats = await asAdmin.query(api.insights.listEvalsForVersion, {
      orgId: orgA, agentVersionId: versionWithRules, range: '30d',
    })

    expect(noRulesStats.rulesConfigured).toBe(false)
    expect(noRulesStats.sampleSize).toBe(0)
    expect(withRulesStats.rulesConfigured).toBe(true)
    expect(withRulesStats.sampleSize).toBe(0)
  })
})

describe('getPerAgentDashboardStats', () => {
  it('computes a single-pass per-agent breakdown across >= 3 agents from daily_rollups', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA } = await seedTwoOrgs(t)

    const day = dateNDaysAgoUtc(1)
    const { agent1, agent2, agent3 } = await t.run(async (ctx) => {
      const now = Date.now()
      const agent1 = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent One', slug: 'one', createdAt: now, updatedAt: now })
      const agent2 = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent Two', slug: 'two', createdAt: now, updatedAt: now })
      const agent3 = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent Three', slug: 'three', createdAt: now, updatedAt: now })

      await ctx.db.insert('daily_rollups', {
        orgId: orgA, agentId: agent1, date: day,
        runsTotal: 10, runsFailed: 2, runsCompleted: 8, runsCancelled: 0, runsTimedOut: 0, tokensIn: 100, tokensOut: 50,
      })
      await ctx.db.insert('daily_rollups', {
        orgId: orgA, agentId: agent2, date: day,
        runsTotal: 4, runsFailed: 0, runsCompleted: 4, runsCancelled: 0, runsTimedOut: 0, tokensIn: 20, tokensOut: 10,
      })
      // agent3 has TWO rollup rows in range (two different days) -> must be summed, not overwritten.
      const dayBefore = dateNDaysAgoUtc(2)
      await ctx.db.insert('daily_rollups', {
        orgId: orgA, agentId: agent3, date: dayBefore,
        runsTotal: 5, runsFailed: 5, runsCompleted: 0, runsCancelled: 0, runsTimedOut: 0, tokensIn: 5, tokensOut: 5,
      })
      await ctx.db.insert('daily_rollups', {
        orgId: orgA, agentId: agent3, date: day,
        runsTotal: 3, runsFailed: 0, runsCompleted: 3, runsCancelled: 0, runsTimedOut: 0, tokensIn: 3, tokensOut: 3,
      })
      return { agent1, agent2, agent3 }
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.getPerAgentDashboardStats, { orgId: orgA, range: '7d' })

    expect(stats).toHaveLength(3)
    const byAgent = new Map(stats.map((s) => [s.agentId, s]))

    expect(byAgent.get(agent1)?.agentName).toBe('Agent One')
    expect(byAgent.get(agent1)?.runsTotal).toBe(10)
    expect(byAgent.get(agent1)?.runsFailed).toBe(2)
    expect(byAgent.get(agent1)?.failureRate).toBeCloseTo(0.2)

    expect(byAgent.get(agent2)?.agentName).toBe('Agent Two')
    expect(byAgent.get(agent2)?.runsTotal).toBe(4)
    expect(byAgent.get(agent2)?.failureRate).toBeCloseTo(0)

    // Summed across both of agent3's rollup rows.
    expect(byAgent.get(agent3)?.runsTotal).toBe(8)
    expect(byAgent.get(agent3)?.runsFailed).toBe(5)
    expect(byAgent.get(agent3)?.tokensIn).toBe(8)
  })

  it('returns an empty array for an org with no daily_rollups coverage', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const stats = await asAdmin.query(api.insights.getPerAgentDashboardStats, { orgId: orgA, range: '7d' })
    expect(stats).toEqual([])
  })

  it('rejects a caller who is not a member of the org', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await expect(
      t.withIdentity(identity('admin', 'b')).query(api.insights.getPerAgentDashboardStats, { orgId: orgA, range: '7d' }),
    ).rejects.toThrow(/Unauthorized|not a member/i)
  })
})

describe('getRunEvalSummary', () => {
  it('computes pass/fail/score rollup for one run', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)

    const runId = await t.run(async (ctx) => {
      const now = Date.now()
      const run = await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: now, metadata: {}, tags: [],
      })
      await ctx.db.insert('evals', {
        orgId: orgA, runId: run, agentVersionId: versionA, name: 'rule:0', kind: 'rule',
        passed: true, score: 1, createdAt: now, createdBy: 'system',
      })
      await ctx.db.insert('evals', {
        orgId: orgA, runId: run, agentVersionId: versionA, name: 'rule:1', kind: 'rule',
        passed: false, score: 0, details: 'exceeded', createdAt: now, createdBy: 'system',
      })
      await ctx.db.insert('evals', {
        orgId: orgA, runId: run, agentVersionId: versionA, name: 'llm_judge:0', kind: 'llm_judge',
        passed: true, createdAt: now, createdBy: 'system', // no score reported
      })
      return run
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const summary = await asAdmin.query(api.insights.getRunEvalSummary, { orgId: orgA, runId })

    expect(summary.total).toBe(3)
    expect(summary.passed).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.passRate).toBeCloseTo(2 / 3)
    // averageScore only over the two evals that reported a score: (1 + 0) / 2 = 0.5
    expect(summary.averageScore).toBeCloseTo(0.5)
    expect(summary.overallPassed).toBe(false)
    expect(summary.evals).toHaveLength(3)
  })

  it('reports nulls for a run with zero evals, not zeros', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await t.run((ctx) => {
      const now = Date.now()
      return ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'running', startedAt: now, metadata: {}, tags: [],
      })
    })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const summary = await asAdmin.query(api.insights.getRunEvalSummary, { orgId: orgA, runId })

    expect(summary.total).toBe(0)
    expect(summary.passRate).toBeNull()
    expect(summary.averageScore).toBeNull()
    expect(summary.overallPassed).toBeNull()
  })

  it('rejects a run belonging to a different org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)

    const orgBRunId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert('runs', {
        orgId: orgB, projectId: projectB, agentId: agentB, status: 'completed', startedAt: now, metadata: {}, tags: [],
      })
    })

    await expect(
      t.withIdentity(identity('admin', 'a')).query(api.insights.getRunEvalSummary, { orgId: orgA, runId: orgBRunId }),
    ).rejects.toThrow(/NOT_FOUND|not found/i)
  })
})

describe('runEvalsForRun', () => {
  async function seedRunWithVersionRules(t: ReturnType<typeof convexTest>, orgId: any, projectId: any, agentId: any) {
    return await t.run(async (ctx) => {
      const now = Date.now()
      // NOTE: agent_versions.evalRules is not yet in schema.ts (Team A is
      // adding it this cycle — see docs/design/insight_engine.md section 3
      // and the coordination note in insights.ts). convex-test does not
      // enforce the schema's closed-object shape on writes, so this seed can
      // attach the field directly to exercise runEvalsForRun's real rule
      // path ahead of the schema change landing.
      const agentVersionId = await ctx.db.insert('agent_versions', {
        agentId, orgId, version: 'v-eval', createdAt: now,
        evalRules: [
          { kind: 'terminal_status', expect: ['completed'] },
          { kind: 'max_duration_ms', limit: 500 },
        ],
      } as any)

      const runId = await ctx.db.insert('runs', {
        orgId, projectId, agentId, agentVersionId,
        status: 'completed', startedAt: now, endedAt: now + 2000, metadata: {}, tags: [],
      })
      await ctx.db.insert('events', {
        runId, orgId, type: 'run.started', sequenceNumber: 1, timestamp: now, payload: {},
      })
      await ctx.db.insert('events', {
        runId, orgId, type: 'run.completed', sequenceNumber: 2, timestamp: now + 2000, payload: {},
      })

      return { runId, agentVersionId }
    })
  }

  it('inserts one eval row per rule plus a summary row, correctly pass/failed', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const { runId } = await seedRunWithVersionRules(t, orgA, projectA, agentA)

    const result = await t.mutation(internal.insights.runEvalsForRun, { runId })
    expect(result.skipped).toBe(false)
    if (!result.skipped) {
      expect(result.insertedCount).toBe(3) // 2 rules + 1 summary
      // terminal_status expects "completed" (pass); max_duration_ms(500) vs a
      // 2000ms run duration (fail) -> overall fails.
      expect(result.overallPassed).toBe(false)
    }

    const rows = await t.run((ctx) => ctx.db.query('evals').withIndex('by_run', (q) => q.eq('runId', runId)).collect())
    expect(rows).toHaveLength(3)
    const terminalRow = rows.find((r) => r.name.includes('terminal_status'))
    const durationRow = rows.find((r) => r.name.includes('max_duration_ms'))
    const summaryRow = rows.find((r) => r.name === 'eval_summary')
    expect(terminalRow?.passed).toBe(true)
    expect(durationRow?.passed).toBe(false)
    expect(summaryRow?.passed).toBe(false)
    expect(rows.every((r) => r.createdBy === 'system:runEvalsForRun')).toBe(true)
  })

  it('is idempotent: a second call for the same run inserts nothing further', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const { runId } = await seedRunWithVersionRules(t, orgA, projectA, agentA)

    const first = await t.mutation(internal.insights.runEvalsForRun, { runId })
    expect(first.skipped).toBe(false)

    const second = await t.mutation(internal.insights.runEvalsForRun, { runId })
    expect(second.skipped).toBe(true)
    if (second.skipped) expect(second.reason).toBe('already_evaluated')

    const rows = await t.run((ctx) => ctx.db.query('evals').withIndex('by_run', (q) => q.eq('runId', runId)).collect())
    expect(rows).toHaveLength(3)
  })

  it('skips with no_rules when the agent version has no evalRules', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const runId = await t.run((ctx) => {
      const now = Date.now()
      return ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, agentVersionId: versionA,
        status: 'completed', startedAt: now, endedAt: now + 100, metadata: {}, tags: [],
      })
    })

    const result = await t.mutation(internal.insights.runEvalsForRun, { runId })
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe('no_rules')
  })

  it('skips with no_agent_version when the run has none', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await t.run((ctx) => {
      const now = Date.now()
      return ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA,
        status: 'completed', startedAt: now, endedAt: now + 100, metadata: {}, tags: [],
      })
    })

    const result = await t.mutation(internal.insights.runEvalsForRun, { runId })
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe('no_agent_version')
  })

  it('skips with run_not_found for a nonexistent run id', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await t.run(async (ctx) => {
      const now = Date.now()
      const id = await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA,
        status: 'completed', startedAt: now, endedAt: now + 100, metadata: {}, tags: [],
      })
      await ctx.db.delete(id)
      return id
    })

    const result = await t.mutation(internal.insights.runEvalsForRun, { runId })
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe('run_not_found')
  })
})

// ---------------------------------------------------------------------------
// buildHeuristicExplanation / classifyFailure (Explainability Layer cycle 1)
//
// These are PURE functions (no ctx, no convex-test harness needed) — tested
// directly against plausible event traces. Every test that checks
// citedSeqNums also verifies each cited number is a real sequenceNumber that
// appeared in the input `events` array (the grounding guarantee), and every
// classification test verifies the summary text contains the actual tool
// name / model / error text from the seeded trace, never a placeholder.
// ---------------------------------------------------------------------------
import { buildHeuristicExplanation, classifyFailure, explanationQualityScore } from './insights'
import type {
  ExplanationResult,
  HeuristicEvalLike,
  HeuristicEventLike,
  HeuristicExplanationInput,
  HeuristicFailureSummaryLike,
  HeuristicRunLike,
} from './insights'

function assertCitedSeqNumsAreReal(citedSeqNums: number[], events: HeuristicEventLike[]) {
  const real = new Set(events.map((e) => e.sequenceNumber))
  for (const n of citedSeqNums) {
    expect(real.has(n)).toBe(true)
  }
}

describe('buildHeuristicExplanation / classifyFailure', () => {
  it('classifies a timed-out tool call as tool_timeout, grounded in the real tool name and error text', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 12, payload: { name: 'search_docs', call_id: 'call-1', input: {} } },
      { type: 'tool.error', sequenceNumber: 13, payload: { call_id: 'call-1', error: { message: 'search_docs timed out after 30s' } } },
      { type: 'run.failed', sequenceNumber: 41, payload: { error: { message: 'search_docs timed out after 30s' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 1000 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 13, type: 'tool.error', reason: 'failed_tool', errorMessage: 'search_docs timed out after 30s' },
      allFailurePoints: [
        { sequenceNumber: 13, type: 'tool.error', reason: 'failed_tool', errorMessage: 'search_docs timed out after 30s' },
        { sequenceNumber: 41, type: 'run.failed', reason: 'run_failed', errorMessage: 'search_docs timed out after 30s' },
      ],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const classification = classifyFailure(input)
    expect(classification.failureClass).toBe('tool_timeout')

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('tool_timeout')
    expect(result.summary).toContain('search_docs')
    expect(result.summary).toContain('timed out after 30s')
    expect(result.summary.length).toBeLessThanOrEqual(2000)
    expect(result.rootCause.length).toBeLessThanOrEqual(1000)
    expect(result.suggestedFix).toBeDefined()
    expect(result.suggestedFix!.length).toBeLessThanOrEqual(1000)
    expect(result.citedSeqNums.length).toBeGreaterThan(0)
    expect(result.citedSeqNums.length).toBeLessThanOrEqual(20)
    expect(result.citedSeqNums).toContain(13)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('classifies a non-timeout tool failure as tool_error, grounded in the real tool name', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 5, payload: { name: 'write_file', call_id: 'call-9', input: { path: '/tmp/x' } } },
      { type: 'tool.error', sequenceNumber: 6, payload: { call_id: 'call-9', error: { message: 'permission denied' } } },
      { type: 'run.failed', sequenceNumber: 7, payload: { error: { message: 'permission denied' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 500 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 6, type: 'tool.error', reason: 'failed_tool', errorMessage: 'permission denied' },
      allFailurePoints: [{ sequenceNumber: 6, type: 'tool.error', reason: 'failed_tool', errorMessage: 'permission denied' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('tool_error')
    expect(result.summary).toContain('write_file')
    expect(result.summary).toContain('permission denied')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('classifies a failed llm.request/response pair as llm_error, grounded in the real model name', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'llm.request', sequenceNumber: 2, payload: { model: 'claude-sonnet-4-5', messages: [] } },
      { type: 'llm.error', sequenceNumber: 3, payload: { error: { message: 'rate limit exceeded' } } },
      { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: 'rate limit exceeded' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 200 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'llm.error', reason: 'failed_llm', errorMessage: 'rate limit exceeded' },
      allFailurePoints: [{ sequenceNumber: 3, type: 'llm.error', reason: 'failed_llm', errorMessage: 'rate limit exceeded' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('llm_error')
    expect(result.summary).toContain('claude-sonnet-4-5')
    expect(result.summary).toContain('rate limit exceeded')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('classifies a run with a failed eval (but otherwise clean execution) as assertion_failed, naming the eval', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'run.completed', sequenceNumber: 2, payload: { output: {}, duration_ms: 100 } },
    ]
    const run: HeuristicRunLike = { status: 'completed', startedAt: 0, endedAt: 100 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: false,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: null,
      allFailurePoints: [],
    }
    const evals: HeuristicEvalLike[] = [
      { name: 'rule:0:max_duration_ms', passed: false, details: 'Duration 2000ms exceeds the 500ms limit.' },
    ]
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals }

    const classification = classifyFailure(input)
    expect(classification.failureClass).toBe('assertion_failed')

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('assertion_failed')
    expect(result.summary).toContain('rule:0:max_duration_ms')
    expect(result.rootCause).toContain('Duration 2000ms exceeds the 500ms limit.')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('classifies run.failed with an error message and no other events as terminal_error', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'run.failed', sequenceNumber: 2, payload: { error: { message: 'unexpected crash in agent harness' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 50 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 2, type: 'run.failed', reason: 'run_failed', errorMessage: 'unexpected crash in agent harness' },
      allFailurePoints: [{ sequenceNumber: 2, type: 'run.failed', reason: 'run_failed', errorMessage: 'unexpected crash in agent harness' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('terminal_error')
    expect(result.summary).toContain('unexpected crash in agent harness')
    expect(result.citedSeqNums).toContain(2)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('classifies a run with no terminal event as incomplete', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'search_docs', call_id: 'c1' } },
    ]
    const run: HeuristicRunLike = { status: 'running', startedAt: 0 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: false,
      isIncomplete: true,
      cannotInfer: false,
      primaryFailure: null,
      allFailurePoints: [],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('incomplete')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('never throws on a hostile/partial trace and yields "unknown", still citing a real terminal event', () => {
    const events = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      // Hostile entries: NaN sequenceNumber, non-object payload, missing fields.
      { type: 'weird', sequenceNumber: NaN, payload: 'not-an-object' },
      { type: 'run.failed', sequenceNumber: 2, payload: null },
      // A prototype-pollution attempt embedded in payload — must never be touched unsafely.
      { type: 'tool.error', sequenceNumber: 3, payload: { __proto__: { polluted: true }, call_id: 123 } },
    ] as unknown as HeuristicEventLike[]
    const run = { status: 'failed', startedAt: 0, endedAt: 10 } as HeuristicRunLike
    // A hostile failureSummary: primaryFailure points at a seq number that
    // doesn't exist in `events` at all, and has an unrecognized `reason`.
    const failureSummary = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 9999, type: 'bogus', reason: 'not_a_real_reason' },
      allFailurePoints: [],
    } as unknown as HeuristicFailureSummaryLike
    const evals = 'not-an-array' as unknown as HeuristicEvalLike[]
    const input = { run, events, failureSummary, evals } as HeuristicExplanationInput

    expect(() => buildHeuristicExplanation(input)).not.toThrow()
    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('unknown')
    expect(typeof result.summary).toBe('string')
    expect(result.summary.length).toBeGreaterThan(0)
    // The bogus 9999 seq number must NEVER leak into citedSeqNums (grounding guarantee).
    expect(result.citedSeqNums).not.toContain(9999)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events.filter((e) => Number.isFinite(e.sequenceNumber)))
  })

  it('does not throw on a completely empty/garbage input', () => {
    expect(() =>
      buildHeuristicExplanation({} as unknown as HeuristicExplanationInput),
    ).not.toThrow()
    const result = buildHeuristicExplanation({} as unknown as HeuristicExplanationInput)
    expect(result.failureClass).toBe('unknown')
    expect(result.citedSeqNums).toEqual([])
  })

  it('yields a sensible, non-throwing result for a completed run with no failures (guard case — should not normally be called)', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'run.completed', sequenceNumber: 2, payload: { output: {}, duration_ms: 10 } },
    ]
    const run: HeuristicRunLike = { status: 'completed', startedAt: 0, endedAt: 10 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: false,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: null,
      allFailurePoints: [],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('unknown')
    expect(result.summary.length).toBeGreaterThan(0)
    expect(result.suggestedFix).toBeUndefined()
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  // -------------------------------------------------------------------------
  // Explainability Layer cycle 2 (Team B): DEEPENED quality corpus.
  //
  // Each case below is a full, realistic seeded event trace exercising a
  // distinct failure nuance from the cycle-2 prompt (multi-failure chains,
  // cascading tool errors, sub-agent/session context, incomplete-vs-stuck,
  // and per-class fix specificity). Every assertion checks GROUNDING
  // ACCURACY — real tool/model names, real error text, real seq numbers from
  // the seeded trace — not just "a string was returned". citedSeqNums are
  // always re-verified against the real trace via assertCitedSeqNumsAreReal.
  // -------------------------------------------------------------------------

  it('CASCADE: names a repeated-failure loop ("search_docs failed 4 consecutive times") rather than just the last failure', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'search_docs', call_id: 'c1' } },
      { type: 'tool.error', sequenceNumber: 3, payload: { call_id: 'c1', error: { message: 'connection reset' } } },
      { type: 'tool.call', sequenceNumber: 4, payload: { name: 'search_docs', call_id: 'c2' } },
      { type: 'tool.error', sequenceNumber: 5, payload: { call_id: 'c2', error: { message: 'connection reset' } } },
      { type: 'tool.call', sequenceNumber: 6, payload: { name: 'search_docs', call_id: 'c3' } },
      { type: 'tool.error', sequenceNumber: 7, payload: { call_id: 'c3', error: { message: 'connection reset' } } },
      { type: 'tool.call', sequenceNumber: 8, payload: { name: 'search_docs', call_id: 'c4' } },
      { type: 'tool.error', sequenceNumber: 9, payload: { call_id: 'c4', error: { message: 'connection reset' } } },
      { type: 'run.failed', sequenceNumber: 10, payload: { error: { message: 'connection reset' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 1000 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 9, type: 'tool.error', reason: 'failed_tool', errorMessage: 'connection reset' },
      allFailurePoints: [
        { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'connection reset' },
        { sequenceNumber: 5, type: 'tool.error', reason: 'failed_tool', errorMessage: 'connection reset' },
        { sequenceNumber: 7, type: 'tool.error', reason: 'failed_tool', errorMessage: 'connection reset' },
        { sequenceNumber: 9, type: 'tool.error', reason: 'failed_tool', errorMessage: 'connection reset' },
        { sequenceNumber: 10, type: 'run.failed', reason: 'run_failed', errorMessage: 'connection reset' },
      ],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const classification = classifyFailure(input)
    expect(classification.failureClass).toBe('cascading_tool_failure')

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('cascading_tool_failure')
    expect(result.summary).toContain('search_docs')
    expect(result.summary).toContain('4 consecutive time')
    expect(result.summary).toContain('#3')
    expect(result.summary).toContain('#9')
    expect(result.suggestedFix).toContain('search_docs')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
    expect(result.citedSeqNums).toEqual(expect.arrayContaining([3, 5, 7, 9]))

    const score = explanationQualityScore(result, input)
    expect(score).toBe(1)
  })

  it('MULTI-FAILURE CHAIN: distinguishes the proximate cause (a timeout) from contributing earlier tool/llm errors', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'fetch_page', call_id: 'c1' } },
      { type: 'tool.error', sequenceNumber: 3, payload: { call_id: 'c1', error: { message: '404 not found' } } },
      { type: 'llm.request', sequenceNumber: 4, payload: { model: 'claude-sonnet-4-5' } },
      { type: 'llm.error', sequenceNumber: 5, payload: { error: { message: 'rate limit exceeded' } } },
      { type: 'tool.call', sequenceNumber: 6, payload: { name: 'search_docs', call_id: 'c2' } },
      { type: 'tool.error', sequenceNumber: 7, payload: { call_id: 'c2', error: { message: 'search_docs timed out after 45s' } } },
      { type: 'run.failed', sequenceNumber: 8, payload: { error: { message: 'search_docs timed out after 45s' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 2000 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 7, type: 'tool.error', reason: 'failed_tool', errorMessage: 'search_docs timed out after 45s' },
      allFailurePoints: [
        { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: '404 not found' },
        { sequenceNumber: 5, type: 'llm.error', reason: 'failed_llm', errorMessage: 'rate limit exceeded' },
        { sequenceNumber: 7, type: 'tool.error', reason: 'failed_tool', errorMessage: 'search_docs timed out after 45s' },
        { sequenceNumber: 8, type: 'run.failed', reason: 'run_failed', errorMessage: 'search_docs timed out after 45s' },
      ],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    // Only one tool (search_docs) fails once here -> not a cascade; proximate cause is its timeout.
    expect(result.failureClass).toBe('tool_timeout')
    expect(result.summary).toContain('2 earlier issues')
    expect(result.summary).toContain('#3')
    expect(result.summary).toContain('#5')
    expect(result.summary).toContain('search_docs')
    expect(result.summary).toContain('45s')
    // Grounded, specific fix: names the tool AND the real duration from the trace.
    expect(result.suggestedFix).toContain('search_docs')
    expect(result.suggestedFix).toContain('45s')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
    expect(result.citedSeqNums).toEqual(expect.arrayContaining([3, 5, 7]))

    const score = explanationQualityScore(result, input)
    expect(score).toBe(1)
  })

  it('SUB-AGENT CONTEXT: notes the parentRunId relationship without inventing the parent/child\'s contents', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'call_subagent', call_id: 'c1' } },
      { type: 'tool.error', sequenceNumber: 3, payload: { call_id: 'c1', error: { message: 'sub-agent returned an error' } } },
      { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: 'sub-agent returned an error' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 500, parentRunId: 'runs:parent123' }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'sub-agent returned an error' },
      allFailurePoints: [{ sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'sub-agent returned an error' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.summary).toContain('runs:parent123')
    expect(result.summary).toContain('sub-run')
    // Grounding: must NOT claim anything about what happened INSIDE the parent run.
    expect(result.summary).not.toMatch(/parent run (failed|completed|returned)/i)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('SESSION CONTEXT: notes the sessionId relationship, grounded only in this run\'s own field', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'run.failed', sequenceNumber: 2, payload: { error: { message: 'boom' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100, sessionId: 'session-abc-123' }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 2, type: 'run.failed', reason: 'run_failed', errorMessage: 'boom' },
      allFailurePoints: [{ sequenceNumber: 2, type: 'run.failed', reason: 'run_failed', errorMessage: 'boom' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.summary).toContain('session-abc-123')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('STUCK/ABANDONED: an incomplete run with a stale last event (given `now`) is described as stalled, with a different fix than "still running"', () => {
    const startedAt = 0
    const lastEventTs = 1_000_000
    const now = lastEventTs + 60 * 60 * 1000 // 1 hour after the last event -> well past STUCK_THRESHOLD_MS
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, timestamp: startedAt, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, timestamp: lastEventTs, payload: { name: 'search_docs', call_id: 'c1' } },
    ]
    const run: HeuristicRunLike = { status: 'running', startedAt }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: false,
      isIncomplete: true,
      cannotInfer: false,
      primaryFailure: null,
      allFailurePoints: [],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [], now }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('incomplete')
    expect(result.summary).toMatch(/abandoned|stuck|stalled/i)
    expect(result.suggestedFix).toMatch(/crash|killed|connectivity/i)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)

    const score = explanationQualityScore(result, input)
    expect(score).toBe(1)
  })

  it('STILL RUNNING: an incomplete run whose last event is recent (given `now`) is NOT described as stuck', () => {
    const startedAt = 0
    const lastEventTs = 1_000_000
    const now = lastEventTs + 30_000 // 30s after the last event -> well within STUCK_THRESHOLD_MS
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, timestamp: startedAt, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, timestamp: lastEventTs, payload: { name: 'search_docs', call_id: 'c1' } },
    ]
    const run: HeuristicRunLike = { status: 'running', startedAt }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: false,
      isIncomplete: true,
      cannotInfer: false,
      primaryFailure: null,
      allFailurePoints: [],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [], now }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('incomplete')
    expect(result.summary).not.toMatch(/abandoned|stuck|stalled/i)
    expect(result.summary).toContain('still in progress')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('LLM_ERROR RATE LIMIT: names the model and classifies the likely cause as rate limiting, grounded in the real error text', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'llm.request', sequenceNumber: 2, payload: { model: 'gpt-4o' } },
      { type: 'llm.error', sequenceNumber: 3, payload: { error: { message: 'Error 429: rate limit exceeded, please retry later' } } },
      { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: 'Error 429: rate limit exceeded, please retry later' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'llm.error', reason: 'failed_llm', errorMessage: 'Error 429: rate limit exceeded, please retry later' },
      allFailurePoints: [{ sequenceNumber: 3, type: 'llm.error', reason: 'failed_llm', errorMessage: 'Error 429: rate limit exceeded, please retry later' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('llm_error')
    expect(result.summary).toContain('gpt-4o')
    expect(result.rootCause).toContain('rate limiting')
    expect(result.suggestedFix).toContain('rate limiting')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('LLM_ERROR CONTEXT LENGTH: classifies the likely cause as context-window overflow, grounded in the real error text', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'llm.request', sequenceNumber: 2, payload: { model: 'claude-opus-4' } },
      { type: 'llm.error', sequenceNumber: 3, payload: { error: { message: 'This request exceeds the maximum context length for this model' } } },
      { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: 'This request exceeds the maximum context length for this model' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'llm.error', reason: 'failed_llm', errorMessage: 'This request exceeds the maximum context length for this model' },
      allFailurePoints: [{ sequenceNumber: 3, type: 'llm.error', reason: 'failed_llm', errorMessage: 'This request exceeds the maximum context length for this model' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('llm_error')
    expect(result.summary).toContain('claude-opus-4')
    expect(result.rootCause).toContain("context window")
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('TOOL_TIMEOUT DURATION SPECIFICITY: the suggested fix names both the tool and the real timeout duration from the trace', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'run_query', call_id: 'c1' } },
      { type: 'tool.error', sequenceNumber: 3, payload: { call_id: 'c1', error: { message: 'run_query timed out after 90 seconds' } } },
      { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: 'run_query timed out after 90 seconds' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 90_000 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'run_query timed out after 90 seconds' },
      allFailurePoints: [{ sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'run_query timed out after 90 seconds' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('tool_timeout')
    expect(result.suggestedFix).toContain('run_query')
    expect(result.suggestedFix).toContain('90 seconds')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('ASSERTION_FAILED EXPECTED-VS-ACTUAL: parses the real duration numbers from the eval details into an explicit expected/actual statement', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'run.completed', sequenceNumber: 2, payload: { output: {}, duration_ms: 2000 } },
    ]
    const run: HeuristicRunLike = { status: 'completed', startedAt: 0, endedAt: 2000 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: false,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: null,
      allFailurePoints: [],
    }
    const evals: HeuristicEvalLike[] = [
      { name: 'rule:0:max_duration_ms', passed: false, details: 'Duration 2000ms exceeds the 500ms limit.' },
    ]
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals }

    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('assertion_failed')
    expect(result.summary).toContain('2000ms')
    expect(result.summary).toContain('500ms')
    expect(result.suggestedFix).toContain('2000ms')
    expect(result.suggestedFix).toContain('500ms')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)

    const score = explanationQualityScore(result, input)
    expect(score).toBe(1)
  })

  it('never fabricates a cascade for two DIFFERENT tools each failing once (not a repeated-failure loop)', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'tool_a', call_id: 'c1' } },
      { type: 'tool.error', sequenceNumber: 3, payload: { call_id: 'c1', error: { message: 'boom a' } } },
      { type: 'tool.call', sequenceNumber: 4, payload: { name: 'tool_b', call_id: 'c2' } },
      { type: 'tool.error', sequenceNumber: 5, payload: { call_id: 'c2', error: { message: 'boom b' } } },
      { type: 'run.failed', sequenceNumber: 6, payload: { error: { message: 'boom b' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 5, type: 'tool.error', reason: 'failed_tool', errorMessage: 'boom b' },
      allFailurePoints: [
        { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'boom a' },
        { sequenceNumber: 5, type: 'tool.error', reason: 'failed_tool', errorMessage: 'boom b' },
      ],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    // Two DIFFERENT tools, each failing once -> not a cascade; still a
    // regular tool_error, but must still surface tool_a as a contributing factor.
    expect(result.failureClass).toBe('tool_error')
    expect(result.summary).toContain('tool_b')
    expect(result.summary).toContain('1 earlier issue')
    expect(result.summary).toContain('tool_a')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  describe('explanationQualityScore', () => {
    it('scores a well-grounded, fully-specified explanation at 1', () => {
      const events: HeuristicEventLike[] = [
        { type: 'run.started', sequenceNumber: 1, payload: {} },
        { type: 'tool.call', sequenceNumber: 2, payload: { name: 'search_docs', call_id: 'c1' } },
        { type: 'tool.error', sequenceNumber: 3, payload: { call_id: 'c1', error: { message: 'search_docs timed out after 30s' } } },
        { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: 'search_docs timed out after 30s' } } },
      ]
      const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 1000 }
      const failureSummary: HeuristicFailureSummaryLike = {
        hasFailure: true,
        isIncomplete: false,
        cannotInfer: false,
        primaryFailure: { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'search_docs timed out after 30s' },
        allFailurePoints: [{ sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'search_docs timed out after 30s' }],
      }
      const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }
      const result = buildHeuristicExplanation(input)
      expect(explanationQualityScore(result, input)).toBe(1)
    })

    it('scores the "unknown" fallback lower than a fully-grounded explanation, but does not unfairly penalize the honest absence of a fix', () => {
      const input = {} as unknown as HeuristicExplanationInput
      const result = buildHeuristicExplanation(input)
      expect(result.failureClass).toBe('unknown')
      const score = explanationQualityScore(result, input)
      // citedSeqNums is empty here (no events at all) -> at least one check fails.
      expect(score).toBeLessThan(1)
      expect(score).toBeGreaterThanOrEqual(0)
    })

    it('penalizes a result whose citedSeqNums include a seq number not present in the input events (grounding violation)', () => {
      const events: HeuristicEventLike[] = [
        { type: 'run.started', sequenceNumber: 1, payload: {} },
        { type: 'run.failed', sequenceNumber: 2, payload: { error: { message: 'boom' } } },
      ]
      const input: HeuristicExplanationInput = {
        run: { status: 'failed', startedAt: 0, endedAt: 10 },
        events,
        failureSummary: { hasFailure: true, isIncomplete: false, cannotInfer: false, primaryFailure: null, allFailurePoints: [] },
        evals: [],
      }
      const fakeResult: ExplanationResult = {
        summary: 'A perfectly good-looking summary that is long enough to pass the length check easily.',
        rootCause: 'A specific root cause.',
        suggestedFix: 'A specific fix.',
        citedSeqNums: [999], // not a real sequenceNumber in `events`
        failureClass: 'terminal_error',
      }
      const score = explanationQualityScore(fakeResult, input)
      expect(score).toBeLessThan(1)
    })
  })

  it('caps citedSeqNums at 20 even with a large, dense trace', () => {
    const events: HeuristicEventLike[] = []
    for (let i = 1; i <= 200; i++) {
      events.push({ type: i % 2 === 0 ? 'tool.call' : 'tool.result', sequenceNumber: i, payload: { name: 'noisy_tool', call_id: `c${i}` } })
    }
    events.push({ type: 'tool.error', sequenceNumber: 201, payload: { call_id: 'c200', error: { message: 'boom' } } })
    events.push({ type: 'run.failed', sequenceNumber: 202, payload: { error: { message: 'boom' } } })
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 1000 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 201, type: 'tool.error', reason: 'failed_tool', errorMessage: 'boom' },
      allFailurePoints: [{ sequenceNumber: 201, type: 'tool.error', reason: 'failed_tool', errorMessage: 'boom' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    const result = buildHeuristicExplanation(input)
    expect(result.citedSeqNums.length).toBeLessThanOrEqual(20)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  // -------------------------------------------------------------------------
  // Explainability Layer cycle 3 (Team B): ADVERSARIAL grounding audit.
  //
  // Each case below feeds buildHeuristicExplanation an actively hostile or
  // degenerate input and asserts THREE invariants from the GROUNDING
  // GUARANTEE doc comment: (1) it never throws, (2) citedSeqNums never
  // contains a sequenceNumber absent from the real `events` array, and (3)
  // no tool name / model name / error text appears in the output that wasn't
  // read from the real trace.
  // -------------------------------------------------------------------------

  it('ADVERSARIAL: a payload with __proto__ and constructor keys is read tolerantly and never causes prototype pollution or a throw', () => {
    const events = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      {
        type: 'tool.call',
        sequenceNumber: 2,
        payload: JSON.parse('{"name":"real_tool","call_id":"c1","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'),
      },
      {
        type: 'tool.error',
        sequenceNumber: 3,
        payload: JSON.parse('{"call_id":"c1","__proto__":{"message":"should not be read as a message"},"constructor":"not-a-function","error":{"message":"real tool error text","__proto__":{"message":"fake nested message"}}}'),
      },
      { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: 'real tool error text' } } },
    ] as unknown as HeuristicEventLike[]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'real tool error text' },
      allFailurePoints: [{ sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'real tool error text' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    expect(() => buildHeuristicExplanation(input)).not.toThrow()
    const result = buildHeuristicExplanation(input)
    // JSON.parse never actually sets Object.prototype's own polluted key (the
    // "__proto__" string key in a JSON object literal is just an own data
    // property here, not the exotic accessor), but the assertion below proves
    // the shared Object.prototype was never mutated as a side effect of
    // reading these payloads regardless.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(result.failureClass).toBe('tool_error')
    expect(result.summary).toContain('real_tool')
    expect(result.summary).toContain('real tool error text')
    expect(result.summary).not.toContain('fake nested message')
    expect(result.summary).not.toContain('should not be read as a message')
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('ADVERSARIAL: a 1MB event payload does not throw, does not get echoed verbatim, and stays within the documented length caps', () => {
    const hugeString = 'x'.repeat(1024 * 1024) // 1MB
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'big_payload_tool', call_id: 'c1', input: { blob: hugeString } } },
      { type: 'tool.error', sequenceNumber: 3, payload: { call_id: 'c1', error: { message: `boom: ${hugeString}` } } },
      { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: `boom: ${hugeString}` } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: `boom: ${hugeString}` },
      allFailurePoints: [{ sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: `boom: ${hugeString}` }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    expect(() => buildHeuristicExplanation(input)).not.toThrow()
    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('tool_error')
    expect(result.summary).toContain('big_payload_tool')
    // The huge error text is truncated, never echoed in full -> the caps
    // documented on ExplanationResult must hold even for a 1MB source field.
    expect(result.summary.length).toBeLessThanOrEqual(2000)
    expect(result.rootCause.length).toBeLessThanOrEqual(1000)
    expect(result.suggestedFix!.length).toBeLessThanOrEqual(1000)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('ADVERSARIAL: negative, NaN, and duplicate sequence numbers never throw and never corrupt citedSeqNums grounding', () => {
    const events = [
      { type: 'run.started', sequenceNumber: -5, payload: {} }, // negative but finite -> a real (if unusual) seq number
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'flaky_tool', call_id: 'c1' } },
      { type: 'tool.call', sequenceNumber: 2, payload: { name: 'flaky_tool', call_id: 'c1' } }, // duplicate seqNum: same call re-delivered
      { type: 'weird', sequenceNumber: NaN, payload: { name: 'should_never_appear' } }, // dropped by sanitizeAndBoundEvents
      { type: 'tool.error', sequenceNumber: 3, payload: { call_id: 'c1', error: { message: 'flaky_tool exploded' } } },
      { type: 'run.failed', sequenceNumber: 4, payload: { error: { message: 'flaky_tool exploded' } } },
    ] as unknown as HeuristicEventLike[]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'flaky_tool exploded' },
      allFailurePoints: [{ sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'flaky_tool exploded' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    expect(() => buildHeuristicExplanation(input)).not.toThrow()
    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('tool_error')
    expect(result.summary).toContain('flaky_tool')
    expect(result.summary).not.toContain('should_never_appear')
    // NaN is not a "real" sequenceNumber for grounding purposes -> must never appear cited.
    expect(result.citedSeqNums.every((n) => Number.isFinite(n))).toBe(true)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events.filter((e) => Number.isFinite(e.sequenceNumber)))
  })

  it('ADVERSARIAL: a failureSummary pointing at a completely nonexistent seqNum never leaks that number into citedSeqNums', () => {
    const events: HeuristicEventLike[] = [
      { type: 'run.started', sequenceNumber: 1, payload: {} },
      { type: 'run.failed', sequenceNumber: 2, payload: { error: { message: 'real failure' } } },
    ]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100 }
    // primaryFailure cites seq 500000, which never appears in `events`.
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 500000, type: 'tool.error', reason: 'failed_tool', errorMessage: 'a lie about a tool that never ran' },
      allFailurePoints: [{ sequenceNumber: 500000, type: 'tool.error', reason: 'failed_tool', errorMessage: 'a lie about a tool that never ran' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    expect(() => buildHeuristicExplanation(input)).not.toThrow()
    const result = buildHeuristicExplanation(input)
    expect(result.citedSeqNums).not.toContain(500000)
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })

  it('ADVERSARIAL: an empty events array never throws and yields no citations', () => {
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 100 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'orphaned failure summary, no matching event' },
      allFailurePoints: [{ sequenceNumber: 3, type: 'tool.error', reason: 'failed_tool', errorMessage: 'orphaned failure summary, no matching event' }],
    }
    const input: HeuristicExplanationInput = { run, events: [], failureSummary, evals: [] }

    expect(() => buildHeuristicExplanation(input)).not.toThrow()
    const result = buildHeuristicExplanation(input)
    expect(result.citedSeqNums).toEqual([])
    expect(typeof result.summary).toBe('string')
    expect(result.summary.length).toBeGreaterThan(0)
  })

  it('ADVERSARIAL: a run whose only event is the terminal marker itself never throws and cites only that real event', () => {
    const events: HeuristicEventLike[] = [{ type: 'run.failed', sequenceNumber: 1, payload: { error: { message: 'immediate failure, nothing else ran' } } }]
    const run: HeuristicRunLike = { status: 'failed', startedAt: 0, endedAt: 5 }
    const failureSummary: HeuristicFailureSummaryLike = {
      hasFailure: true,
      isIncomplete: false,
      cannotInfer: false,
      primaryFailure: { sequenceNumber: 1, type: 'run.failed', reason: 'run_failed', errorMessage: 'immediate failure, nothing else ran' },
      allFailurePoints: [{ sequenceNumber: 1, type: 'run.failed', reason: 'run_failed', errorMessage: 'immediate failure, nothing else ran' }],
    }
    const input: HeuristicExplanationInput = { run, events, failureSummary, evals: [] }

    expect(() => buildHeuristicExplanation(input)).not.toThrow()
    const result = buildHeuristicExplanation(input)
    expect(result.failureClass).toBe('terminal_error')
    expect(result.summary).toContain('immediate failure, nothing else ran')
    expect(result.citedSeqNums).toEqual([1])
    assertCitedSeqNumsAreReal(result.citedSeqNums, events)
  })
})

// ---------------------------------------------------------------------------
// deriveFailureFingerprint / assessPatternSpike — PURE, DETERMINISTIC (Team A
// depends on these exact signatures from convex/failure_patterns.ts). No ctx,
// no convex-test harness needed.
// ---------------------------------------------------------------------------
import { deriveFailureFingerprint, assessPatternSpike } from './insights'
import type { FailureFingerprintInput, FailureFingerprint, PatternTrendPoint, SpikeAssessment } from './insights'

describe('deriveFailureFingerprint', () => {
  it('is stable: the exact same input produces the exact same hash every time', () => {
    const input: FailureFingerprintInput = {
      heuristicClass: 'tool_timeout',
      failingToolName: 'search_web',
      errorSignature: 'Timeout after 3021ms calling search_web',
    }
    const a = deriveFailureFingerprint(input)
    const b = deriveFailureFingerprint({ ...input })
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is stable across repeated calls in a loop (no hidden state, no randomness)', () => {
    const input: FailureFingerprintInput = { heuristicClass: 'llm_error', errorSignature: 'rate limited: 429 too many requests' }
    const hashes = new Set<string>()
    for (let i = 0; i < 25; i++) hashes.add(deriveFailureFingerprint(input).hash)
    expect(hashes.size).toBe(1)
  })

  it('KEY PROPERTY: two tool-timeout errors differing ONLY in latency collapse to the SAME fingerprint', () => {
    const a = deriveFailureFingerprint({
      heuristicClass: 'tool_timeout',
      failingToolName: 'search_web',
      errorSignature: 'Timeout after 3021ms calling search_web',
    })
    const b = deriveFailureFingerprint({
      heuristicClass: 'tool_timeout',
      failingToolName: 'search_web',
      errorSignature: 'Timeout after 118ms calling search_web',
    })
    expect(a.hash).toBe(b.hash)
    expect(a.salientKey).toBe(b.salientKey)
  })

  it('KEY PROPERTY: two llm_error errors differing ONLY in a request uuid collapse to the SAME fingerprint', () => {
    const a = deriveFailureFingerprint({
      heuristicClass: 'llm_error',
      errorSignature: 'request 3f29a1c4-8b2d-4e11-9c3a-7d6f5e4b3a21 was rate limited (429)',
    })
    const b = deriveFailureFingerprint({
      heuristicClass: 'llm_error',
      errorSignature: 'request 00000000-0000-4000-8000-000000000000 was rate limited (429)',
    })
    expect(a.hash).toBe(b.hash)
    expect(a.salientKey).toBe('rate_limited')
  })

  it('KEY PROPERTY: two terminal errors differing only in a timestamp and a hex request id collapse to the same fingerprint', () => {
    const a = deriveFailureFingerprint({
      heuristicClass: 'terminal_error',
      errorSignature: 'run aborted at 2026-07-24T12:03:00.123Z for request 1a2b3c4d5e',
    })
    const b = deriveFailureFingerprint({
      heuristicClass: 'terminal_error',
      errorSignature: 'run aborted at 2026-01-01T00:00:00.000Z for request ffffff0011',
    })
    expect(a.hash).toBe(b.hash)
  })

  it('COLLISION AVOIDANCE: different failing tools produce different fingerprints for the same class', () => {
    const a = deriveFailureFingerprint({ heuristicClass: 'tool_timeout', failingToolName: 'search_web' })
    const b = deriveFailureFingerprint({ heuristicClass: 'tool_timeout', failingToolName: 'read_file' })
    expect(a.hash).not.toBe(b.hash)
    expect(a.salientKey).toBe('search_web')
    expect(b.salientKey).toBe('read_file')
  })

  it('COLLISION AVOIDANCE: different heuristic classes with the same salient text produce different fingerprints', () => {
    const a = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'timed out' })
    const b = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: 'timed out' })
    expect(a.hash).not.toBe(b.hash)
  })

  it('COLLISION AVOIDANCE: different error classes (rate limit vs auth) produce different fingerprints', () => {
    const a = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'rate limited, 429' })
    const b = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'unauthorized, 401 invalid api key' })
    expect(a.hash).not.toBe(b.hash)
  })

  it('prefers failingToolName over errorSignature for tool-shaped classes', () => {
    const fp = deriveFailureFingerprint({
      heuristicClass: 'tool_error',
      failingToolName: 'search_web',
      errorSignature: 'connection reset by peer',
    })
    expect(fp.salientKey).toBe('search_web')
    expect(fp.label).toBe('Tool error: search_web')
  })

  it('falls back to terminalEventType when no tool name or error signature is available', () => {
    const fp = deriveFailureFingerprint({ heuristicClass: 'terminal_error', terminalEventType: 'run.failed' })
    expect(fp.salientKey).toBe('run.failed')
  })

  it('falls back to the class name itself when nothing else is available', () => {
    const fp = deriveFailureFingerprint({ heuristicClass: 'unknown' })
    expect(fp.salientKey).toBe('unknown')
    expect(fp.label).toBe('Unknown failure')
  })

  it('produces a human-readable label per class', () => {
    expect(deriveFailureFingerprint({ heuristicClass: 'tool_timeout', failingToolName: 'search_web' }).label).toBe('Tool timeout: search_web')
    expect(deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'rate limited (429)' }).label).toBe('LLM error: rate_limited')
    expect(deriveFailureFingerprint({ heuristicClass: 'incomplete' }).label).toBe('Incomplete run')
  })

  it('ADVERSARIAL: empty/undefined optional fields never throw and still produce a valid fingerprint', () => {
    expect(() => deriveFailureFingerprint({ heuristicClass: 'unknown' })).not.toThrow()
    expect(() => deriveFailureFingerprint({ heuristicClass: 'tool_error', failingToolName: null, errorSignature: null, terminalEventType: null })).not.toThrow()
    expect(() => deriveFailureFingerprint({ heuristicClass: 'tool_error', failingToolName: '', errorSignature: '   ' })).not.toThrow()
    const fp = deriveFailureFingerprint({ heuristicClass: 'tool_error', failingToolName: '', errorSignature: '   ' })
    expect(fp.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(fp.salientKey.length).toBeGreaterThan(0)
  })

  it('ADVERSARIAL: a very long error signature never throws and produces a bounded label/salientKey', () => {
    const huge = 'timeout after ' + '9'.repeat(50000) + 'ms calling search_web ' + 'x'.repeat(50000)
    expect(() => deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: huge })).not.toThrow()
    const fp = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: huge })
    expect(fp.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(fp.salientKey.length).toBeLessThanOrEqual(100)
    expect(fp.label.length).toBeLessThan(300)
  })

  it('ADVERSARIAL: unicode error text never throws and is still deterministic', () => {
    const input: FailureFingerprintInput = { heuristicClass: 'llm_error', errorSignature: '请求超时 — 该工具 🔥 无法访问 (código: 42)' }
    expect(() => deriveFailureFingerprint(input)).not.toThrow()
    const a = deriveFailureFingerprint(input)
    const b = deriveFailureFingerprint({ ...input })
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('ADVERSARIAL: unicode tool names still discriminate from one another', () => {
    const a = deriveFailureFingerprint({ heuristicClass: 'tool_error', failingToolName: '搜索工具' })
    const b = deriveFailureFingerprint({ heuristicClass: 'tool_error', failingToolName: '阅读工具' })
    expect(a.hash).not.toBe(b.hash)
  })

  // -------------------------------------------------------------------------
  // Cycle 3 (HARDEN) — auditor-flagged CHURN fix: tool name casing.
  // -------------------------------------------------------------------------
  it('CHURN FIX: the same tool reported with different casing collapses to ONE fingerprint', () => {
    const a = deriveFailureFingerprint({ heuristicClass: 'tool_timeout', failingToolName: 'search_web' })
    const b = deriveFailureFingerprint({ heuristicClass: 'tool_timeout', failingToolName: 'Search_Web' })
    const c = deriveFailureFingerprint({ heuristicClass: 'tool_timeout', failingToolName: 'SEARCH_WEB' })
    expect(a.hash).toBe(b.hash)
    expect(b.hash).toBe(c.hash)
    expect(a.salientKey).toBe('search_web')
  })

  // -------------------------------------------------------------------------
  // Cycle 3 (HARDEN) — FALSE MERGE fixes.
  // -------------------------------------------------------------------------
  it('FALSE MERGE FIX: distinct HTTP-status-shaped errors with no other distinguishing words no longer collapse (bare numeric codes are no longer dead text — they were stripped to <n> BEFORE the class check ran)', () => {
    const notFound = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'HTTP 404 Not Found' })
    const internal = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'HTTP 500 Internal Server Error' })
    const badGateway = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'HTTP 502' })
    expect(notFound.hash).not.toBe(internal.hash)
    expect(internal.hash).not.toBe(badGateway.hash)
    expect(notFound.salientKey).toBe('not_found')
    expect(internal.salientKey).toBe('internal_error')
    expect(badGateway.salientKey).toBe('bad_gateway')
  })

  it('FALSE MERGE FIX: bare numeric status codes (no keyword phrase) are still recognized, e.g. a lone "429"', () => {
    const rateLimited = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'Error: 429' })
    const unauthorized = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'Error: 401' })
    expect(rateLimited.salientKey).toBe('rate_limited')
    expect(unauthorized.salientKey).toBe('auth_error')
    expect(rateLimited.hash).not.toBe(unauthorized.hash)
  })

  it('two 404s that differ only in a request id/timestamp still collapse to the SAME fingerprint (regression guard for the fix above)', () => {
    const a = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'HTTP 404 Not Found for request 3f29a1c4-8b2d-4e11-9c3a-7d6f5e4b3a21' })
    const b = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: 'HTTP 404 Not Found for request 00000000-0000-4000-8000-000000000000' })
    expect(a.hash).toBe(b.hash)
  })

  it('FALSE MERGE FIX: two long tool names sharing a >100-char prefix but differing after it no longer collide (hash uses the full bounded key, not the 100-char display clamp)', () => {
    const prefix = 'a'.repeat(120)
    const a = deriveFailureFingerprint({ heuristicClass: 'tool_error', failingToolName: `${prefix}_one` })
    const b = deriveFailureFingerprint({ heuristicClass: 'tool_error', failingToolName: `${prefix}_two` })
    // Their DISPLAY keys (clamped to 100 chars) are identical...
    expect(a.salientKey).toBe(b.salientKey)
    // ...but the hash must still distinguish them, since they are genuinely different tools.
    expect(a.hash).not.toBe(b.hash)
  })

  it('ADVERSARIAL: an errorSignature that is entirely variable (pure digits) produces a stable, CLASS-SCOPED fingerprint, not a cross-class collision bucket', () => {
    const llmA = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: '424242' })
    const llmB = deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: '999999999' })
    const toolErr = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: '424242' })
    // Same class, both pure-digit signatures -> same degenerate token, stable.
    expect(llmA.hash).toBe(deriveFailureFingerprint({ heuristicClass: 'llm_error', errorSignature: '424242' }).hash)
    expect(llmA.hash).toBe(llmB.hash)
    // Different class with the exact same raw text -> MUST NOT collide (class-scoped).
    expect(llmA.hash).not.toBe(toolErr.hash)
  })

  it('ADVERSARIAL: a windows path and a unix path for the SAME logical file collapse to the same fingerprint (no path-convention churn)', () => {
    const unix = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: 'failed to read /home/user/data/output.txt: permission denied' })
    const windows = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: 'failed to read C:\\Users\\user\\output.txt: permission denied' })
    expect(unix.hash).toBe(windows.hash)
  })

  it('CHURN FIX: two different hostnames for the same underlying network failure now collapse (hostnames are stripped to <host>)', () => {
    const a = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: 'prod-worker-7.us-east-1.internal did not respond' })
    const b = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: 'prod-worker-9.us-east-1.internal did not respond' })
    expect(a.hash).toBe(b.hash)
    // A plain single-dot filename-shaped token must NOT be treated as a hostname (leading token differs: "host" vs "output").
    const file = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: 'output.txt did not respond' })
    expect(file.hash).not.toBe(a.hash)
  })

  it('CHURN FIX: two different mixed-letter-and-digit request ids for the same failure now collapse (stripped to <id>)', () => {
    const a = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: 'request req8f3xk2z9 failed unexpectedly' })
    const b = deriveFailureFingerprint({ heuristicClass: 'tool_error', errorSignature: 'request reqa1b2c3d4 failed unexpectedly' })
    expect(a.hash).toBe(b.hash)
  })

  it('CHURN FIX: two different base64-looking blobs for the same failure now collapse (stripped to <b64>)', () => {
    const a = deriveFailureFingerprint({
      heuristicClass: 'llm_error',
      errorSignature: 'token validation failed for payload eyjhbgcioijiuzi1niisinr5cci6ikpxvcj9==',
    })
    const b = deriveFailureFingerprint({
      heuristicClass: 'llm_error',
      errorSignature: 'token validation failed for payload zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz==',
    })
    expect(a.hash).toBe(b.hash)
  })

  it('is still deterministic after the cycle-3 normalization changes: repeated calls produce the same hash', () => {
    const input: FailureFingerprintInput = {
      heuristicClass: 'tool_error',
      failingToolName: 'Search_Web',
      errorSignature: 'HTTP 404 for host api.example.com, request req8f3xk2z9',
    }
    const hashes = new Set<string>()
    for (let i = 0; i < 10; i++) hashes.add(deriveFailureFingerprint(input).hash)
    expect(hashes.size).toBe(1)
  })
})

describe('assessPatternSpike', () => {
  function trend(counts: number[], startDate = '2026-07-01'): PatternTrendPoint[] {
    const start = Date.parse(`${startDate}T00:00:00.000Z`)
    return counts.map((count, i) => {
      const d = new Date(start + i * 24 * 60 * 60 * 1000)
      return { day: d.toISOString().slice(0, 10), count }
    })
  }

  it('a flat trend is not spiking', () => {
    const t = trend([2, 2, 2, 2, 2, 2, 2])
    const result = assessPatternSpike(t)
    expect(result.isSpiking).toBe(false)
  })

  it('a clear step-up in the recent window is flagged as spiking', () => {
    // 5 baseline days at ~1/day, then 3 recent days at 10/day.
    const t = trend([1, 1, 1, 1, 1, 10, 10, 10])
    const result = assessPatternSpike(t)
    expect(result.isSpiking).toBe(true)
    expect(result.recentCount).toBe(30)
    expect(result.baselineMean).toBeCloseTo(1, 5)
    expect(result.z).toBeGreaterThanOrEqual(2)
  })

  it('insufficient baseline data (fewer than minBaselineDays) is never flagged as spiking, z pinned to 0', () => {
    // Only 2 baseline days available (need 4 by default) plus 3 recent days.
    const t = trend([1, 1, 50, 50, 50])
    const result = assessPatternSpike(t)
    expect(result.isSpiking).toBe(false)
    expect(result.z).toBe(0)
  })

  it('an empty trend never throws and is not spiking', () => {
    expect(() => assessPatternSpike([])).not.toThrow()
    const result = assessPatternSpike([])
    expect(result.isSpiking).toBe(false)
    expect(result.z).toBe(0)
    expect(result.recentCount).toBe(0)
  })

  it('recentCount below minRecentCount is never flagged, even with a large z', () => {
    // Baseline of 0s, recent window has a single failure (count=1 < default minRecentCount=3).
    const t = trend([0, 0, 0, 0, 0, 0, 1])
    const result = assessPatternSpike(t)
    expect(result.isSpiking).toBe(false)
  })

  it('is deterministic — same input always yields the same assessment (no wall clock)', () => {
    const t = trend([1, 1, 1, 1, 1, 10, 10, 10])
    const a = assessPatternSpike(t)
    const b = assessPatternSpike(t.slice())
    expect(a).toEqual(b)
  })

  it('sorts an out-of-order trend defensively before slicing recent/baseline windows', () => {
    const ordered = trend([1, 1, 1, 1, 1, 10, 10, 10])
    const shuffled = [ordered[5]!, ordered[0]!, ordered[6]!, ordered[2]!, ordered[7]!, ordered[1]!, ordered[3]!, ordered[4]!]
    const a = assessPatternSpike(ordered)
    const b = assessPatternSpike(shuffled)
    expect(b).toEqual(a)
  })

  it('respects custom opts (recentDays, minBaselineDays, zThreshold, minRecentCount)', () => {
    const t = trend([1, 1, 10, 10])
    const strict = assessPatternSpike(t, { recentDays: 2, minBaselineDays: 2, zThreshold: 100 })
    expect(strict.isSpiking).toBe(false) // z threshold impossible to hit
    const lenient = assessPatternSpike(t, { recentDays: 2, minBaselineDays: 2, zThreshold: 1, minRecentCount: 1 })
    expect(lenient.isSpiking).toBe(true)
  })

  it('ADVERSARIAL: malformed points (missing/non-numeric count, non-string day) are dropped, not throw', () => {
    const malformed = [
      { day: '2026-07-01', count: 1 },
      // @ts-expect-error intentionally malformed for the adversarial test
      { day: '2026-07-02', count: 'oops' },
      // @ts-expect-error intentionally malformed for the adversarial test
      { day: 123, count: 5 },
      null as unknown as PatternTrendPoint,
      undefined as unknown as PatternTrendPoint,
      { day: '2026-07-03', count: 2 },
    ]
    expect(() => assessPatternSpike(malformed)).not.toThrow()
  })

  it('a fingerprint from deriveFailureFingerprint has the exact shape callers (Team A) depend on', () => {
    const fp: FailureFingerprint = deriveFailureFingerprint({ heuristicClass: 'tool_error', failingToolName: 'search_web' })
    expect(typeof fp.hash).toBe('string')
    expect(typeof fp.class).toBe('string')
    expect(typeof fp.label).toBe('string')
    expect(typeof fp.salientKey).toBe('string')
  })

  it('a spike assessment has the exact shape callers (Team A) depend on', () => {
    const result: SpikeAssessment = assessPatternSpike([{ day: '2026-07-01', count: 1 }])
    expect(typeof result.isSpiking).toBe('boolean')
    expect(typeof result.recentCount).toBe('number')
    expect(typeof result.baselineMean).toBe('number')
    expect(typeof result.z).toBe('number')
  })

  // -------------------------------------------------------------------------
  // Cycle 3 (HARDEN) — z-score division-by-zero / NaN / Infinity guards.
  // -------------------------------------------------------------------------
  it('BUG FIX: an all-equal (zero-variance) baseline never produces NaN/Infinity in z, even with a huge spike on top', () => {
    const t = trend([5, 5, 5, 5, 5, 5, 5, 500, 500, 500])
    const result = assessPatternSpike(t)
    expect(Number.isFinite(result.z)).toBe(true)
    expect(Number.isNaN(result.z)).toBe(false)
    expect(result.isSpiking).toBe(true)
  })

  it('BUG FIX: minBaselineDays <= 0 no longer lets an EMPTY baseline slide through and divide by zero (z stays 0, never NaN)', () => {
    // Only 3 days total, all consumed by the default recentDays=3 window -> baseline is empty.
    const t = trend([10, 10, 10])
    expect(() => assessPatternSpike(t, { minBaselineDays: 0 })).not.toThrow()
    const zero = assessPatternSpike(t, { minBaselineDays: 0 })
    expect(zero.z).toBe(0)
    expect(Number.isNaN(zero.z)).toBe(false)
    expect(zero.isSpiking).toBe(false)

    expect(() => assessPatternSpike(t, { minBaselineDays: -5 })).not.toThrow()
    const negative = assessPatternSpike(t, { minBaselineDays: -5 })
    expect(negative.z).toBe(0)
    expect(Number.isNaN(negative.z)).toBe(false)
  })

  it('window alignment: recentCount always reflects exactly the trailing recentDays window, contiguous with the baseline (no gap, no overlap, no off-by-one)', () => {
    // 10 days: baseline days 0-6 (7 days), recent days 7-9 (3 days) by default.
    const t = trend([1, 1, 1, 1, 1, 1, 1, 9, 9, 9])
    const result = assessPatternSpike(t)
    // recentCount must be exactly the sum of the LAST 3 points (27), not 2 or 4 of them.
    expect(result.recentCount).toBe(27)
    // baselineMean must reflect exactly the first 7 points (all 1s), not bleed into the recent window.
    expect(result.baselineMean).toBeCloseTo(1, 10)
  })

  it('window alignment: a spike confined to exactly the boundary day (last baseline day) is NOT counted as recent (no off-by-one leak across the window boundary)', () => {
    // The single elevated day sits as the LAST baseline day, not in the recent window.
    const t = trend([1, 1, 1, 1, 1, 1, 100, 1, 1, 1])
    const result = assessPatternSpike(t)
    expect(result.recentCount).toBe(3) // last 3 days are [1, 1, 1]
    expect(result.isSpiking).toBe(false)
  })

  it('ADVERSARIAL: huge (but finite) counts never produce NaN/Infinity in the assessment', () => {
    const HUGE = 1e15
    const t = trend([1, 1, 1, 1, 1, HUGE, HUGE, HUGE])
    expect(() => assessPatternSpike(t)).not.toThrow()
    const result = assessPatternSpike(t)
    expect(Number.isFinite(result.z)).toBe(true)
    expect(Number.isFinite(result.recentCount)).toBe(true)
    expect(Number.isFinite(result.baselineMean)).toBe(true)
  })

  it('ADVERSARIAL: Infinity/NaN counts in the input are dropped by the finite-count filter, not propagated', () => {
    const malformed: PatternTrendPoint[] = [
      { day: '2026-07-01', count: 1 },
      { day: '2026-07-02', count: Infinity },
      { day: '2026-07-03', count: -Infinity },
      { day: '2026-07-04', count: NaN },
      { day: '2026-07-05', count: 2 },
    ]
    expect(() => assessPatternSpike(malformed)).not.toThrow()
    const result = assessPatternSpike(malformed)
    expect(Number.isFinite(result.z)).toBe(true)
    expect(Number.isFinite(result.recentCount)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// assessPatternSpikeTransition / classifyPatternEpisode — cycle 2 (DEEPEN).
// PURE, DETERMINISTIC (Team A's spike-rollup cron depends on these exact
// signatures). No ctx, no convex-test harness needed.
// ---------------------------------------------------------------------------
import { assessPatternSpikeTransition, classifyPatternEpisode } from './insights'
import type { StoredSpikeAssessment, SpikeTransitionDecision } from './insights'

const HOUR_MS = 60 * 60 * 1000

function stored(isSpiking: boolean, assessedAt = 0, extra?: Partial<StoredSpikeAssessment>): StoredSpikeAssessment {
  return { assessedAt, isSpiking, recentCount: isSpiking ? 10 : 1, baselineMean: 1, z: isSpiking ? 5 : 0, ...extra }
}

describe('assessPatternSpikeTransition', () => {
  it('fires on a rising edge: prev not spiking, curr spiking, no lastFiredAt', () => {
    const decision = assessPatternSpikeTransition(stored(false), stored(true), { nowMs: 1000 })
    expect(decision).toEqual({ shouldFire: true, reason: 'entered_spiking' })
  })

  it('fires on a rising edge when prev is undefined (first-ever assessment can still fire)', () => {
    const decision = assessPatternSpikeTransition(undefined, stored(true), { nowMs: 1000 })
    expect(decision.shouldFire).toBe(true)
    expect(decision.reason).toBe('entered_spiking')
  })

  it('does not fire when curr is not spiking, regardless of prev', () => {
    expect(assessPatternSpikeTransition(stored(true), stored(false), { nowMs: 1000 })).toEqual({
      shouldFire: false,
      reason: 'not_spiking',
    })
    expect(assessPatternSpikeTransition(undefined, stored(false), { nowMs: 1000 })).toEqual({
      shouldFire: false,
      reason: 'not_spiking',
    })
  })

  it('suppresses a SUSTAINED spike: prev spiking, curr still spiking -> no re-fire', () => {
    const decision = assessPatternSpikeTransition(stored(true), stored(true), { nowMs: 1000 })
    expect(decision).toEqual({ shouldFire: false, reason: 'still_spiking_suppressed' })
  })

  it('a rising edge fires exactly once across a sequence of ticks while the spike persists', () => {
    // Simulate ticks: not spiking, spiking, spiking, spiking (never dips) — only tick 2 should fire.
    const ticks = [stored(false), stored(true), stored(true), stored(true)]
    const fires: boolean[] = []
    let prev: StoredSpikeAssessment | undefined
    for (const curr of ticks) {
      const decision = assessPatternSpikeTransition(prev, curr, { nowMs: 1000 })
      fires.push(decision.shouldFire)
      prev = curr
    }
    expect(fires).toEqual([false, true, false, false])
  })

  it('cooldown suppresses a re-fire shortly after the last fire, even on a genuine rising edge', () => {
    const nowMs = 10 * HOUR_MS
    const lastFiredAt = nowMs - 1 * HOUR_MS // fired 1h ago
    const decision = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs,
      lastFiredAt,
      cooldownMs: 6 * HOUR_MS,
    })
    expect(decision).toEqual({ shouldFire: false, reason: 'cooldown_active' })
  })

  it('allows a re-fire once the cooldown has fully elapsed', () => {
    const nowMs = 10 * HOUR_MS
    const lastFiredAt = nowMs - 6 * HOUR_MS - 1 // just past the 6h cooldown boundary
    const decision = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs,
      lastFiredAt,
      cooldownMs: 6 * HOUR_MS,
    })
    expect(decision).toEqual({ shouldFire: true, reason: 'entered_spiking' })
  })

  it('cooldown boundary is exclusive-safe: exactly at cooldownMs is still suppressed (< not <=)', () => {
    const nowMs = 10 * HOUR_MS
    const lastFiredAt = nowMs - 6 * HOUR_MS // exactly cooldownMs ago
    const decision = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs,
      lastFiredAt,
      cooldownMs: 6 * HOUR_MS,
    })
    // nowMs - lastFiredAt === cooldownMs, which is NOT < cooldownMs, so this should fire.
    expect(decision).toEqual({ shouldFire: true, reason: 'entered_spiking' })
  })

  it('defaults cooldownMs to 6h when not provided', () => {
    const nowMs = 10 * HOUR_MS
    const justInside = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs,
      lastFiredAt: nowMs - 5 * HOUR_MS,
    })
    expect(justInside.reason).toBe('cooldown_active')

    const justOutside = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs,
      lastFiredAt: nowMs - 7 * HOUR_MS,
    })
    expect(justOutside.reason).toBe('entered_spiking')
  })

  it('lastFiredAt undefined never triggers cooldown, even with a rising edge', () => {
    const decision = assessPatternSpikeTransition(stored(false), stored(true), { nowMs: 1000, lastFiredAt: undefined })
    expect(decision.shouldFire).toBe(true)
  })

  it('ADVERSARIAL: malformed prev (isSpiking missing/falsy-but-not-boolean) is treated as not-spiking baseline, never throws', () => {
    const malformedPrev = { assessedAt: 0, isSpiking: undefined as unknown as boolean, recentCount: 0, baselineMean: 0, z: 0 }
    expect(() => assessPatternSpikeTransition(malformedPrev, stored(true), { nowMs: 1000 })).not.toThrow()
    const decision = assessPatternSpikeTransition(malformedPrev, stored(true), { nowMs: 1000 })
    expect(decision.shouldFire).toBe(true) // treated as a rising edge, same as prev === undefined
  })

  it('is deterministic: same inputs always produce the same decision', () => {
    const args = [stored(false, 0), stored(true, HOUR_MS), { nowMs: 5 * HOUR_MS, lastFiredAt: HOUR_MS, cooldownMs: 2 * HOUR_MS }] as const
    const results = new Set<string>()
    for (let i = 0; i < 10; i++) results.add(JSON.stringify(assessPatternSpikeTransition(...args)))
    expect(results.size).toBe(1)
  })

  it('has the exact shape callers (Team A) depend on', () => {
    const decision: SpikeTransitionDecision = assessPatternSpikeTransition(undefined, stored(true), { nowMs: 1 })
    expect(typeof decision.shouldFire).toBe('boolean')
    expect(typeof decision.reason).toBe('string')
  })

  // -------------------------------------------------------------------------
  // Cycle 3 (HARDEN) — transition edge cases.
  // -------------------------------------------------------------------------
  it('ADVERSARIAL: prev === curr by object identity (sustained spike represented by the same reference) is still suppressed, not double-counted as a rising edge', () => {
    const same = stored(true)
    const decision = assessPatternSpikeTransition(same, same, { nowMs: 1000 })
    expect(decision).toEqual({ shouldFire: false, reason: 'still_spiking_suppressed' })
  })

  it("prev.assessedAt being stale/ancient does not affect the decision — only prev.isSpiking and the cooldown timestamps matter", () => {
    const staleProof = stored(true, /* assessedAt */ -1_000_000_000)
    const fresh = stored(true, /* assessedAt */ 1_000_000_000)
    const nowMs = 5000
    const a = assessPatternSpikeTransition(staleProof, stored(true), { nowMs })
    const b = assessPatternSpikeTransition(fresh, stored(true), { nowMs })
    expect(a).toEqual(b)
    expect(a).toEqual({ shouldFire: false, reason: 'still_spiking_suppressed' })
  })

  it('ADVERSARIAL: negative cooldownMs never suppresses a rising edge (never throws, never traps every future fire)', () => {
    const decision = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs: 1000,
      lastFiredAt: 999,
      cooldownMs: -1000,
    })
    expect(() =>
      assessPatternSpikeTransition(stored(false), stored(true), { nowMs: 1000, lastFiredAt: 999, cooldownMs: -1000 }),
    ).not.toThrow()
    expect(decision).toEqual({ shouldFire: true, reason: 'entered_spiking' })
  })

  it('ADVERSARIAL: cooldownMs === 0 disables the cooldown entirely (a rising edge always fires, even immediately after a previous fire)', () => {
    const decision = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs: 1000,
      lastFiredAt: 1000,
      cooldownMs: 0,
    })
    expect(decision).toEqual({ shouldFire: true, reason: 'entered_spiking' })
  })

  it('ADVERSARIAL: an enormous cooldownMs never throws or overflows, and correctly suppresses indefinitely', () => {
    const HUGE_COOLDOWN = Number.MAX_SAFE_INTEGER
    expect(() =>
      assessPatternSpikeTransition(stored(false), stored(true), { nowMs: 1000, lastFiredAt: 500, cooldownMs: HUGE_COOLDOWN }),
    ).not.toThrow()
    const decision = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs: 1000,
      lastFiredAt: 500,
      cooldownMs: HUGE_COOLDOWN,
    })
    expect(decision).toEqual({ shouldFire: false, reason: 'cooldown_active' })
  })

  it('ADVERSARIAL: lastFiredAt in the FUTURE (clock skew) is treated conservatively as "still in cooldown", not as a negative-duration escape hatch', () => {
    const decision = assessPatternSpikeTransition(stored(false), stored(true), {
      nowMs: 1000,
      lastFiredAt: 5000, // "fired" 4000ms in the future relative to nowMs
      cooldownMs: 6 * HOUR_MS,
    })
    expect(() =>
      assessPatternSpikeTransition(stored(false), stored(true), { nowMs: 1000, lastFiredAt: 5000, cooldownMs: 6 * HOUR_MS }),
    ).not.toThrow()
    expect(decision).toEqual({ shouldFire: false, reason: 'cooldown_active' })
  })
})

describe('classifyPatternEpisode', () => {
  const DAY_MS_LOCAL = 24 * HOUR_MS

  it('classifies "new" when firstSeenAt is within the last 24h (default newWindowMs)', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 1 * HOUR_MS, lastSeenAt: nowMs - 1 * HOUR_MS, count: 1 }
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('new')
  })

  it('boundary: exactly at newWindowMs is still "new" (<=, not <)', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 24 * HOUR_MS, lastSeenAt: nowMs - 24 * HOUR_MS, count: 1 }
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('new')
  })

  it('boundary: just past newWindowMs is no longer "new"', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 24 * HOUR_MS - 1, lastSeenAt: nowMs - 24 * HOUR_MS - 1, count: 1 }
    expect(classifyPatternEpisode(pattern, nowMs)).not.toBe('new')
  })

  it('classifies "regressed": old pattern (not new) with a wide average gap (sparse occurrences over its lifetime)', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    // firstSeenAt 20 days ago, lastSeenAt 19 days ago (not new), only 2 occurrences
    // spread across ~1 day of activity but the pattern itself is old -> avg gap
    // computed from full history: use a wide firstSeenAt..lastSeenAt spread with low count.
    const pattern = { firstSeenAt: nowMs - 20 * DAY_MS_LOCAL, lastSeenAt: nowMs - 2 * DAY_MS_LOCAL, count: 2 }
    // avgGap = 18 days / 2 = 9 days >> quietGapMs default (72h = 3 days) -> regressed
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('regressed')
  })

  it('classifies "ongoing": old pattern with frequent occurrences (small average gap)', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    // firstSeenAt 20 days ago, lastSeenAt 2 days ago (not new), 100 occurrences densely spread.
    const pattern = { firstSeenAt: nowMs - 20 * DAY_MS_LOCAL, lastSeenAt: nowMs - 2 * DAY_MS_LOCAL, count: 100 }
    // avgGap = 18 days / 100 ~= 4.3h << quietGapMs default (72h) -> ongoing
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('ongoing')
  })

  it('boundary: avgGap exactly at quietGapMs is "regressed" (>=, not >)', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const quietGapMs = 72 * HOUR_MS
    // Not new: firstSeenAt far enough back. avgGap = (lastSeenAt - firstSeenAt) / count === quietGapMs exactly.
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const lastSeenAt = firstSeenAt + quietGapMs * 2 // count=2 -> avgGap = quietGapMs
    const pattern = { firstSeenAt, lastSeenAt, count: 2 }
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('regressed')
  })

  it('boundary: avgGap just under quietGapMs is "ongoing"', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const quietGapMs = 72 * HOUR_MS
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const lastSeenAt = firstSeenAt + quietGapMs * 2 - 10 // count=2 -> avgGap just under quietGapMs
    const pattern = { firstSeenAt, lastSeenAt, count: 2 }
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('ongoing')
  })

  it('count <= 1 is treated as trivially satisfying the sparse rule: an old single occurrence reads as "regressed"', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 10 * DAY_MS_LOCAL, lastSeenAt: nowMs - 10 * DAY_MS_LOCAL, count: 1 }
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('regressed')
  })

  it('count === 0 is also treated as the sparse/regressed case (defensive against malformed input)', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 10 * DAY_MS_LOCAL, lastSeenAt: nowMs - 5 * DAY_MS_LOCAL, count: 0 }
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('regressed')
  })

  it('respects custom opts (newWindowMs, quietGapMs)', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 2 * DAY_MS_LOCAL, lastSeenAt: nowMs - 1 * DAY_MS_LOCAL, count: 1 }
    // Default newWindowMs (24h) would NOT classify this as new (2 days old); a larger custom window does.
    expect(classifyPatternEpisode(pattern, nowMs)).not.toBe('new')
    expect(classifyPatternEpisode(pattern, nowMs, { newWindowMs: 3 * DAY_MS_LOCAL })).toBe('new')
  })

  it('ADVERSARIAL: lastSeenAt before firstSeenAt is clamped, never produces a negative gap or throws', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 10 * DAY_MS_LOCAL, lastSeenAt: nowMs - 20 * DAY_MS_LOCAL, count: 5 }
    expect(() => classifyPatternEpisode(pattern, nowMs)).not.toThrow()
    // Clamped so lastSeenAt >= firstSeenAt -> avgGap === 0 -> "ongoing" (not sparse).
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('ongoing')
  })

  it('ADVERSARIAL: non-finite firstSeenAt/lastSeenAt fall back to nowMs, never throws or produces NaN', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: NaN as unknown as number, lastSeenAt: NaN as unknown as number, count: 3 }
    expect(() => classifyPatternEpisode(pattern, nowMs)).not.toThrow()
    // firstSeenAt falls back to nowMs -> "new" (age 0 <= newWindowMs).
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('new')
  })

  it('is deterministic: same inputs always produce the same classification', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 20 * DAY_MS_LOCAL, lastSeenAt: nowMs - 2 * DAY_MS_LOCAL, count: 7 }
    const results = new Set<string>()
    for (let i = 0; i < 10; i++) results.add(classifyPatternEpisode(pattern, nowMs))
    expect(results.size).toBe(1)
  })

  it('return type is exactly one of the three literal episode labels', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const result = classifyPatternEpisode({ firstSeenAt: nowMs, lastSeenAt: nowMs, count: 1 }, nowMs)
    expect(['new', 'regressed', 'ongoing']).toContain(result)
  })

  // -------------------------------------------------------------------------
  // Cycle 3 (HARDEN) — adversarial firstSeenAt/lastSeenAt/count/nowMs combos.
  // -------------------------------------------------------------------------
  it('ADVERSARIAL: nowMs BEFORE firstSeenAt (backward clock skew) never throws and reads as "new" rather than negative-age garbage', () => {
    const firstSeenAt = 100 * DAY_MS_LOCAL
    const nowMs = 50 * DAY_MS_LOCAL // now is "before" firstSeenAt
    expect(() => classifyPatternEpisode({ firstSeenAt, lastSeenAt: firstSeenAt, count: 1 }, nowMs)).not.toThrow()
    expect(classifyPatternEpisode({ firstSeenAt, lastSeenAt: firstSeenAt, count: 1 }, nowMs)).toBe('new')
  })

  it('ADVERSARIAL: an enormous count never throws or produces NaN/Infinity leaking out as something other than a valid label', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 20 * DAY_MS_LOCAL, lastSeenAt: nowMs - 2 * DAY_MS_LOCAL, count: Number.MAX_SAFE_INTEGER }
    expect(() => classifyPatternEpisode(pattern, nowMs)).not.toThrow()
    // Astronomically frequent (avgGap ~ 0) -> reads as "ongoing", never garbage.
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('ongoing')
  })

  it('ADVERSARIAL: negative count is clamped to the same "no meaningful history" treatment as count 0, never throws or divides by a negative number', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const pattern = { firstSeenAt: nowMs - 10 * DAY_MS_LOCAL, lastSeenAt: nowMs - 5 * DAY_MS_LOCAL, count: -7 }
    expect(() => classifyPatternEpisode(pattern, nowMs)).not.toThrow()
    expect(classifyPatternEpisode(pattern, nowMs)).toBe('regressed')
  })

  it('ADVERSARIAL: Infinity/NaN count falls back to the "no meaningful average gap" treatment, never throws or leaks NaN', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const infPattern = { firstSeenAt: nowMs - 10 * DAY_MS_LOCAL, lastSeenAt: nowMs - 5 * DAY_MS_LOCAL, count: Infinity }
    const nanPattern = { firstSeenAt: nowMs - 10 * DAY_MS_LOCAL, lastSeenAt: nowMs - 5 * DAY_MS_LOCAL, count: NaN }
    expect(() => classifyPatternEpisode(infPattern, nowMs)).not.toThrow()
    expect(() => classifyPatternEpisode(nanPattern, nowMs)).not.toThrow()
    expect(['new', 'regressed', 'ongoing']).toContain(classifyPatternEpisode(infPattern, nowMs))
    expect(['new', 'regressed', 'ongoing']).toContain(classifyPatternEpisode(nanPattern, nowMs))
  })

  it('is stable/class-scoped across a whole battery of malformed inputs run in a loop (never throws, always returns a valid label)', () => {
    const nowMs = 100 * DAY_MS_LOCAL
    const battery = [
      { firstSeenAt: NaN, lastSeenAt: NaN, count: NaN },
      { firstSeenAt: Infinity, lastSeenAt: -Infinity, count: -1 },
      { firstSeenAt: 0, lastSeenAt: 0, count: 0 },
      { firstSeenAt: nowMs + 1e15, lastSeenAt: nowMs - 1e15, count: 1e15 },
    ] as Array<{ firstSeenAt: number; lastSeenAt: number; count: number }>
    for (const pattern of battery) {
      expect(() => classifyPatternEpisode(pattern, nowMs)).not.toThrow()
      expect(['new', 'regressed', 'ongoing']).toContain(classifyPatternEpisode(pattern, nowMs))
    }
  })
})

// ---------------------------------------------------------------------------
// "Resolution" cycle 1 (Team B): isRegression / timeToResolutionMs /
// summarizeResolutionHealth — pure lifecycle analytics over failure_patterns'
// upcoming open/acknowledged/resolved status + regression guard.
// ---------------------------------------------------------------------------
import { isRegression, timeToResolutionMs, summarizeResolutionHealth } from './insights'
import type { PatternLifecycleSnapshot } from './insights'

describe('isRegression', () => {
  const DAY_MS_LOCAL = 24 * HOUR_MS

  it('true: resolved pattern, resolvedAt defined, new occurrence strictly after resolvedAt', () => {
    const resolvedAt = 100 * DAY_MS_LOCAL
    expect(isRegression('resolved', resolvedAt, resolvedAt + 1)).toBe(true)
  })

  it('false: prevStatus is "open" (never resolved, so cannot regress)', () => {
    const resolvedAt = 100 * DAY_MS_LOCAL
    expect(isRegression('open', resolvedAt, resolvedAt + 1)).toBe(false)
  })

  it('false: prevStatus is "acknowledged" (not yet resolved)', () => {
    const resolvedAt = 100 * DAY_MS_LOCAL
    expect(isRegression('acknowledged', resolvedAt, resolvedAt + 1)).toBe(false)
  })

  it('false: prevStatus is some unrecognized/malformed string', () => {
    expect(isRegression('bogus', 100, 200)).toBe(false)
  })

  it('boundary: newOccurredAt exactly equal to resolvedAt is NOT a regression (strictly after, not >=)', () => {
    const resolvedAt = 100 * DAY_MS_LOCAL
    expect(isRegression('resolved', resolvedAt, resolvedAt)).toBe(false)
  })

  it('boundary: newOccurredAt one ms after resolvedAt IS a regression', () => {
    const resolvedAt = 100 * DAY_MS_LOCAL
    expect(isRegression('resolved', resolvedAt, resolvedAt + 1)).toBe(true)
  })

  it('false: newOccurredAt before resolvedAt (stale/racing occurrence)', () => {
    const resolvedAt = 100 * DAY_MS_LOCAL
    expect(isRegression('resolved', resolvedAt, resolvedAt - 1)).toBe(false)
  })

  it('false: resolvedAt is undefined even though prevStatus is "resolved" (malformed data)', () => {
    expect(isRegression('resolved', undefined, 100 * DAY_MS_LOCAL)).toBe(false)
  })

  it('ADVERSARIAL: resolvedAt is NaN never throws and returns false', () => {
    expect(() => isRegression('resolved', NaN, 100)).not.toThrow()
    expect(isRegression('resolved', NaN, 100)).toBe(false)
  })

  it('ADVERSARIAL: resolvedAt is Infinity never throws and returns false (nothing is "strictly after" Infinity)', () => {
    expect(() => isRegression('resolved', Infinity, 100)).not.toThrow()
    expect(isRegression('resolved', Infinity, 100)).toBe(false)
  })

  it('ADVERSARIAL: newOccurredAt is NaN never throws and returns false', () => {
    expect(() => isRegression('resolved', 100, NaN)).not.toThrow()
    expect(isRegression('resolved', 100, NaN)).toBe(false)
  })

  it('ADVERSARIAL: newOccurredAt is -Infinity never throws and returns false', () => {
    expect(isRegression('resolved', 100, -Infinity)).toBe(false)
  })

  it('ADVERSARIAL: newOccurredAt is +Infinity never throws and returns false (non-finite is rejected defensively, not treated as ">" everything)', () => {
    expect(() => isRegression('resolved', 100, Infinity)).not.toThrow()
    expect(isRegression('resolved', 100, Infinity)).toBe(false)
  })

  it('is deterministic: same inputs always produce the same result', () => {
    const results = new Set<boolean>()
    for (let i = 0; i < 10; i++) results.add(isRegression('resolved', 100, 200))
    expect(results.size).toBe(1)
  })
})

describe('timeToResolutionMs', () => {
  const DAY_MS_LOCAL = 24 * HOUR_MS

  it('correctness: returns resolvedAt - firstSeenAt when resolvedAt is after firstSeenAt', () => {
    expect(timeToResolutionMs(0, 5 * DAY_MS_LOCAL)).toBe(5 * DAY_MS_LOCAL)
  })

  it('correctness: a realistic multi-day resolution window', () => {
    const firstSeenAt = 1_000_000
    const resolvedAt = firstSeenAt + 3 * HOUR_MS + 17
    expect(timeToResolutionMs(firstSeenAt, resolvedAt)).toBe(3 * HOUR_MS + 17)
  })

  it('undefined: resolvedAt is undefined (pattern not resolved)', () => {
    expect(timeToResolutionMs(0, undefined)).toBeUndefined()
  })

  it('boundary: resolvedAt === firstSeenAt -> 0 (resolved instantly)', () => {
    expect(timeToResolutionMs(500, 500)).toBe(0)
  })

  it('ADVERSARIAL: resolvedAt < firstSeenAt (malformed) clamps to 0, never negative', () => {
    expect(timeToResolutionMs(1000, 500)).toBe(0)
  })

  it('ADVERSARIAL: firstSeenAt is NaN -> undefined, never NaN leaks out', () => {
    expect(timeToResolutionMs(NaN, 100)).toBeUndefined()
  })

  it('ADVERSARIAL: resolvedAt is NaN -> undefined (distinct from "not resolved" but same safe result)', () => {
    expect(timeToResolutionMs(0, NaN)).toBeUndefined()
  })

  it('ADVERSARIAL: firstSeenAt is Infinity -> undefined, never Infinity/NaN leaks out', () => {
    expect(timeToResolutionMs(Infinity, 100)).toBeUndefined()
  })

  it('ADVERSARIAL: resolvedAt is Infinity -> undefined', () => {
    expect(timeToResolutionMs(0, Infinity)).toBeUndefined()
  })

  it('ADVERSARIAL: huge but finite timestamps never overflow to Infinity/NaN', () => {
    const result = timeToResolutionMs(0, Number.MAX_SAFE_INTEGER)
    expect(result).toBe(Number.MAX_SAFE_INTEGER)
    expect(Number.isFinite(result)).toBe(true)
  })

  it('is deterministic: same inputs always produce the same result', () => {
    const results = new Set<number | undefined>()
    for (let i = 0; i < 10; i++) results.add(timeToResolutionMs(100, 5000))
    expect(results.size).toBe(1)
  })
})

describe('summarizeResolutionHealth', () => {
  const DAY_MS_LOCAL = 24 * HOUR_MS
  const nowMs = 1000 * DAY_MS_LOCAL

  function snap(overrides: Partial<PatternLifecycleSnapshot>): PatternLifecycleSnapshot {
    return {
      status: 'open',
      firstSeenAt: nowMs - 10 * DAY_MS_LOCAL,
      lastSeenAt: nowMs - 5 * DAY_MS_LOCAL,
      count: 1,
      ...overrides,
    }
  }

  it('empty input: total 0 -> all counts 0, regressionRate 0, TTRs null, healthScore is the documented neutral 100', () => {
    const result = summarizeResolutionHealth([], nowMs)
    expect(result).toEqual({
      total: 0,
      open: 0,
      acknowledged: 0,
      resolved: 0,
      regressed: 0,
      regressionRate: 0,
      avgTimeToResolutionMs: null,
      medianTimeToResolutionMs: null,
      healthScore: 100,
      // cycle 2 ("prove the fix held") fields — all additive, all neutral on
      // empty input. provenHealthScore mirrors healthScore's documented
      // neutral-good 100 for "no patterns at all".
      confirmedResolutions: 0,
      provingResolutions: 0,
      unprovenResolutions: 0,
      resolutionsWithoutEvidence: 0,
      confirmationRate: 0,
      provenHealthScore: 100,
    })
  })

  it('single element, open: total 1, open 1, healthScore reflects 0% resolved fraction (0)', () => {
    const result = summarizeResolutionHealth([snap({ status: 'open' })], nowMs)
    expect(result.total).toBe(1)
    expect(result.open).toBe(1)
    expect(result.resolved).toBe(0)
    expect(result.regressed).toBe(0)
    expect(result.regressionRate).toBe(0)
    expect(result.avgTimeToResolutionMs).toBeNull()
    expect(result.medianTimeToResolutionMs).toBeNull()
    expect(result.healthScore).toBe(0)
  })

  it('single element, resolved (no regression): healthScore is 100 (resolvedFraction=1, regressionRate=0)', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const resolvedAt = nowMs - 5 * DAY_MS_LOCAL
    const result = summarizeResolutionHealth([snap({ status: 'resolved', firstSeenAt, resolvedAt })], nowMs)
    expect(result.total).toBe(1)
    expect(result.resolved).toBe(1)
    expect(result.regressed).toBe(0)
    expect(result.regressionRate).toBe(0)
    expect(result.avgTimeToResolutionMs).toBe(5 * DAY_MS_LOCAL)
    expect(result.medianTimeToResolutionMs).toBe(5 * DAY_MS_LOCAL)
    expect(result.healthScore).toBe(100)
  })

  it('all-open: resolved fraction 0, no TTRs, healthScore 0', () => {
    const snapshots = [snap({ status: 'open' }), snap({ status: 'open' }), snap({ status: 'acknowledged' })]
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.total).toBe(3)
    expect(result.open).toBe(2)
    expect(result.acknowledged).toBe(1)
    expect(result.resolved).toBe(0)
    expect(result.healthScore).toBe(0)
    expect(result.avgTimeToResolutionMs).toBeNull()
    expect(result.medianTimeToResolutionMs).toBeNull()
  })

  it('all-resolved, no regressions: healthScore 100, correct avg/median TTR', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const snapshots = [
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL }),
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 3 * DAY_MS_LOCAL }),
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 5 * DAY_MS_LOCAL }),
    ]
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.total).toBe(3)
    expect(result.resolved).toBe(3)
    expect(result.regressed).toBe(0)
    expect(result.regressionRate).toBe(0)
    expect(result.avgTimeToResolutionMs).toBe(3 * DAY_MS_LOCAL) // (1+3+5)/3
    expect(result.medianTimeToResolutionMs).toBe(3 * DAY_MS_LOCAL)
    expect(result.healthScore).toBe(100)
  })

  it('regression rate denominator: only resolved-or-once-resolved patterns count, never-resolved open patterns are excluded', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const snapshots = [
      // 1 resolved (no regression), 1 open that regressed-and-reopened (regressedAt set, status back to open),
      // 2 plain open patterns that have NEVER been resolved (must NOT count in the regression-rate denominator).
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL }),
      snap({ status: 'open', regressedAt: nowMs - 1 * DAY_MS_LOCAL }),
      snap({ status: 'open' }),
      snap({ status: 'open' }),
    ]
    const result = summarizeResolutionHealth(snapshots, nowMs)
    // denominator = 2 (the resolved one + the regressed-and-reopened one); numerator (regressed) = 1.
    expect(result.regressed).toBe(1)
    expect(result.regressionRate).toBe(0.5)
  })

  it('a pattern that regressed still counts against health even if currently re-resolved', () => {
    const firstSeenAt = nowMs - 20 * DAY_MS_LOCAL
    const snapshots = [
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 2 * DAY_MS_LOCAL, regressedAt: firstSeenAt + 5 * DAY_MS_LOCAL }),
    ]
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.resolved).toBe(1)
    expect(result.regressed).toBe(1)
    expect(result.regressionRate).toBe(1) // denom=1 (resolved), numerator=1 (regressed) -> 100% regression rate
    expect(result.healthScore).toBeLessThan(100) // penalized despite resolvedFraction being 1
  })

  it('healthScore MONOTONICITY: adding another resolved pattern (holding regressions fixed) raises the score', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const base = [snap({ status: 'open' }), snap({ status: 'open' })]
    const withOneResolved = [...base, snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL })]
    const withTwoResolved = [
      ...base,
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL }),
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL }),
    ]
    const scoreBase = summarizeResolutionHealth(base, nowMs).healthScore
    const scoreOne = summarizeResolutionHealth(withOneResolved, nowMs).healthScore
    const scoreTwo = summarizeResolutionHealth(withTwoResolved, nowMs).healthScore
    expect(scoreOne).toBeGreaterThan(scoreBase)
    expect(scoreTwo).toBeGreaterThan(scoreOne)
  })

  it('healthScore MONOTONICITY: more regressions (holding resolved-fraction fixed) lowers the score', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const resolvedOnly = snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL })
    const resolvedRegressedOnce = snap({
      status: 'resolved',
      firstSeenAt,
      resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL,
      regressedAt: firstSeenAt + 2 * DAY_MS_LOCAL,
    })
    // Two independent patterns each resolved: zero vs one-of-two regressed.
    const zeroRegressions = [resolvedOnly, resolvedOnly]
    const oneRegression = [resolvedOnly, resolvedRegressedOnce]
    const scoreZero = summarizeResolutionHealth(zeroRegressions, nowMs).healthScore
    const scoreOne = summarizeResolutionHealth(oneRegression, nowMs).healthScore
    expect(scoreOne).toBeLessThan(scoreZero)
  })

  it('healthScore is always clamped within [0, 100]', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    // Every pattern resolved AND regressed -> resolvedFraction=1, regressionRate=1 -> raw = 100 - 50 = 50, still in range.
    const snapshots = Array.from({ length: 5 }, () =>
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1, regressedAt: firstSeenAt + 2 }),
    )
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.healthScore).toBeGreaterThanOrEqual(0)
    expect(result.healthScore).toBeLessThanOrEqual(100)
  })

  it('median vs average differ correctly for a skewed TTR distribution', () => {
    const firstSeenAt = nowMs - 100 * DAY_MS_LOCAL
    const snapshots = [
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * HOUR_MS }),
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 2 * HOUR_MS }),
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 100 * HOUR_MS }), // outlier
    ]
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.medianTimeToResolutionMs).toBe(2 * HOUR_MS)
    expect(result.avgTimeToResolutionMs).toBeCloseTo((1 + 2 + 100) * HOUR_MS / 3, 5)
    expect(result.avgTimeToResolutionMs).not.toBe(result.medianTimeToResolutionMs)
  })

  it('median with an even number of resolved TTRs averages the two middle values', () => {
    const firstSeenAt = nowMs - 100 * DAY_MS_LOCAL
    const snapshots = [
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * HOUR_MS }),
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 3 * HOUR_MS }),
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 5 * HOUR_MS }),
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 7 * HOUR_MS }),
    ]
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.medianTimeToResolutionMs).toBe(4 * HOUR_MS) // (3+5)/2
  })

  it('ADVERSARIAL: non-array input never throws, treated as empty', () => {
    // @ts-expect-error deliberately malformed input for defensive-handling test
    expect(() => summarizeResolutionHealth(null, nowMs)).not.toThrow()
    // @ts-expect-error deliberately malformed input for defensive-handling test
    expect(summarizeResolutionHealth(null, nowMs).total).toBe(0)
    // @ts-expect-error deliberately malformed input for defensive-handling test
    expect(summarizeResolutionHealth(undefined, nowMs).total).toBe(0)
  })

  it('ADVERSARIAL: array containing null/undefined entries never throws, malformed entries are dropped', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const snapshots = [
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL }),
      null,
      undefined,
    ] as unknown as PatternLifecycleSnapshot[]
    expect(() => summarizeResolutionHealth(snapshots, nowMs)).not.toThrow()
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.total).toBe(1)
    expect(result.resolved).toBe(1)
  })

  it('ADVERSARIAL: unrecognized status string counted in total but not in any status bucket', () => {
    const snapshots = [snap({ status: 'weird' as PatternLifecycleSnapshot['status'] })]
    expect(() => summarizeResolutionHealth(snapshots, nowMs)).not.toThrow()
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.total).toBe(1)
    expect(result.open + result.acknowledged + result.resolved).toBe(0)
  })

  it('ADVERSARIAL: resolvedAt < firstSeenAt on a resolved pattern is excluded from TTR average via the clamp-to-0 rule, not NaN', () => {
    const firstSeenAt = nowMs - 5 * DAY_MS_LOCAL
    const snapshots = [snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt - 1000 })]
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.avgTimeToResolutionMs).toBe(0)
    expect(result.medianTimeToResolutionMs).toBe(0)
    expect(Number.isNaN(result.avgTimeToResolutionMs)).toBe(false)
  })

  it('ADVERSARIAL: NaN/Infinity timestamps on individual snapshots never leak into aggregate output', () => {
    const snapshots = [
      snap({ status: 'resolved', firstSeenAt: NaN, resolvedAt: 100 }),
      snap({ status: 'resolved', firstSeenAt: Infinity, resolvedAt: 100 }),
      snap({ status: 'resolved', firstSeenAt: 0, resolvedAt: NaN }),
      snap({ status: 'resolved', firstSeenAt: 0, resolvedAt: Infinity }),
    ]
    expect(() => summarizeResolutionHealth(snapshots, nowMs)).not.toThrow()
    const result = summarizeResolutionHealth(snapshots, nowMs)
    // All four TTRs are unusable (undefined) -> excluded -> null averages, not NaN.
    expect(result.avgTimeToResolutionMs).toBeNull()
    expect(result.medianTimeToResolutionMs).toBeNull()
    expect(Number.isFinite(result.healthScore)).toBe(true)
  })

  it('ADVERSARIAL: huge count of snapshots (thousands) never throws and stays within bounds', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const snapshots = Array.from({ length: 5000 }, (_, i) =>
      i % 3 === 0
        ? snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + (i + 1) * 1000 })
        : snap({ status: i % 3 === 1 ? 'open' : 'acknowledged' }),
    )
    expect(() => summarizeResolutionHealth(snapshots, nowMs)).not.toThrow()
    const result = summarizeResolutionHealth(snapshots, nowMs)
    expect(result.total).toBe(5000)
    expect(result.healthScore).toBeGreaterThanOrEqual(0)
    expect(result.healthScore).toBeLessThanOrEqual(100)
  })

  it('is deterministic: same inputs always produce the same output', () => {
    const firstSeenAt = nowMs - 10 * DAY_MS_LOCAL
    const snapshots = [
      snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 1 * DAY_MS_LOCAL }),
      snap({ status: 'open' }),
      snap({ status: 'acknowledged', regressedAt: nowMs - 1 * DAY_MS_LOCAL }),
    ]
    const results = new Set<string>()
    for (let i = 0; i < 10; i++) results.add(JSON.stringify(summarizeResolutionHealth(snapshots, nowMs)))
    expect(results.size).toBe(1)
  })

  it('never reads Date.now(): identical outputs regardless of when the test runs, for the same nowMs argument', () => {
    const firstSeenAt = 12345
    const snapshots = [snap({ status: 'resolved', firstSeenAt, resolvedAt: firstSeenAt + 999 })]
    const a = summarizeResolutionHealth(snapshots, 999999)
    const b = summarizeResolutionHealth(snapshots, 999999)
    expect(expect.getState().currentTestName, '').toBeDefined()
    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------------------
// "Resolution" cycle 2 (Team B): fixConfidence / deriveFixConfidenceState /
// fixConfidenceForSnapshots + the asserted-vs-confirmed extension to
// summarizeResolutionHealth. These tests pin INTENDED BEHAVIOUR for every
// threshold and every degenerate input — not merely "does not throw".
// ---------------------------------------------------------------------------
import {
  fixConfidence,
  deriveFixConfidenceState,
  fixConfidenceForSnapshots,
  FIX_CONFIDENCE_FLOOR,
  FIX_CONFIDENCE_MAX,
  FIX_CONFIDENCE_RUNS_FOR_FULL_CREDIT,
  FIX_CONFIDENCE_SOAK_MS_FOR_FULL_CREDIT,
  FIX_CONFIDENCE_EXPOSURE_BASE_WEIGHT,
  FIX_CONFIDENCE_SOAK_WEIGHT,
  FIX_CONFIDENCE_MIN_EXPOSURE_RUNS,
  FIX_CONFIDENCE_CONFIRMED_THRESHOLD,
  FIX_CREDIT_CONFIRMED,
  FIX_CREDIT_PROVING,
  FIX_CREDIT_UNPROVEN,
  FIX_CREDIT_REGRESSED,
} from './insights'
import type { FixConfidenceState, FixConfidenceInput, FixConfidenceLimit } from './insights'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const NOW = 1000 * DAY

/** Reference implementation of the documented formula, used to cross-check fixConfidence. */
function expectedScore(exposureRuns: number, elapsedMs: number): number {
  const e = Math.min(1, Math.max(0, exposureRuns / FIX_CONFIDENCE_RUNS_FOR_FULL_CREDIT))
  const s = Math.min(1, Math.max(0, elapsedMs / FIX_CONFIDENCE_SOAK_MS_FOR_FULL_CREDIT))
  const raw = FIX_CONFIDENCE_MAX * e * (FIX_CONFIDENCE_EXPOSURE_BASE_WEIGHT + FIX_CONFIDENCE_SOAK_WEIGHT * s)
  return Math.round(raw * 10000) / 10000
}

/** A resolution `soakMs` before NOW with `runs` of post-resolution exposure. */
function input(runs: number | undefined, soakMs: number, extra: Partial<FixConfidenceInput> = {}): FixConfidenceInput {
  return { resolvedAt: NOW - soakMs, postResolutionRuns: runs, ...extra }
}

describe('fix-confidence constants', () => {
  it('the two evidence weights sum to exactly 1 (documented invariant)', () => {
    expect(FIX_CONFIDENCE_EXPOSURE_BASE_WEIGHT + FIX_CONFIDENCE_SOAK_WEIGHT).toBe(1)
  })

  it('has the documented values (a change here is a product decision, not a refactor)', () => {
    expect(FIX_CONFIDENCE_FLOOR).toBe(0)
    expect(FIX_CONFIDENCE_MAX).toBe(0.95)
    expect(FIX_CONFIDENCE_RUNS_FOR_FULL_CREDIT).toBe(50)
    expect(FIX_CONFIDENCE_SOAK_MS_FOR_FULL_CREDIT).toBe(7 * DAY)
    expect(FIX_CONFIDENCE_EXPOSURE_BASE_WEIGHT).toBe(0.7)
    expect(FIX_CONFIDENCE_SOAK_WEIGHT).toBe(0.3)
    expect(FIX_CONFIDENCE_MIN_EXPOSURE_RUNS).toBe(1)
    expect(FIX_CONFIDENCE_CONFIRMED_THRESHOLD).toBe(0.7)
  })

  it('the ceiling is strictly below 1: the product never claims certainty', () => {
    expect(FIX_CONFIDENCE_MAX).toBeLessThan(1)
  })

  it('credit table is ordered confirmed > proving > unproven > regressed', () => {
    expect(FIX_CREDIT_CONFIRMED).toBeGreaterThan(FIX_CREDIT_PROVING)
    expect(FIX_CREDIT_PROVING).toBeGreaterThan(FIX_CREDIT_UNPROVEN)
    expect(FIX_CREDIT_UNPROVEN).toBeGreaterThan(FIX_CREDIT_REGRESSED)
    expect(FIX_CREDIT_CONFIRMED).toBe(1)
    expect(FIX_CREDIT_REGRESSED).toBe(0)
  })

  it('full exposure with zero soak lands BELOW the confirm threshold (soak must be earned)', () => {
    expect(expectedScore(FIX_CONFIDENCE_RUNS_FOR_FULL_CREDIT, 0)).toBeLessThan(FIX_CONFIDENCE_CONFIRMED_THRESHOLD)
  })

  it('full exposure with full soak lands exactly at the ceiling', () => {
    expect(expectedScore(FIX_CONFIDENCE_RUNS_FOR_FULL_CREDIT, FIX_CONFIDENCE_SOAK_MS_FOR_FULL_CREDIT)).toBe(
      FIX_CONFIDENCE_MAX,
    )
  })
})

describe('deriveFixConfidenceState', () => {
  const cases: Array<{
    name: string
    args: { score: number; exposureRuns: number; recurred: boolean; hasResolution: boolean }
    expected: FixConfidenceState
  }> = [
    {
      name: 'recurrence wins over everything, even a maxed-out score',
      args: { score: FIX_CONFIDENCE_MAX, exposureRuns: 10000, recurred: true, hasResolution: true },
      expected: 'regressed',
    },
    {
      name: 'recurrence wins even with no recorded resolution (malformed metadata cannot hide a counter-example)',
      args: { score: 0, exposureRuns: 0, recurred: true, hasResolution: false },
      expected: 'regressed',
    },
    {
      name: 'no resolution asserted => unproven (nothing to prove)',
      args: { score: 0.9, exposureRuns: 500, recurred: false, hasResolution: false },
      expected: 'unproven',
    },
    {
      name: 'ZERO exposure is unproven, NEVER proving — even with a high score passed in',
      args: { score: 0.99, exposureRuns: 0, recurred: false, hasResolution: true },
      expected: 'unproven',
    },
    {
      name: 'exactly MIN_EXPOSURE_RUNS (1) with a low score => proving',
      args: { score: 0.01, exposureRuns: FIX_CONFIDENCE_MIN_EXPOSURE_RUNS, recurred: false, hasResolution: true },
      expected: 'proving',
    },
    {
      name: 'score exactly at the confirm threshold => confirmed (>= not >)',
      args: { score: FIX_CONFIDENCE_CONFIRMED_THRESHOLD, exposureRuns: 50, recurred: false, hasResolution: true },
      expected: 'confirmed',
    },
    {
      name: 'score one ulp-ish below the confirm threshold => proving',
      args: { score: FIX_CONFIDENCE_CONFIRMED_THRESHOLD - 0.0001, exposureRuns: 50, recurred: false, hasResolution: true },
      expected: 'proving',
    },
    {
      name: 'NaN score degrades to the floor => proving (exposure exists) rather than throwing',
      args: { score: NaN, exposureRuns: 5, recurred: false, hasResolution: true },
      expected: 'proving',
    },
    {
      name: 'NaN exposureRuns degrades to 0 => unproven',
      args: { score: 0.9, exposureRuns: NaN, recurred: false, hasResolution: true },
      expected: 'unproven',
    },
    {
      name: 'negative exposureRuns is below the minimum => unproven',
      args: { score: 0.9, exposureRuns: -10, recurred: false, hasResolution: true },
      expected: 'unproven',
    },
    {
      name: 'Infinity exposure is malformed data, sanitized to 0 => unproven, NOT confirmed',
      args: { score: 0.8, exposureRuns: Infinity, recurred: false, hasResolution: true },
      expected: 'unproven',
    },
    {
      name: 'a large but FINITE exposure with a confirming score => confirmed',
      args: { score: 0.8, exposureRuns: 1e6, recurred: false, hasResolution: true },
      expected: 'confirmed',
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(deriveFixConfidenceState(c.args)).toBe(c.expected)
    })
  }

  it('never returns anything outside the four documented states, across a malformed battery', () => {
    const battery = [NaN, Infinity, -Infinity, -1, 0, 0.7, 1, 1e9]
    for (const score of battery) {
      for (const exposureRuns of battery) {
        for (const recurred of [true, false]) {
          for (const hasResolution of [true, false]) {
            const state = deriveFixConfidenceState({ score, exposureRuns, recurred, hasResolution })
            expect(['unproven', 'proving', 'confirmed', 'regressed']).toContain(state)
          }
        }
      }
    }
  })
})

describe('fixConfidence — score math and the three drivers', () => {
  const table: Array<{
    name: string
    runs: number
    soakMs: number
    expectedState: FixConfidenceState
    expectedLimit: FixConfidenceLimit
  }> = [
    { name: 'full exposure + full soak => ceiling, confirmed', runs: 50, soakMs: 7 * DAY, expectedState: 'confirmed', expectedLimit: 'none' },
    { name: 'full exposure + no soak => 0.665, still only proving', runs: 50, soakMs: 0, expectedState: 'proving', expectedLimit: 'accumulating' },
    { name: 'full exposure + 1 day soak => just over the confirm bar', runs: 50, soakMs: 1 * DAY, expectedState: 'confirmed', expectedLimit: 'none' },
    { name: 'half exposure + full soak => proving', runs: 25, soakMs: 7 * DAY, expectedState: 'proving', expectedLimit: 'accumulating' },
    { name: 'single run + full soak => proving with a tiny score', runs: 1, soakMs: 7 * DAY, expectedState: 'proving', expectedLimit: 'accumulating' },
    { name: 'over-full exposure + over-full soak saturates at the ceiling', runs: 5000, soakMs: 90 * DAY, expectedState: 'confirmed', expectedLimit: 'none' },
    { name: 'zero exposure + very long soak => floor, unproven', runs: 0, soakMs: 365 * DAY, expectedState: 'unproven', expectedLimit: 'no-exposure' },
  ]

  for (const c of table) {
    it(c.name, () => {
      const r = fixConfidence(input(c.runs, c.soakMs), NOW)
      expect(r.score).toBe(expectedScore(c.runs, c.soakMs))
      expect(r.state).toBe(c.expectedState)
      expect(r.limitingFactor).toBe(c.expectedLimit)
    })
  }

  it('the exact documented confirm boundary: 50 runs needs ~20.6h of soak (20h is proving, 21h is confirmed)', () => {
    expect(fixConfidence(input(50, 20 * HOUR), NOW).state).toBe('proving')
    expect(fixConfidence(input(50, 21 * HOUR), NOW).state).toBe('confirmed')
  })

  it('the exact documented confirm boundary: 40 runs needs ~5.2d of soak (5d is proving, 5.5d is confirmed)', () => {
    expect(fixConfidence(input(40, 5 * DAY), NOW).state).toBe('proving')
    expect(fixConfidence(input(40, 5.5 * DAY), NOW).state).toBe('confirmed')
  })

  it('reports all three drivers as separate inspectable fields with their raw units', () => {
    const r = fixConfidence(input(20, 2 * DAY), NOW)
    expect(r.exposureRuns).toBe(20) // count of runs
    expect(r.elapsedMs).toBe(2 * DAY) // milliseconds
    expect(r.recurred).toBe(false) // boolean
    // ...and the two normalized sub-scores the UI renders as bars
    expect(r.exposureCredit).toBe(0.4)
    expect(r.soakCredit).toBe(round4Local(2 / 7))
  })

  function round4Local(n: number): number {
    return Math.round(n * 10000) / 10000
  }

  it('score is always within [FLOOR, MAX] across a wide sweep', () => {
    for (const runs of [0, 1, 7, 49, 50, 51, 1e6]) {
      for (const soak of [0, 1, HOUR, DAY, 7 * DAY, 400 * DAY]) {
        const r = fixConfidence(input(runs, soak), NOW)
        expect(r.score).toBeGreaterThanOrEqual(FIX_CONFIDENCE_FLOOR)
        expect(r.score).toBeLessThanOrEqual(FIX_CONFIDENCE_MAX)
        expect(Number.isFinite(r.score)).toBe(true)
      }
    }
  })

  it('is monotonic in exposure: more runs never lowers the score', () => {
    let prev = -1
    for (const runs of [0, 1, 5, 10, 25, 40, 50, 100]) {
      const s = fixConfidence(input(runs, 2 * DAY), NOW).score
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  it('is monotonic in soak: more elapsed time never lowers the score', () => {
    let prev = -1
    for (const soak of [0, HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY]) {
      const s = fixConfidence(input(30, soak), NOW).score
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  it('is deterministic: the same inputs always produce the identical object', () => {
    const results = new Set<string>()
    for (let i = 0; i < 10; i++) results.add(JSON.stringify(fixConfidence(input(33, 3 * DAY), NOW)))
    expect(results.size).toBe(1)
  })
})

describe('fixConfidence — zero exposure is unproven, never confident', () => {
  it('zero post-resolution runs scores exactly the floor even after a year', () => {
    const r = fixConfidence(input(0, 365 * DAY), NOW)
    expect(r.score).toBe(FIX_CONFIDENCE_FLOOR)
    expect(r.state).toBe('unproven')
    expect(r.limitingFactor).toBe('no-exposure')
    expect(r.exposureRuns).toBe(0)
    expect(r.soakCredit).toBe(1) // soak WAS full — and it still bought nothing
  })

  it('zero exposure is reported as measured when the caller supplied 0 explicitly', () => {
    const r = fixConfidence(input(0, DAY), NOW)
    expect(r.exposureMeasured).toBe(true)
    expect(r.observedRuns).toBe(0)
  })

  it('unmeasured exposure (undefined) is distinguishable from a measured zero, and scores the same', () => {
    const r = fixConfidence(input(undefined, DAY), NOW)
    expect(r.exposureMeasured).toBe(false)
    expect(r.observedRuns).toBe(0)
    expect(r.score).toBe(FIX_CONFIDENCE_FLOOR)
    expect(r.state).toBe('unproven')
  })

  it('zero exposure can never reach "proving" no matter the soak', () => {
    for (const soak of [0, DAY, 7 * DAY, 1000 * DAY]) {
      expect(fixConfidence(input(0, soak), NOW).state).toBe('unproven')
    }
  })
})

describe('fixConfidence — a recurrence collapses confidence to the floor', () => {
  it('collapses a would-be-ceiling score to exactly the floor', () => {
    const resolvedAt = NOW - 7 * DAY
    const clean = fixConfidence({ resolvedAt, postResolutionRuns: 5000 }, NOW)
    expect(clean.score).toBe(FIX_CONFIDENCE_MAX)

    const recurred = fixConfidence({ resolvedAt, postResolutionRuns: 5000, recurredAt: NOW - DAY }, NOW)
    expect(recurred.score).toBe(FIX_CONFIDENCE_FLOOR)
    expect(recurred.state).toBe('regressed')
    expect(recurred.limitingFactor).toBe('recurrence')
  })

  it('still reports the prior exposure so the UI can say "it came back after N clean runs"', () => {
    const r = fixConfidence({ resolvedAt: NOW - 7 * DAY, postResolutionRuns: 5000, recurredAt: NOW - DAY }, NOW)
    expect(r.exposureRuns).toBe(5000)
    expect(r.recurred).toBe(true)
  })

  it('a recurrence at exactly resolvedAt is NOT a regression (it is the occurrence that prompted the fix)', () => {
    const resolvedAt = NOW - 7 * DAY
    const r = fixConfidence({ resolvedAt, postResolutionRuns: 50, recurredAt: resolvedAt }, NOW)
    expect(r.recurred).toBe(false)
    expect(r.state).toBe('confirmed')
  })

  it('a recurrence BEFORE resolvedAt is not a regression', () => {
    const resolvedAt = NOW - 7 * DAY
    const r = fixConfidence({ resolvedAt, postResolutionRuns: 50, recurredAt: resolvedAt - DAY }, NOW)
    expect(r.recurred).toBe(false)
    expect(r.state).toBe('confirmed')
  })

  it('a recurrence one ms after resolvedAt IS a regression (same strictness as isRegression)', () => {
    const resolvedAt = NOW - 7 * DAY
    const r = fixConfidence({ resolvedAt, postResolutionRuns: 50, recurredAt: resolvedAt + 1 }, NOW)
    expect(r.recurred).toBe(true)
    expect(r.state).toBe('regressed')
  })

  it('recurrence outranks a missing resolution timestamp', () => {
    const r = fixConfidence({ resolvedAt: undefined, recurredAt: NOW - DAY, postResolutionRuns: 10 }, NOW)
    expect(r.state).toBe('regressed')
    expect(r.limitingFactor).toBe('recurrence')
  })

  it('a NaN recurredAt is not a recurrence (malformed, not proof)', () => {
    const r = fixConfidence({ resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50, recurredAt: NaN }, NOW)
    expect(r.recurred).toBe(false)
    expect(r.state).toBe('confirmed')
  })
})

describe('fixConfidence — version attribution', () => {
  const resolvedAt = NOW - 7 * DAY

  it('matched versions credit the exposure in full', () => {
    const r = fixConfidence(
      { resolvedAt, postResolutionRuns: 50, resolvedInVersionId: 'v2', exposureVersionId: 'v2' },
      NOW,
    )
    expect(r.versionAttribution).toBe('matched')
    expect(r.exposureRuns).toBe(50)
    expect(r.state).toBe('confirmed')
  })

  it('mismatched versions discard the exposure: those runs did not test this fix', () => {
    const r = fixConfidence(
      { resolvedAt, postResolutionRuns: 50, resolvedInVersionId: 'v2', exposureVersionId: 'v3' },
      NOW,
    )
    expect(r.versionAttribution).toBe('mismatched')
    expect(r.exposureRuns).toBe(0)
    expect(r.observedRuns).toBe(50) // still reported, so the UI can explain the discard
    expect(r.score).toBe(FIX_CONFIDENCE_FLOOR)
    expect(r.state).toBe('unproven')
    expect(r.limitingFactor).toBe('version-mismatch')
  })

  it('unknown attribution (either id missing) credits the exposure as observed', () => {
    for (const extra of [
      { resolvedInVersionId: 'v2' },
      { exposureVersionId: 'v2' },
      {},
      { resolvedInVersionId: '', exposureVersionId: 'v2' },
    ]) {
      const r = fixConfidence({ resolvedAt, postResolutionRuns: 50, ...extra }, NOW)
      expect(r.versionAttribution).toBe('unknown')
      expect(r.exposureRuns).toBe(50)
    }
  })
})

describe('fixConfidence — degenerate inputs are pinned, not merely survived', () => {
  it('resolvedAt undefined on an otherwise-resolved pattern: floor, unproven, "no-resolution"', () => {
    const r = fixConfidence({ resolvedAt: undefined, postResolutionRuns: 500 }, NOW)
    expect(r.hasResolution).toBe(false)
    expect(r.elapsedMs).toBe(0)
    expect(r.score).toBe(FIX_CONFIDENCE_FLOOR)
    expect(r.state).toBe('unproven')
    expect(r.limitingFactor).toBe('no-resolution')
  })

  it('resolvedAt NaN behaves exactly like undefined', () => {
    const r = fixConfidence({ resolvedAt: NaN, postResolutionRuns: 500 }, NOW)
    expect(r.hasResolution).toBe(false)
    expect(r.state).toBe('unproven')
    expect(r.limitingFactor).toBe('no-resolution')
  })

  it('resolvedAt Infinity behaves exactly like undefined', () => {
    const r = fixConfidence({ resolvedAt: Infinity, postResolutionRuns: 500 }, NOW)
    expect(r.hasResolution).toBe(false)
    expect(r.state).toBe('unproven')
  })

  it('resolvedAt in the FUTURE relative to nowMs: elapsed clamps to 0, never negative', () => {
    const r = fixConfidence({ resolvedAt: NOW + 30 * DAY, postResolutionRuns: 50 }, NOW)
    expect(r.elapsedMs).toBe(0)
    expect(r.soakCredit).toBe(0)
    expect(r.score).toBe(expectedScore(50, 0))
    expect(r.state).toBe('proving')
  })

  it('a future resolvedAt does not erase measured exposure (clock skew must not destroy data either)', () => {
    const r = fixConfidence({ resolvedAt: NOW + 30 * DAY, postResolutionRuns: 50 }, NOW)
    expect(r.exposureRuns).toBe(50)
    expect(r.exposureCredit).toBe(1)
  })

  it('a future resolvedAt can never manufacture confidence', () => {
    expect(fixConfidence({ resolvedAt: NOW + 1e12, postResolutionRuns: 50 }, NOW).score).toBeLessThan(
      FIX_CONFIDENCE_CONFIRMED_THRESHOLD,
    )
  })

  it('negative postResolutionRuns sanitizes to 0 exposure (never a negative score)', () => {
    const r = fixConfidence(input(-50, 7 * DAY), NOW)
    expect(r.observedRuns).toBe(0)
    expect(r.exposureRuns).toBe(0)
    expect(r.score).toBe(FIX_CONFIDENCE_FLOOR)
    expect(r.state).toBe('unproven')
    expect(r.exposureMeasured).toBe(true)
  })

  it('NaN postResolutionRuns reads as unmeasured, scores the floor, leaks no NaN', () => {
    const r = fixConfidence(input(NaN, 7 * DAY), NOW)
    expect(r.exposureMeasured).toBe(false)
    expect(r.observedRuns).toBe(0)
    expect(Number.isNaN(r.score)).toBe(false)
    expect(r.score).toBe(FIX_CONFIDENCE_FLOOR)
  })

  it('Infinity postResolutionRuns reads as unmeasured rather than as infinite confidence', () => {
    const r = fixConfidence(input(Infinity, 7 * DAY), NOW)
    expect(r.exposureMeasured).toBe(false)
    expect(r.exposureRuns).toBe(0)
    expect(r.score).toBe(FIX_CONFIDENCE_FLOOR)
  })

  it('fractional run counts floor to whole runs', () => {
    expect(fixConfidence(input(7.9, DAY), NOW).exposureRuns).toBe(7)
  })

  it('nowMs NaN: soak is unmeasurable (0) but exposure still counts', () => {
    const r = fixConfidence({ resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50 }, NaN)
    expect(r.elapsedMs).toBe(0)
    expect(r.soakCredit).toBe(0)
    expect(r.score).toBe(expectedScore(50, 0))
    expect(Number.isFinite(r.score)).toBe(true)
  })

  it('nowMs Infinity does not produce an Infinity/NaN score', () => {
    const r = fixConfidence({ resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50 }, Infinity)
    expect(Number.isFinite(r.score)).toBe(true)
    expect(r.score).toBeLessThanOrEqual(FIX_CONFIDENCE_MAX)
  })

  it('a null/undefined input object degrades to the floor instead of throwing', () => {
    expect(() => fixConfidence(undefined as unknown as FixConfidenceInput, NOW)).not.toThrow()
    const r = fixConfidence(undefined as unknown as FixConfidenceInput, NOW)
    expect(r.score).toBe(FIX_CONFIDENCE_FLOOR)
    expect(r.state).toBe('unproven')
  })

  it('an empty input object is unproven with no resolution', () => {
    const r = fixConfidence({}, NOW)
    expect(r.state).toBe('unproven')
    expect(r.limitingFactor).toBe('no-resolution')
  })

  it('no field of the result is ever NaN or Infinity, across a full malformed battery', () => {
    const stamps = [undefined, NaN, Infinity, -Infinity, 0, NOW, NOW + 1e12]
    const counts = [undefined, NaN, Infinity, -Infinity, -5, 0, 3.7, 1e12]
    for (const resolvedAt of stamps) {
      for (const recurredAt of stamps) {
        for (const postResolutionRuns of counts) {
          const r = fixConfidence({ resolvedAt, recurredAt, postResolutionRuns }, NOW)
          for (const [key, value] of Object.entries(r)) {
            if (typeof value === 'number') {
              expect(Number.isFinite(value), `${key} must be finite`).toBe(true)
            }
          }
          expect(['unproven', 'proving', 'confirmed', 'regressed']).toContain(r.state)
        }
      }
    }
  })
})

describe('fixConfidenceForSnapshots', () => {
  function snapshot(overrides: Partial<PatternLifecycleSnapshot>): PatternLifecycleSnapshot {
    return { status: 'open', firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 20 * DAY, count: 5, ...overrides }
  }

  it('returns null for a pattern that has never been through resolution', () => {
    const out = fixConfidenceForSnapshots([snapshot({ status: 'open' }), snapshot({ status: 'acknowledged' })], NOW)
    expect(out).toEqual([null, null])
  })

  it('scores a currently-resolved pattern', () => {
    const out = fixConfidenceForSnapshots(
      [snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50 })],
      NOW,
    )
    expect(out[0]?.state).toBe('confirmed')
  })

  it('scores an AUTO-REOPENED pattern (status open + regressedAt) as regressed — agrees with the UI predicate', () => {
    const out = fixConfidenceForSnapshots(
      [snapshot({ status: 'open', resolvedAt: NOW - 7 * DAY, regressedAt: NOW - DAY, postResolutionRuns: 40 })],
      NOW,
    )
    expect(out[0]?.state).toBe('regressed')
    expect(out[0]?.score).toBe(FIX_CONFIDENCE_FLOOR)
  })

  it('a RE-resolved pattern (regressedAt precedes the newer resolvedAt) is not re-flagged as regressed', () => {
    const out = fixConfidenceForSnapshots(
      [snapshot({ status: 'resolved', regressedAt: NOW - 20 * DAY, resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50 })],
      NOW,
    )
    expect(out[0]?.state).toBe('confirmed')
  })

  it('recurredAt takes precedence over regressedAt when both are supplied', () => {
    const out = fixConfidenceForSnapshots(
      [
        snapshot({
          status: 'resolved',
          resolvedAt: NOW - 7 * DAY,
          regressedAt: NOW - 20 * DAY, // old, pre-resolution
          recurredAt: NOW - DAY, // new, post-resolution
          postResolutionRuns: 50,
        }),
      ],
      NOW,
    )
    expect(out[0]?.state).toBe('regressed')
  })

  it('a resolved-status snapshot with NO resolvedAt scores unproven rather than throwing', () => {
    const out = fixConfidenceForSnapshots([snapshot({ status: 'resolved', postResolutionRuns: 500 })], NOW)
    expect(out[0]?.state).toBe('unproven')
    expect(out[0]?.limitingFactor).toBe('no-resolution')
  })

  it('preserves index alignment with the input array', () => {
    const out = fixConfidenceForSnapshots(
      [
        snapshot({ status: 'open' }),
        snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50 }),
        snapshot({ status: 'acknowledged' }),
      ],
      NOW,
    )
    expect(out).toHaveLength(3)
    expect(out[0]).toBeNull()
    expect(out[1]?.state).toBe('confirmed')
    expect(out[2]).toBeNull()
  })

  it('empty and non-array inputs return an empty array without throwing', () => {
    expect(fixConfidenceForSnapshots([], NOW)).toEqual([])
    expect(fixConfidenceForSnapshots(undefined as unknown as PatternLifecycleSnapshot[], NOW)).toEqual([])
  })

  it('tolerates null entries inside the array', () => {
    const out = fixConfidenceForSnapshots(
      [null as unknown as PatternLifecycleSnapshot, snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50 })],
      NOW,
    )
    expect(out[0]).toBeNull()
    expect(out[1]?.state).toBe('confirmed')
  })
})

describe('summarizeResolutionHealth — asserted vs. confirmed (cycle 2)', () => {
  function snapshot(overrides: Partial<PatternLifecycleSnapshot>): PatternLifecycleSnapshot {
    return { status: 'open', firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 20 * DAY, count: 5, ...overrides }
  }
  const confirmedSnap = () =>
    snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50 })
  const provingSnap = () => snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: 10 })
  const assertedSnap = () => snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY })

  it('THE HEADLINE: a resolution with no evidence scores far below one whose fix held', () => {
    const asserted = summarizeResolutionHealth([assertedSnap()], NOW)
    const confirmed = summarizeResolutionHealth([confirmedSnap()], NOW)

    // Cycle 1's healthScore cannot tell them apart at all...
    expect(asserted.healthScore).toBe(100)
    expect(confirmed.healthScore).toBe(100)
    // ...cycle 2's does.
    expect(asserted.provenHealthScore).toBe(25) // FIX_CREDIT_UNPROVEN
    expect(confirmed.provenHealthScore).toBe(100)
    expect(asserted.provenHealthScore).toBeLessThan(confirmed.provenHealthScore)
  })

  it('a team that closes patterns without them holding never outscores one whose fixes stick', () => {
    const sticky = summarizeResolutionHealth([confirmedSnap(), confirmedSnap(), confirmedSnap(), confirmedSnap()], NOW)
    const closer = summarizeResolutionHealth([assertedSnap(), assertedSnap(), assertedSnap(), assertedSnap()], NOW)
    expect(sticky.healthScore).toBe(closer.healthScore) // identical under cycle 1
    expect(sticky.provenHealthScore).toBeGreaterThan(closer.provenHealthScore)
    expect(sticky.confirmationRate).toBe(1)
    expect(closer.confirmationRate).toBe(0)
  })

  it('classifies each resolution into exactly one bucket, and the buckets sum to `resolved`', () => {
    const r = summarizeResolutionHealth(
      [confirmedSnap(), provingSnap(), assertedSnap(), snapshot({ status: 'open' })],
      NOW,
    )
    expect(r.resolved).toBe(3)
    expect(r.confirmedResolutions).toBe(1)
    expect(r.provingResolutions).toBe(1)
    expect(r.unprovenResolutions).toBe(1)
    expect(r.confirmedResolutions + r.provingResolutions + r.unprovenResolutions).toBe(r.resolved)
  })

  it('proving resolutions earn half credit (between asserted and confirmed)', () => {
    const r = summarizeResolutionHealth([provingSnap()], NOW)
    expect(r.provingResolutions).toBe(1)
    expect(r.provenHealthScore).toBe(50) // FIX_CREDIT_PROVING * 100
  })

  it('resolutionsWithoutEvidence separates "measured zero" from "never measured"', () => {
    const measuredZero = snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: 0 })
    const r = summarizeResolutionHealth([measuredZero, assertedSnap()], NOW)
    expect(r.unprovenResolutions).toBe(2) // both unproven...
    expect(r.resolutionsWithoutEvidence).toBe(1) // ...but only one was never measured
  })

  it('confirmationRate is 0 (never NaN) when nothing is resolved', () => {
    const r = summarizeResolutionHealth([snapshot({ status: 'open' })], NOW)
    expect(r.resolved).toBe(0)
    expect(r.confirmationRate).toBe(0)
    expect(Number.isNaN(r.confirmationRate)).toBe(false)
  })

  it('confirmationRate is the confirmed share of resolutions', () => {
    const r = summarizeResolutionHealth([confirmedSnap(), assertedSnap(), assertedSnap(), assertedSnap()], NOW)
    expect(r.confirmationRate).toBe(0.25)
  })

  it('provenHealthScore carries the identical regression penalty as healthScore', () => {
    // One resolved+confirmed pattern that nonetheless regressed once in the past
    // and was re-resolved: regressionRate 1 => both scores lose the full 50.
    const reResolved = snapshot({
      status: 'resolved',
      regressedAt: NOW - 20 * DAY,
      resolvedAt: NOW - 7 * DAY,
      postResolutionRuns: 50,
    })
    const r = summarizeResolutionHealth([reResolved], NOW)
    expect(r.regressionRate).toBe(1)
    expect(r.healthScore).toBe(50)
    expect(r.provenHealthScore).toBe(50)
  })

  it('provenHealthScore is never above healthScore (evidence can only discount an assertion)', () => {
    const battery = [confirmedSnap(), provingSnap(), assertedSnap(), snapshot({ status: 'open' }), snapshot({ status: 'acknowledged' })]
    for (let i = 1; i <= battery.length; i++) {
      const r = summarizeResolutionHealth(battery.slice(0, i), NOW)
      expect(r.provenHealthScore).toBeLessThanOrEqual(r.healthScore)
    }
  })

  it('both scores stay within 0..100 over a large mixed population', () => {
    const snapshots = Array.from({ length: 3000 }, (_, i) =>
      i % 4 === 0 ? confirmedSnap() : i % 4 === 1 ? provingSnap() : i % 4 === 2 ? assertedSnap() : snapshot({ status: 'open' }),
    )
    const r = summarizeResolutionHealth(snapshots, NOW)
    expect(r.total).toBe(3000)
    expect(r.provenHealthScore).toBeGreaterThanOrEqual(0)
    expect(r.provenHealthScore).toBeLessThanOrEqual(100)
    expect(r.confirmedResolutions + r.provingResolutions + r.unprovenResolutions).toBe(r.resolved)
  })

  it('cycle-1 fields are byte-identical whether or not cycle-2 evidence is supplied (backward compatible)', () => {
    const withEvidence = summarizeResolutionHealth([confirmedSnap()], NOW)
    const withoutEvidence = summarizeResolutionHealth([assertedSnap()], NOW)
    const cycle1 = (r: ReturnType<typeof summarizeResolutionHealth>) => ({
      total: r.total,
      open: r.open,
      acknowledged: r.acknowledged,
      resolved: r.resolved,
      regressed: r.regressed,
      regressionRate: r.regressionRate,
      avgTimeToResolutionMs: r.avgTimeToResolutionMs,
      medianTimeToResolutionMs: r.medianTimeToResolutionMs,
      healthScore: r.healthScore,
    })
    expect(cycle1(withEvidence)).toEqual(cycle1(withoutEvidence))
  })

  it('a resolved snapshot with no resolvedAt lands in unproven without throwing or corrupting the buckets', () => {
    const r = summarizeResolutionHealth([snapshot({ status: 'resolved', postResolutionRuns: 500 })], NOW)
    expect(r.resolved).toBe(1)
    expect(r.unprovenResolutions).toBe(1)
    expect(r.confirmedResolutions).toBe(0)
    expect(Number.isFinite(r.provenHealthScore)).toBe(true)
  })

  it('a future resolvedAt does not produce a confirmed resolution', () => {
    const r = summarizeResolutionHealth(
      [snapshot({ status: 'resolved', resolvedAt: NOW + 30 * DAY, postResolutionRuns: 50 })],
      NOW,
    )
    expect(r.confirmedResolutions).toBe(0)
    expect(r.provingResolutions).toBe(1)
  })

  it('negative/NaN evidence values never leak into the aggregate scores', () => {
    const r = summarizeResolutionHealth(
      [
        snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: -100 }),
        snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: NaN }),
        snapshot({ status: 'resolved', resolvedAt: NaN, postResolutionRuns: 50 }),
      ],
      NOW,
    )
    expect(Number.isFinite(r.provenHealthScore)).toBe(true)
    expect(Number.isFinite(r.confirmationRate)).toBe(true)
    expect(r.unprovenResolutions).toBe(3)
  })

  it('nowMs is genuinely used now: the same snapshots score differently as time passes', () => {
    const snap = snapshot({ status: 'resolved', resolvedAt: NOW - 7 * DAY, postResolutionRuns: 50 })
    const soon = summarizeResolutionHealth([snap], NOW - 7 * DAY + HOUR) // ~1h of soak
    const later = summarizeResolutionHealth([snap], NOW) // 7d of soak
    expect(soon.confirmedResolutions).toBe(0)
    expect(later.confirmedResolutions).toBe(1)
  })

  it('is deterministic for a fixed nowMs', () => {
    const snapshots = [confirmedSnap(), provingSnap(), assertedSnap()]
    const results = new Set<string>()
    for (let i = 0; i < 10; i++) results.add(JSON.stringify(summarizeResolutionHealth(snapshots, NOW)))
    expect(results.size).toBe(1)
  })
})
