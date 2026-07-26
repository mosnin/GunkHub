/* eslint-disable */
/**
 * FLEET HEALTH & CROSS-AGENT CORRELATION — Convex surface verification
 * (convex-test harness, real functions against the real schema).
 *
 * The pure engine is verified in convex/helpers/fleet.test.ts. These tests
 * verify what only the real query can be wrong about:
 *
 *  (A) CROSS-ORG ISOLATION IS INDISTINGUISHABLE FROM ABSENCE. Following
 *      convex/tenancy_oracle.test.ts, outcomes are captured as {ok, value} or
 *      {ok, error} and compared with toEqual, so a version that merely throws
 *      DIFFERENT errors for "foreign" vs "missing" still FAILS. Org B's burst
 *      must be invisible to org A — not merely un-cited, but absent from every
 *      count, every roster row, and every base-rate denominator.
 *
 *  (B) THE HONESTY PROPERTIES SURVIVE THE PLUMBING, and the report the real
 *      query returns satisfies the CONTRACT'S OWN validators
 *      (`fleetReportIncoherences`, `orphanHypotheses`, `fleetHealthReportVerdict`).
 *
 *  (C) THE FEATURE READS ZERO EVENTS. Asserted directly: a fleet-wide incident
 *      is fully detected in a database whose `events` table is EMPTY.
 */
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'

import {
  fleetHealthReportVerdict,
  fleetReportIncoherences,
  isFleetHealthScanComplete,
  orphanHypotheses,
} from '@agent-flight-recorder/contracts'

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

const asA = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
const asB = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'user_b', org_id: 'clerk_b' })

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

interface SeedOptions {
  agents?: number
  burstAgents?: number
  baselineRunVolume?: number
  model?: string
}

/**
 * Seeds TWO orgs with STRUCTURALLY IDENTICAL fleets and identical bursts.
 *
 * Identical on purpose: if org A's report ever leaked org B's rows, the counts
 * would DOUBLE rather than change shape, which a test using differently-shaped
 * orgs could easily miss.
 */
async function seed(t: ReturnType<typeof convexTest>, opts: SeedOptions = {}) {
  const agentCount = opts.agents ?? 6
  const burstAgents = opts.burstAgents ?? 5
  const model = opts.model ?? 'gpt-4o'
  const fp = 'FP_SHARED'

  return await t.run(async (ctx) => {
    const now = Date.now()
    const windowStart = now - 12 * HOUR
    const burstAt = now - 6 * HOUR
    const baselineStart = now - 24 * HOUR - 7 * DAY
    const out: Record<string, any> = { now, burstAt, fp }

    for (const tag of ['a', 'b'] as const) {
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: `clerk_${tag}`, name: tag.toUpperCase(), slug: tag, plan: 'free', createdAt: now, updatedAt: now,
      })
      await ctx.db.insert('user_memberships', { clerkUserId: `user_${tag}`, orgId, role: 'member', joinedAt: now })
      const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: now, updatedAt: now })

      const agentIds: any[] = []
      const versionIds: any[] = []
      for (let i = 0; i < agentCount; i++) {
        const agentId = await ctx.db.insert('agents', {
          orgId, projectId, name: `${tag}-agent-${i}`, slug: `${tag}-agent-${i}`, createdAt: now, updatedAt: now,
        })
        agentIds.push(agentId)
        // The burst agents declare the shared model; the rest do not. Everyone
        // declares the same tool, so the tool hypothesis must come back
        // NOT DISCRIMINATING while the model one is DISCRIMINATING.
        versionIds.push(
          await ctx.db.insert('agent_versions', {
            agentId, orgId, version: '1.0.0', createdAt: now,
            configSnapshot: {
              model: i < burstAgents ? model : 'other-model',
              tools: [{ name: 'search_web' }],
              capabilities: ['vector_store'],
            },
          }),
        )
      }

      const runIds: any[] = []
      for (let i = 0; i < agentCount; i++) {
        runIds.push(
          await ctx.db.insert('runs', {
            orgId, projectId, agentId: agentIds[i], agentVersionId: versionIds[i],
            status: i < burstAgents ? 'failed' : 'completed',
            startedAt: windowStart + i * MIN, metadata: {}, tags: [],
          }),
        )
      }

      // THE BURST: `burstAgents` distinct agents record the same fingerprint
      // within 20 minutes.
      for (let i = 0; i < burstAgents; i++) {
        await ctx.db.insert('failure_pattern_occurrences', {
          orgId, fingerprintHash: fp, runId: runIds[i], agentId: agentIds[i],
          occurredAt: burstAt + i * 4 * MIN, heuristicClass: 'tool_error', salientKey: fp,
        })
      }

      await ctx.db.insert('failure_patterns', {
        orgId, fingerprintHash: fp, class: 'tool_error', label: 'upstream 503', salientKey: fp,
        count: burstAgents, firstSeenAt: burstAt, lastSeenAt: burstAt + burstAgents * 4 * MIN,
        representativeRunIds: [runIds[0]], affectedAgentVersionIds: [],
      })

      // Baseline occurrences: one agent at a time, days apart. A quiet baseline.
      for (const [agentIdx, offset] of [[0, 1 * DAY], [1, 3 * DAY], [2, 5 * DAY]] as const) {
        await ctx.db.insert('failure_pattern_occurrences', {
          orgId, fingerprintHash: fp, runId: runIds[agentIdx], agentId: agentIds[agentIdx],
          occurredAt: baselineStart + offset, heuristicClass: 'tool_error', salientKey: fp,
        })
      }

      // Baseline run volume, so `isBaselineEstablished` has its positive clause.
      const volume = opts.baselineRunVolume ?? 500
      for (let d = 0; d < 7; d++) {
        await ctx.db.insert('daily_rollups', {
          orgId, agentId: agentIds[0], date: utcDay(baselineStart + d * DAY),
          runsTotal: volume, runsFailed: 1, runsCompleted: Math.max(0, volume - 1),
          runsCancelled: 0, runsTimedOut: 0, tokensIn: 0, tokensOut: 0,
        })
      }

      out[tag] = { orgId, agentIds, versionIds, runIds }
    }
    return out
  })
}

