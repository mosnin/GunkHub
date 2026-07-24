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
})
