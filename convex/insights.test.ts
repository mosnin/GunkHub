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