// ===========================================================================
// (A) TENANCY
// ===========================================================================

describe('A. cross-org isolation', () => {
  it('an unauthenticated caller gets nothing', async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const r = await outcome(() => t.query(api.fleet.fleetHealth, {}))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Unauthorized/)
  })

  it("org A's report contains ONLY org A's agents, occurrences and runs", async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const a = await asA(t).query(api.fleet.fleetHealth, {})
    const b = await asB(t).query(api.fleet.fleetHealth, {})

    const aAgentIds = new Set(s.a.agentIds.map(String))
    const bAgentIds = new Set(s.b.agentIds.map(String))

    expect(a.roster).toHaveLength(6)
    for (const row of a.roster) {
      expect(aAgentIds.has(row.agentId)).toBe(true)
      expect(bAgentIds.has(row.agentId)).toBe(false)
      expect(row.agentName!.startsWith('a-')).toBe(true)
    }
    for (const c of a.correlations) {
      for (const agentId of c.agentIds) expect(aAgentIds.has(agentId)).toBe(true)
      for (const cite of c.observedBy) expect(aAgentIds.has(cite.agentId)).toBe(true)
    }

    // Structurally identical orgs, so the counts must MATCH EXACTLY. A leak
    // would double them.
    expect(a.scan.agentsInRoster).toBe(6)
    expect(b.scan.agentsInRoster).toBe(6)
    expect(a.scan.occurrencesScanned).toBe(b.scan.occurrencesScanned)
    expect(a.agentsFailing).toBe(5)
    expect(a.correlations.length).toBe(b.correlations.length)
  })

  it('base-rate denominators never include the other org', async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const a = await asA(t).query(api.fleet.fleetHealth, {})
    const model = a.hypotheses.find((h: any) => h.kind === 'shared_model')!
    expect(model.sharedBy.affectedTotal).toBe(5)
    // ONE unaffected agent in this org — not two across both.
    expect(model.sharedBy.unaffectedTotal).toBe(1)
    expect(model.sharedBy.unaffectedSharing).toBe(0)
  })

  it("fleetPatternReach: another org's fingerprint is INDISTINGUISHABLE from one that never existed", async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const foreign = await outcome(() =>
      asA(t).query(api.fleet.fleetPatternReach, { fingerprintHash: 'FP_ONLY_IN_ANOTHER_ORG' }),
    )
    const nonexistent = await outcome(() =>
      asA(t).query(api.fleet.fleetPatternReach, { fingerprintHash: 'FP_NEVER_EXISTED_ANYWHERE' }),
    )
    expect(foreign.ok).toBe(true)
    const strip = (v: any) => ({ ...v, analyzedAt: 0, fingerprintHash: '', window: null })
    expect(strip(foreign.value)).toEqual(strip(nonexistent.value))
    expect(foreign.value.found).toBe(false)
    expect(foreign.value.agents).toEqual([])
  })

  it("fleetPatternReach on an OWNED hash returns only this org's agents", async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const reach = await asA(t).query(api.fleet.fleetPatternReach, {
      fingerprintHash: 'FP_SHARED', since: s.now - 12 * HOUR, until: s.now,
    })
    expect(reach.found).toBe(true)
    expect(reach.distinctAgentCount).toBe(5)
    const aAgentIds = new Set(s.a.agentIds.map(String))
    for (const ag of reach.agents) {
      expect(aAgentIds.has(ag.agentId)).toBe(true)
      expect(ag.name).toMatch(/^a-agent-/)
    }
  })
})

