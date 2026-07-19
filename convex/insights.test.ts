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