// ===========================================================================
// (B) THE FEATURE, END TO END
// ===========================================================================

describe('B. fleet detection through the real query', () => {
  it('detects the burst, files the shared model as a HYPOTHESIS, and satisfies the CONTRACT validators', async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const r = await asA(t).query(api.fleet.fleetHealth, {})

    expect(r.verdict).toBe('correlated_failures')
    expect(r.scan.correlationBasis).toBe('whole_roster')

    const shared = r.correlations.find((c: any) => c.kind === 'shared_failure_fingerprint')!
    expect(shared.agentCount).toBe(5)
    const burst = r.correlations.find((c: any) => c.kind === 'temporal_burst')!
    expect(burst.agentCount).toBe(5)
    expect(burst.observedFact).toMatch(/the peak over any equal window was 1/)

    // The model is a HYPOTHESIS: different array, different shape, carrying its
    // denominator and the observations it rests on.
    const model = r.hypotheses.find((h: any) => h.kind === 'shared_model')!
    expect(model.certainty).toBe('hypothesis')
    expect(model.sharedValue).toBe('gpt-4o')
    expect(model.restingOn.length).toBeGreaterThan(0)
    expect(model).not.toHaveProperty('candidateExplanation')

    // THE CONTRACT'S OWN VALIDATORS, over the real query's real output.
    expect(fleetReportIncoherences(r as any)).toEqual([])
    expect(orphanHypotheses(r as any)).toEqual([])
    expect(r.verdict).toBe(fleetHealthReportVerdict(r as any))

    expect(r.roster.slice(0, 5).every((a: any) => a.state === 'failing')).toBe(true)
    expect(r.roster[5].state).toBe('healthy')
  })

  it('READS ZERO EVENTS: the events table is empty and the incident is still fully detected', async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const eventCount = await t.run(async (ctx) => (await ctx.db.query('events').collect()).length)
    expect(eventCount).toBe(0)

    const r = await asA(t).query(api.fleet.fleetHealth, {})
    expect(r.verdict).toBe('correlated_failures')
    expect(r.correlations.find((c: any) => c.kind === 'temporal_burst')!.agentCount).toBe(5)
  })

  it('a fleet that ran and did not fail is `healthy` — the engine is not merely pessimistic', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const now = Date.now()
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_a', name: 'A', slug: 'a', plan: 'free', createdAt: now, updatedAt: now,
      })
      await ctx.db.insert('user_memberships', { clerkUserId: 'user_a', orgId, role: 'member', joinedAt: now })
      const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      for (let i = 0; i < 3; i++) {
        const agentId = await ctx.db.insert('agents', {
          orgId, projectId, name: `a${i}`, slug: `a${i}`, createdAt: now, updatedAt: now,
        })
        await ctx.db.insert('runs', {
          orgId, projectId, agentId, status: 'completed', startedAt: now - HOUR, metadata: {}, tags: [],
        })
      }
    })
    const r = await asA(t).query(api.fleet.fleetHealth, {})
    expect(r.verdict).toBe('healthy')
    expect(r.roster.every((a: any) => a.state === 'healthy')).toBe(true)
    expect(isFleetHealthScanComplete(r.scan)).toBe(true)
  })

  it('AN EMPTY ORG IS INDETERMINATE, NEVER HEALTHY', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      const now = Date.now()
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_a', name: 'A', slug: 'a', plan: 'free', createdAt: now, updatedAt: now,
      })
      await ctx.db.insert('user_memberships', { clerkUserId: 'user_a', orgId, role: 'member', joinedAt: now })
    })
    const r = await asA(t).query(api.fleet.fleetHealth, {})
    expect(r.verdict).toBe('indeterminate')
    expect(r.roster).toHaveLength(0)
    expect(r.scan.agentsAssessed).toBe(0)
    // Nothing was truncated — because nothing was read. That must not read clean.
    expect(r.scan.scanTruncated).toBe(false)
    expect(isFleetHealthScanComplete(r.scan)).toBe(false)
  })

  it('agents that ran NOTHING in the window are `unobserved`, never healthy', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await asA(t).query(api.fleet.fleetHealth, { since: s.now - 60 * DAY, until: s.now - 50 * DAY })
    expect(r.roster.every((a: any) => a.state === 'unobserved')).toBe(true)
    expect(r.roster.some((a: any) => a.state === 'healthy')).toBe(false)
  })

  it('since/until/burstWindowMs are echoed EXACTLY for ignored-parameter detection', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const since = s.now - 8 * HOUR
    const r = await asA(t).query(api.fleet.fleetHealth, { since, until: s.now, burstWindowMs: 7 * MIN })
    expect(r.scan.since).toBe(since)
    expect(r.scan.until).toBe(s.now)
    // A deployment that dropped the parameter would echo its own default here.
    expect(r.scan.burstWindowMs).toBe(7 * MIN)
  })

  it('rejects an inverted window rather than silently returning nothing', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const r = await outcome(() => asA(t).query(api.fleet.fleetHealth, { since: s.now, until: s.now - HOUR }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/INVALID_ARGUMENT/)
  })
})

// ===========================================================================
// (C) TRUNCATION AND BASELINE HONESTY
// ===========================================================================

describe('C. truncation honesty', () => {
  it('the ROSTER LISTING limit never splits a cluster and never undercounts agentsFailing', async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const r = await asA(t).query(api.fleet.fleetHealth, { limit: 2 })

    expect(r.roster).toHaveLength(2)
    // The correlation pass still saw the whole fleet — this is the property
    // that a paged correlation would destroy.
    expect(r.scan.correlationBasis).toBe('whole_roster')
    expect(r.correlations.find((c: any) => c.kind === 'temporal_burst')!.agentCount).toBe(5)
    // Counted over ALL assessed agents, not the 2-row listing.
    expect(r.agentsFailing).toBe(5)
    expect(r.scan.agentsAssessed).toBe(6)
    // A partial listing is still an incomplete answer.
    expect(r.scan.nextCursor).toBeDefined()
    expect(isFleetHealthScanComplete(r.scan)).toBe(false)
    expect(r.unanswered.some((u: any) => u.questionKey === 'roster_listing_truncated')).toBe(true)
  })

  it('THE TRAP: with no baseline run volume, the burst is reported but NOT called abnormal', async () => {
    const t = convexTest(schema, modules)
    // daily_rollups say the fleet ran nothing during the baseline. A period in
    // which nothing ran cannot establish what normal looks like.
    await seed(t, { baselineRunVolume: 0 })
    const r = await asA(t).query(api.fleet.fleetHealth, {})

    const burst = r.correlations.find((c: any) => c.kind === 'temporal_burst')!
    expect(burst.agentCount).toBe(5)
    // The burst is reported in full; the "versus normal" sentence is ABSENT.
    expect(burst.observedFact).not.toMatch(/baseline/)
    expect(burst.observedFact).not.toMatch(/peak over any equal window/)

    const q = r.unanswered.find((u: any) => u.questionKey === 'baseline_not_established')!
    expect(q).toBeDefined()
    expect(q.undecidedQuestion).toMatch(/abnormal/)
    expect(fleetReportIncoherences(r as any)).toEqual([])
  })

  it('baselineDays: 0 means there is no baseline PERIOD, reported as absent', async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const r = await asA(t).query(api.fleet.fleetHealth, { baselineDays: 0 })
    const q = r.unanswered.find((u: any) => u.questionKey === 'baseline_not_established')!
    expect(q.unknownBecause).toMatch(/no baseline period precedes/)
    expect(r.correlations.find((c: any) => c.kind === 'temporal_burst')!.observedFact).not.toMatch(/baseline/)
  })

  it('the scan reports agent counts and basis in their own fields', async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    const r = await asA(t).query(api.fleet.fleetHealth, {})
    expect(r.scan.agentsInRoster).toBe(6)
    expect(r.scan.agentsAssessed).toBe(6)
    expect(r.scan.agentsUnassessable).toBe(0)
    expect(r.scan.agentsSkippedForBudget).toBe(0)
    expect(r.scan.occurrencesScanned).toBe(5)
    expect(r.scan.baseRatesMeasured).toBe(true)
    expect(r.scan.correlationBasis).toBe('whole_roster')
  })
})
