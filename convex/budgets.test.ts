/* eslint-disable */
/**
 * BUDGET CIRCUIT BREAKERS — Convex surface verification (convex-test harness,
 * real functions against the real schema).
 *
 * Team D reported it could not exercise these surfaces from its own boundary
 * (no `convex-test` there) and named TWO GAPS as the biggest in its report:
 * a tenancy oracle on the budget surface, and audit coverage of every trip
 * path. Both are the subject of sections (3) and (2) below, and both are
 * verified by EXECUTION rather than by inspection.
 *
 *  (1) THE ACCOUNTING SUBSTRATE. `usage_counters` is never read; the cost and
 *      events_ingested meters are refused rather than approximated; the run
 *      counter proves a breach and never headroom; a run-scoped budget is
 *      RECONCILED from the event log and can do both.
 *  (2) EVERY TRIP PATH IS AUDITED, and automatic is distinguishable from human.
 *  (3) THE TENANCY ORACLE. Every by-id surface is probed with a foreign id and
 *      a deleted id, and the two OUTCOMES are compared with toEqual — a version
 *      that merely throws DIFFERENT errors FAILS.
 *  (4) A PERIOD ROLL CANNOT CORRUPT THE APPEND-ONLY LOG.
 *  (5) THE SNAPSHOT SATISFIES THE CONTRACT'S OWN VALIDATORS.
 */
import {
  isBreakerSnapshotComplete,
  snapshotClaimContradictions,
  snapshotUnusableFields,
  spendUsability,
} from '@agent-flight-recorder/contracts'
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const adminA = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'admin_a', org_id: 'clerk_a' })
const memberA = (t: ReturnType<typeof convexTest>) => t.withIdentity({ subject: 'member_a', org_id: 'clerk_a' })

/**
 * Two STRUCTURALLY IDENTICAL orgs. Identical on purpose: if org A's evaluation
 * ever summed org B's runs the totals would DOUBLE rather than change shape,
 * which a test using differently-shaped orgs could easily miss.
 *
 * Each org: one agent, three runs of 400 recorded tokens (300 in / 100 out),
 * plus one run with NO recorded tokens — the "unmeasured, not zero" case — and
 * one run carrying real `llm.response` events for the reconciled path.
 */
async function seed(t: ReturnType<typeof convexTest>, now: number) {
  return await t.run(async (ctx) => {
    const out: Record<string, any> = {}
    for (const tag of ['a', 'b'] as const) {
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: `clerk_${tag}`, name: tag.toUpperCase(), slug: tag, plan: 'free', createdAt: now, updatedAt: now,
      })
      await ctx.db.insert('user_memberships', { clerkUserId: `admin_${tag}`, orgId, role: 'admin', joinedAt: now })
      await ctx.db.insert('user_memberships', { clerkUserId: `member_${tag}`, orgId, role: 'member', joinedAt: now })
      const projectId = await ctx.db.insert('projects', { orgId, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agentId = await ctx.db.insert('agents', {
        orgId, projectId, name: `${tag}-agent`, slug: `${tag}-agent`, createdAt: now, updatedAt: now,
      })

      const runIds: any[] = []
      for (let i = 0; i < 3; i++) {
        runIds.push(await ctx.db.insert('runs', {
          orgId, projectId, agentId, status: 'completed',
          startedAt: now - 3 * HOUR + i * MIN, metadata: {}, tags: [],
          tokensIn: 300, tokensOut: 100,
        }))
      }
      // Spend that was never recorded. NOT a run that spent zero.
      runIds.push(await ctx.db.insert('runs', {
        orgId, projectId, agentId, status: 'completed',
        startedAt: now - 3 * HOUR + 10 * MIN, metadata: {}, tags: [],
      }))

      // A run with REAL llm.response events, for the reconciled path. Its run
      // counters are deliberately ABSENT so a reconciled figure can only have
      // come from the log.
      const loggedRunId = await ctx.db.insert('runs', {
        orgId, projectId, agentId, status: 'completed',
        startedAt: now - 2 * HOUR, metadata: {}, tags: [],
      })
      await ctx.db.insert('events', {
        runId: loggedRunId, orgId, type: 'run.started', sequenceNumber: 1,
        timestamp: now - 2 * HOUR, payload: { type: 'run.started' },
      })
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('events', {
          runId: loggedRunId, orgId, type: 'llm.response', sequenceNumber: 2 + i,
          timestamp: now - 2 * HOUR + i, payload: { usage: { input_tokens: 50, output_tokens: 20 } },
        })
      }
      runIds.push(loggedRunId)

      for (const runId of runIds.slice(0, 4)) {
        await ctx.db.insert('events', {
          runId, orgId, type: 'run.started', sequenceNumber: 1,
          timestamp: now - 3 * HOUR, payload: { type: 'run.started' },
        })
      }

      // AN ABSURDLY WRONG usage_counters ROW. If anything in this feature ever
      // reads the Morris-sampled counter, these numbers make it impossible to
      // miss. See (1).
      await ctx.db.insert('usage_counters', {
        orgId, day: new Date(now).toISOString().slice(0, 10),
        runsStarted: 999_999, eventsIngested: 999_999,
        bytesIngested: 999_999_999, artifactBytes: 999_999_999,
      })

      // A daily_rollup for YESTERDAY with absurd totals — the other tempting
      // wrong substrate, and the one that cannot see today at all.
      await ctx.db.insert('daily_rollups', {
        orgId, agentId, date: new Date(now - DAY).toISOString().slice(0, 10),
        runsTotal: 999_999, runsFailed: 0, runsCompleted: 999_999,
        runsCancelled: 0, runsTimedOut: 0, tokensIn: 999_999_999, tokensOut: 999_999_999,
      })

      out[tag] = { orgId, projectId, agentId, runIds, loggedRunId }
    }
    return out
  })
}

async function insertBudget(t: ReturnType<typeof convexTest>, fields: Record<string, any>) {
  return await t.run(async (ctx) =>
    ctx.db.insert('budget_breakers', {
      scope: 'agent', meter: 'tokens_in', period: 'day',
      name: 'cap', enabled: true, limitAmount: 1000,
      rearmOnPeriodRoll: false, createdBy: 'admin_a',
      ...fields,
    } as any),
  )
}

// ===========================================================================
// (1) THE ACCOUNTING SUBSTRATE
// ===========================================================================

describe('(1) what this backend will and will not put a limit on', () => {
  it('sums runs.tokensIn/tokensOut, untouched by usage_counters or daily_rollups', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'lifetime', limitAmount: 1_000_000, createdAt: now - DAY,
    })
    const snap: any = await adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, agentId: s.a.agentId,
    })
    const state = snap.states[0]
    // 3 runs x 300 tokensIn = 900. NOT 999,999-anything.
    expect(snap.states).toHaveLength(1)
    expect(state.state).toBe('undetermined')
    expect(state.undeterminedBecause).toMatch(/is 900 tokens_in/)
  })

  it('never imports or reads the sampled counter or the rollups', async () => {
    // Structural: an import and a table read are what would actually make the
    // wrong substrate load-bearing. NOT a blanket string ban — these files name
    // usage_counters and daily_rollups repeatedly, in prose, to explain why they
    // are not read.
    const fs = await import('node:fs/promises')
    for (const file of ['budgets.ts', 'budget_gate.ts', 'helpers/budget.ts']) {
      const src = await fs.readFile(new URL(`./${file}`, import.meta.url), 'utf8')
      expect(src).not.toMatch(/from ["'][^"']*usage\.js["']/)
      expect(src).not.toMatch(/from ["'][^"']*pricing\.js["']/)
      expect(src).not.toMatch(/from ["'][^"']*rollups\.js["']/)
      expect(src).not.toMatch(/incrementUsageCounters\s*\(/)
      expect(src).not.toMatch(/(estimateCostUsd|resolveModelPricing)\s*\(/)
      expect(src).not.toMatch(/(dayBoundsUtc|currentUsageDay|yesterdayUtc)\s*\(/)
      expect(src).not.toMatch(/query\(\s*["'](usage_counters|daily_rollups)["']/)
    }
  })

  it('REFUSES a cost budget rather than pricing it', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'cost_minor_units',
      currency: 'USD', period: 'day', limitAmount: 100, createdAt: now - DAY,
    })
    const snap: any = await adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, agentId: s.a.agentId,
    })
    const state = snap.states[0]
    expect(state.state).toBe('undetermined')
    expect(state.kind).toBe('budget_unreadable')
    expect(state.undeterminedBecause).toMatch(/bidirectional substring/i)
    // It never emits a number for a meter it cannot measure.
    expect(JSON.stringify(state)).not.toMatch(/estimatedAmount|reconciledAmount/)
  })

  it('a counter-backed budget TRIPS when recorded spend crosses, and never arms below', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const tight = await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'lifetime', limitAmount: 500, createdAt: now - DAY,
    })
    const snap: any = await adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, agentId: s.a.agentId,
    })
    expect(snap.states[0].state).toBe('tripped')
    expect(snap.states[0].trippedBudgetId).toBe(tight)
    const figure = snap.states[0].determinedFrom[0]
    expect(figure.basis).toBe('approximate')
    expect(figure.kind).toBe('denormalised_run_counter')
    expect(figure.couldOverstateBy).toBe(0)
    expect(figure.couldUnderstateBy).toBeNull()
    expect(spendUsability(figure)).toBe('usable')
  })

  it('a RUN-scoped budget is RECONCILED from the event log and CAN arm', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await insertBudget(t, {
      orgId: s.a.orgId, scope: 'run', scopeId: s.a.loggedRunId,
      meter: 'tokens_in', period: 'run', limitAmount: 1000, createdAt: now - DAY,
    })
    const snap: any = await adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, runId: s.a.loggedRunId,
    })
    const state = snap.states[0]
    // THE NARROW EXACT PATH: this is the only band that can establish headroom.
    expect(state.state).toBe('armed')
    const figure = state.establishedUnderBy[0]
    expect(figure.basis).toBe('reconciled')
    expect(figure.establishedBy[0].logReadComplete).toBe(true)
    expect(figure.establishedBy[0].proves).toBe('event_log_summed')
    // 3 llm.response events x 50 input tokens, summed FROM THE LOG. The run's
    // own tokensIn counter is absent, so this can only have come from events.
    expect(figure.reconciledAmount).toBe(150)
  })

  it('and a run-scoped budget also trips, provably', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await insertBudget(t, {
      orgId: s.a.orgId, scope: 'run', scopeId: s.a.loggedRunId,
      meter: 'tokens_in', period: 'run', limitAmount: 100, createdAt: now - DAY,
    })
    const snap: any = await adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, runId: s.a.loggedRunId,
    })
    expect(snap.states[0].state).toBe('tripped')
    expect(snap.states[0].determinedFrom[0].basis).toBe('reconciled')
  })

  it('a limit of zero is refused at creation, not tripped on an empty window', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const r = await outcome(() =>
      adminA(t).mutation(api.budgets.createBudget, {
        orgId: s.a.orgId, name: 'zero', scope: 'agent', scopeId: s.a.agentId,
        meter: 'tokens_in', period: 'day', limitAmount: 0,
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/breached by an empty window/i)
  })
})

// ===========================================================================
// (2) EVERY TRIP PATH IS AUDITED  — Team D gap #2
// ===========================================================================

describe('(2) audit coverage of every trip path', () => {
  it('the AUTOMATIC trip writes budget.auto_tripped under the system actor', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'lifetime', limitAmount: 500, createdAt: now - DAY,
    })
    const r: any = await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now })
    expect(r.state.state).toBe('tripped')

    const rows: any = await adminA(t).query(api.audit.listAuditLog, { orgId: s.a.orgId })
    const trip = rows.entries.find((e: any) => e.action === 'budget.auto_tripped')
    expect(trip).toBeTruthy()
    expect(trip.actorClerkUserId).toBe('system')
    expect(trip.targetId).toBe(budgetId)
    // The audit row carries its own epistemics, so a reader six months later
    // does not have to know which kind of figure this was.
    expect(trip.metadata.spendBasis).toBe('approximate')
    expect(trip.metadata.spendAmount).toBe(900)
    expect(trip.metadata.couldOverstateBy).toBe(0)
    expect(trip.metadata.couldUnderstateBy).toBeNull()
    // The trip is PERSISTED, so it survives spend falling back under the limit.
    const doc: any = await t.run(async (ctx) => ctx.db.get(budgetId))
    expect(doc.trippedBy).toBe('limit_reached')
    expect(doc.trippedByUser).toBe('system')
  })

  it('re-running the sweep does not write a second trip row', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'lifetime', limitAmount: 500, createdAt: now - DAY,
    })
    await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now })
    await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now: now + MIN })
    const rows: any = await adminA(t).query(api.audit.listAuditLog, { orgId: s.a.orgId })
    expect(rows.entries.filter((e: any) => e.action === 'budget.auto_tripped')).toHaveLength(1)
  })

  it('the MANUAL trip writes budget.tripped under the operator, note verbatim', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId: any = await adminA(t).mutation(api.budgets.createBudget, {
      orgId: s.a.orgId, name: 'prod cap', scope: 'agent', scopeId: s.a.agentId,
      meter: 'tokens_in', period: 'day', limitAmount: 5000,
    })
    // Operator text is stored VERBATIM — including a claim WE are not allowed to
    // make. It is theirs, attributed to them, never laundered into ours.
    await adminA(t).mutation(api.budgets.tripBudget, { budgetId, reason: 'I stopped the agent by hand' })

    const doc: any = await adminA(t).query(api.budgets.getBudget, { budgetId })
    expect(doc.trippedBy).toBe('manual_trip')
    expect(doc.trippedByUser).toBe('admin_a')
    expect(doc.operatorNote).toBe('I stopped the agent by hand')
    // The SYSTEM's own account of the same transition claims nothing of the kind.
    expect(doc.trippedBecause).not.toMatch(/\bstopp?ed\b/i)

    const rows: any = await adminA(t).query(api.audit.listAuditLog, { orgId: s.a.orgId })
    const trip = rows.entries.find((e: any) => e.action === 'budget.tripped')
    expect(trip.actorClerkUserId).toBe('admin_a')
    expect(trip.metadata.operatorNote).toBe('I stopped the agent by hand')
    // A DIFFERENT action name from the automatic one, so the append-only log can
    // always answer "did a person decide, or did the numbers cross?".
    expect(rows.entries.some((e: any) => e.action === 'budget.auto_tripped')).toBe(false)
  })

  it('the PERIOD-ROLL re-arm is audited too, as a system reset', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    // A run-scoped budget, because only a reconciled figure can prove the
    // headroom that a re-arm requires.
    const budgetId = await insertBudget(t, {
      orgId: s.a.orgId, scope: 'run', scopeId: s.a.loggedRunId,
      meter: 'tokens_in', period: 'run', limitAmount: 1000,
      rearmOnPeriodRoll: true, createdAt: now - DAY,
      trippedAt: now - 10 * DAY, trippedBy: 'limit_reached',
      trippedBecause: 'An earlier evaluation recorded a breach.', trippedByUser: 'system',
    })
    const r: any = await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now })
    expect(r.state.state).toBe('armed')

    const rows: any = await adminA(t).query(api.audit.listAuditLog, { orgId: s.a.orgId })
    const reset = rows.entries.find((e: any) => e.action === 'budget.reset')
    expect(reset.actorClerkUserId).toBe('system')
    expect(reset.metadata.via).toBe('period_roll')
    expect(reset.metadata.previousTrippedAt).toBe(now - 10 * DAY)
  })

  it('create, update, operator-reset and delete are all audited', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId: any = await adminA(t).mutation(api.budgets.createBudget, {
      orgId: s.a.orgId, name: 'cap', scope: 'agent', scopeId: s.a.agentId,
      meter: 'tokens_in', period: 'day', limitAmount: 5000,
    })
    await adminA(t).mutation(api.budgets.updateBudget, { budgetId, limitAmount: 7000 })
    await adminA(t).mutation(api.budgets.resetBudget, { budgetId, reason: 'r' })
    await adminA(t).mutation(api.budgets.deleteBudget, { budgetId })

    const rows: any = await adminA(t).query(api.audit.listAuditLog, { orgId: s.a.orgId })
    expect(rows.entries.map((e: any) => e.action).sort()).toEqual([
      'budget.created', 'budget.deleted', 'budget.reset', 'budget.updated',
    ])
    // The audit trail OUTLIVES the deleted budget — deleting a tripped budget is
    // the obvious way to make a breaker stop withholding.
    expect(rows.entries.find((e: any) => e.action === 'budget.deleted').metadata.limitAmount).toBe(7000)
    expect(await t.run(async (ctx) => ctx.db.get(budgetId))).toBeNull()
  })

  it('an operator reset begins a new accounting period rather than re-tripping', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'lifetime', limitAmount: 500, createdAt: now - DAY,
    })
    await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now })
    expect((await adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, agentId: s.a.agentId }) as any).states[0].state).toBe('tripped')

    await adminA(t).mutation(api.budgets.resetBudget, { budgetId, reason: 'investigated' })
    // The window now starts at the reset, so the old spend is out of scope and
    // the breaker does NOT immediately re-trip.
    const after: any = await adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, agentId: s.a.agentId })
    expect(after.states[0].state).toBe('undetermined')

    const rows: any = await adminA(t).query(api.audit.listAuditLog, { orgId: s.a.orgId })
    const reset = rows.entries.find((e: any) => e.action === 'budget.reset' && e.metadata.via === 'operator')
    expect(reset.actorClerkUserId).toBe('admin_a')
    expect(reset.metadata.previousTrippedAt).toBeTruthy()
  })

  it('THE ASYMMETRY: a member may TRIP (safe direction) but not RESET (dangerous one)', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })

    // Everything that RESUMES spend, or reshapes the budget, is admin-only.
    for (const attempt of [
      () => memberA(t).mutation(api.budgets.createBudget, {
        orgId: s.a.orgId, name: 'x', scope: 'agent', scopeId: s.a.agentId,
        meter: 'tokens_in', period: 'day', limitAmount: 10,
      }),
      () => memberA(t).mutation(api.budgets.resetBudget, { budgetId, reason: 'r' }),
      () => memberA(t).mutation(api.budgets.updateBudget, { budgetId, limitAmount: 99 }),
      () => memberA(t).mutation(api.budgets.deleteBudget, { budgetId }),
    ]) {
      const r = await outcome(attempt as any)
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/admin/i)
    }

    // Pulling the cord is member-permitted: requiring an admin to be awake to
    // WITHHOLD is the wrong constraint during an incident. Still attributed.
    const tripped = await outcome(() => memberA(t).mutation(api.budgets.tripBudget, { budgetId, reason: 'paging on-call' }))
    expect(tripped.ok).toBe(true)
    const doc: any = await memberA(t).query(api.budgets.getBudget, { budgetId })
    expect(doc.trippedByUser).toBe('member_a')
    const rows: any = await adminA(t).query(api.audit.listAuditLog, { orgId: s.a.orgId })
    expect(rows.entries.find((e: any) => e.action === 'budget.tripped').actorClerkUserId).toBe('member_a')

    // ...and the member still cannot undo it.
    expect((await outcome(() => memberA(t).mutation(api.budgets.resetBudget, { budgetId, reason: 'r' }))).ok).toBe(false)
    expect((await outcome(() => memberA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId }))).ok).toBe(true)
  })

  it('a VIEWER may do neither', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await t.run(async (ctx) => {
      await ctx.db.insert('user_memberships', { clerkUserId: 'viewer_a', orgId: s.a.orgId, role: 'viewer', joinedAt: now })
    })
    const budgetId = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    const viewer = t.withIdentity({ subject: 'viewer_a', org_id: 'clerk_a' })
    expect((await outcome(() => viewer.mutation(api.budgets.tripBudget, { budgetId, reason: 'r' }))).ok).toBe(false)
    expect((await outcome(() => viewer.mutation(api.budgets.resetBudget, { budgetId, reason: 'r' }))).ok).toBe(false)
  })
})

// ===========================================================================
// (3) THE TENANCY ORACLE  — Team D gap #1
// ===========================================================================

describe('(3) tenancy: foreign is indistinguishable from missing, everywhere', () => {
  it("org A's evaluation never sums org B's runs", async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    // Both orgs hold identical data, so a leak DOUBLES the total to 1,800.
    for (const tag of ['a', 'b'] as const) {
      await insertBudget(t, {
        orgId: s[tag].orgId, scopeId: s[tag].agentId, meter: 'tokens_in',
        period: 'lifetime', limitAmount: 1_000_000, createdAt: now - DAY,
      })
    }
    const snap: any = await adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, agentId: s.a.agentId,
    })
    expect(snap.states).toHaveLength(1)
    expect(snap.states[0].undeterminedBecause).toMatch(/is 900 tokens_in/)
  })

  it('an agent-scoped budget re-checks orgId despite the non-org-prefixed index', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'lifetime', limitAmount: 1_000_000, createdAt: now - DAY,
    })
    // MIS-STAMP a run onto org B while keeping it on org A's agent — the
    // historical-write-correctness case `by_agent_started` cannot rule out.
    await t.run(async (ctx) => { await ctx.db.patch(s.a.runIds[0], { orgId: s.b.orgId }) })

    const snap: any = await adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, agentId: s.a.agentId,
    })
    // The foreign row is SKIPPED AND COUNTED, so the sum is incomplete and the
    // breaker fails to `undetermined` rather than quietly under-counting.
    expect(snap.states[0].state).toBe('undetermined')
    expect(snap.states[0].undeterminedBecause).toMatch(/did not belong to this organization/i)
  })

  it('EVERY by-id surface: foreign and deleted produce identical outcomes', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const foreignBudget = await insertBudget(t, { orgId: s.b.orgId, scopeId: s.b.agentId, createdAt: now })
    const ghostBudget = await insertBudget(t, { orgId: s.b.orgId, scopeId: s.b.agentId, createdAt: now })
    await t.run(async (ctx) => ctx.db.delete(ghostBudget))

    const ghostRun = await t.run(async (ctx) => {
      const id = await ctx.db.insert('runs', {
        orgId: s.b.orgId, projectId: s.b.projectId, agentId: s.b.agentId,
        status: 'completed', startedAt: now, metadata: {}, tags: [],
      })
      await ctx.db.delete(id)
      return id
    })
    // A deleted AGENT id, not a deleted run id: probing `agentId` with an id
    // from the wrong table compares a validator rejection against a tenancy
    // one, which differ for a reason that has nothing to do with tenancy.
    const ghostAgent = await t.run(async (ctx) => {
      const id = await ctx.db.insert('agents', {
        orgId: s.b.orgId, projectId: s.b.projectId, name: 'ghost', slug: 'ghost',
        createdAt: now, updatedAt: now,
      })
      await ctx.db.delete(id)
      return id
    })

    // -- budget-id surfaces --------------------------------------------------
    const budgetProbes: Array<[string, (id: any) => Promise<unknown>]> = [
      ['getBudget', (id) => adminA(t).query(api.budgets.getBudget, { budgetId: id })],
      ['tripBudget', (id) => adminA(t).mutation(api.budgets.tripBudget, { budgetId: id, reason: 'r' })],
      ['resetBudget', (id) => adminA(t).mutation(api.budgets.resetBudget, { budgetId: id, reason: 'r' })],
      ['updateBudget', (id) => adminA(t).mutation(api.budgets.updateBudget, { budgetId: id, limitAmount: 5 })],
      ['deleteBudget', (id) => adminA(t).mutation(api.budgets.deleteBudget, { budgetId: id })],
    ]
    for (const [name, probe] of budgetProbes) {
      const foreign = await outcome(() => probe(foreignBudget))
      const missing = await outcome(() => probe(ghostBudget))
      expect({ name, ...foreign }).toEqual({ name, ...missing })
      expect(foreign.ok).toBe(false)
    }

    // -- subject-id surfaces on checkBudget ---------------------------------
    const subjectProbes: Array<[string, any, any]> = [
      ['runId', { runId: s.b.runIds[0] }, { runId: ghostRun }],
      ['agentId', { agentId: s.b.agentId }, { agentId: ghostAgent }],
    ]
    for (const [name, foreignArgs, ghostArgs] of subjectProbes) {
      const foreign = await outcome(() => adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, ...foreignArgs }))
      const missing = await outcome(() => adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, ...ghostArgs }))
      expect({ name, ...foreign }).toEqual({ name, ...missing })
      expect(foreign.ok).toBe(false)
    }

    // -- createBudget cannot name another org's entity ----------------------
    const foreignCreate = await outcome(() =>
      adminA(t).mutation(api.budgets.createBudget, {
        orgId: s.a.orgId, name: 'x', scope: 'agent', scopeId: s.b.agentId,
        meter: 'tokens_in', period: 'day', limitAmount: 10,
      }),
    )
    const ghostCreate = await outcome(() =>
      adminA(t).mutation(api.budgets.createBudget, {
        orgId: s.a.orgId, name: 'x', scope: 'agent', scopeId: ghostAgent,
        meter: 'tokens_in', period: 'day', limitAmount: 10,
      }),
    )
    expect(foreignCreate).toEqual(ghostCreate)
    expect(foreignCreate.ok).toBe(false)

    // ...and cannot point an "org"-scoped budget at another organization.
    const foreignOrg = await outcome(() =>
      adminA(t).mutation(api.budgets.createBudget, {
        orgId: s.a.orgId, name: 'x', scope: 'org', scopeId: s.b.orgId,
        meter: 'tokens_in', period: 'day', limitAmount: 10,
      }),
    )
    expect(foreignOrg.ok).toBe(false)
  })

  /**
   * DOES THE ORACLE HAVE TEETH?
   *
   * Team D flagged, correctly, that an oracle comparing {ok, error} outcomes is
   * only as good as its ability to FAIL — and that this one was written by the
   * same hand that shipped the defect it now guards. An oracle nobody has seen
   * fail is a green check, not a proof.
   *
   * So the historical defect is REPRODUCED FAITHFULLY here and run through the
   * SAME comparison the suite above uses. `loadOwnBudget` fixed the ordering by
   * authenticating first and scoping the lookup to the caller's own org; the
   * pre-fix ordering — get, then check membership on the DOCUMENT's org — is
   * re-created below against the real tables and asserted to be CAUGHT.
   *
   * This also demonstrates why the suite compares outcomes with `toEqual`
   * instead of asserting both threw: the vulnerable version throws in BOTH
   * cases, so a "both rejected" check passes on it happily. The discrimination
   * comes entirely from comparing the errors.
   */
  it('THE ORACLE HAS TEETH: it catches the exact defect that shipped', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const foreignBudget = await insertBudget(t, { orgId: s.b.orgId, scopeId: s.b.agentId, createdAt: now })
    const ghostBudget = await insertBudget(t, { orgId: s.b.orgId, scopeId: s.b.agentId, createdAt: now })
    await t.run(async (ctx) => ctx.db.delete(ghostBudget))

    // A faithful re-creation of the PRE-FIX ordering, against the real tables.
    const vulnerableGetBudget = (budgetId: any) =>
      t.run(async (ctx) => {
        const doc = await ctx.db.get(budgetId)
        if (!doc) throw new Error('NOT_FOUND: Budget not found')
        const membership = await ctx.db
          .query('user_memberships')
          .withIndex('by_clerk_user', (q: any) => q.eq('clerkUserId', 'admin_a'))
          .filter((q: any) => q.eq(q.field('orgId'), (doc as any).orgId))
          .unique()
        if (!membership) throw new Error('Unauthorized: not a member of this organization')
        return doc
      })

    const vulnFor = await outcome(() => vulnerableGetBudget(foreignBudget))
    const vulnMissing = await outcome(() => vulnerableGetBudget(ghostBudget))

    // 1. A "both rejected" check — the weaker oracle — PASSES on the defect.
    //    This is why that check is not what the suite above uses.
    expect(vulnFor.ok).toBe(false)
    expect(vulnMissing.ok).toBe(false)

    // 2. The outcome comparison the suite DOES use FAILS on it. Asserted by
    //    requiring the assertion itself to throw.
    expect(() => expect(vulnFor).toEqual(vulnMissing)).toThrow()
    expect(vulnFor.error).toMatch(/not a member/)
    expect(vulnMissing.error).toMatch(/NOT_FOUND/)

    // 3. And the SHIPPED function, over the same two ids, is indistinguishable.
    const realFor = await outcome(() => adminA(t).query(api.budgets.getBudget, { budgetId: foreignBudget }))
    const realMissing = await outcome(() => adminA(t).query(api.budgets.getBudget, { budgetId: ghostBudget }))
    expect(realFor).toEqual(realMissing)
    expect(realFor.ok).toBe(false)
  })

  it("listing and checking never surface another org's budgets", async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await insertBudget(t, { orgId: s.b.orgId, scope: 'org', scopeId: s.b.orgId, name: 'B ONLY', createdAt: now })
    expect(await adminA(t).query(api.budgets.listBudgets, { orgId: s.a.orgId })).toEqual([])
    const snap: any = await adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId })
    expect(snap.states).toEqual([])
    // Zero budgets is a COMPLETE answer meaning "no budget governs this" — the
    // contract gives it its own decision band so it is never read as headroom.
    expect(snap.scan.budgetsInScope).toBe(0)
    expect(isBreakerSnapshotComplete(snap)).toBe(true)
  })

  it('the SDK gate takes its org from the key and cannot be pointed elsewhere', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', {
        orgId: s.a.orgId, name: 'k', keyHash: 'hash_a',
        createdAt: now, createdBy: 'admin_a', scopes: ['ingest:write'],
      } as any)
    })
    await insertBudget(t, { orgId: s.b.orgId, scope: 'org', scopeId: s.b.orgId, name: 'B ONLY', createdAt: now })

    const res: any = await t.query(api.budget_gate.sdkCheckBudget, { apiKeyHash: 'hash_a' })
    expect(res.states).toEqual([])
    expect(res.scan.subject.orgId).toBe(s.a.orgId)

    // Naming org B's run or agent is indistinguishable from naming a deleted one.
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert('runs', {
        orgId: s.b.orgId, projectId: s.b.projectId, agentId: s.b.agentId,
        status: 'completed', startedAt: now, metadata: {}, tags: [],
      })
      await ctx.db.delete(id)
      return id
    })
    expect(
      await outcome(() => t.query(api.budget_gate.sdkCheckBudget, { apiKeyHash: 'hash_a', runId: s.b.runIds[0] })),
    ).toEqual(
      await outcome(() => t.query(api.budget_gate.sdkCheckBudget, { apiKeyHash: 'hash_a', runId: ghost })),
    )

    // A key lacking ingest:write, and a revoked key, both get nothing.
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', {
        orgId: s.a.orgId, name: 'ro', keyHash: 'hash_ro',
        createdAt: now, createdBy: 'admin_a', scopes: ['read'],
      } as any)
    })
    const noScope = await outcome(() => t.query(api.budget_gate.sdkCheckBudget, { apiKeyHash: 'hash_ro' }))
    expect(noScope.ok).toBe(false)
    expect(noScope.error).toMatch(/scope/i)

    await t.run(async (ctx) => {
      const k = await ctx.db.query('api_keys').withIndex('by_key_hash', (q: any) => q.eq('keyHash', 'hash_a')).unique()
      await ctx.db.patch(k!._id, { revokedAt: now })
    })
    const revoked = await outcome(() => t.query(api.budget_gate.sdkCheckBudget, { apiKeyHash: 'hash_a' }))
    expect(revoked.ok).toBe(false)
    expect(revoked.error).toMatch(/Unauthorized/)
  })

  it('the SDK gate returns a SNAPSHOT and never a decision', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', {
        orgId: s.a.orgId, name: 'k', keyHash: 'hash_a',
        createdAt: now, createdBy: 'admin_a', scopes: ['ingest:write'],
      } as any)
    })
    await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'lifetime', limitAmount: 100, createdAt: now - DAY,
    })
    const res: any = await t.query(api.budget_gate.sdkCheckBudget, {
      apiKeyHash: 'hash_a', agentId: s.a.agentId,
    })
    // The allow/deny call belongs to the SDK, which alone knows its own
    // BudgetUnavailablePolicy. The server states facts and stops there.
    expect(Object.keys(res).sort()).toEqual([
      'evaluatedAt', 'freshUntil', 'scan', 'shelfLifeMs', 'states',
    ])
    // The intent behind the shape check, asserted directly so it survives
    // additive fields: no decision, no verdict, no allow/deny anywhere.
    for (const key of ['decision', 'outcome', 'allowed', 'denied', 'mayProceed', 'verdict', 'claim']) {
      expect(Object.prototype.hasOwnProperty.call(res, key)).toBe(false)
    }
    expect(res.states[0].state).toBe('tripped')
  })
})

// ===========================================================================
// (4) THE APPEND-ONLY LOG IS UNTOUCHED
// ===========================================================================

describe('(4) no breaker operation writes to events or runs', () => {
  it('a UTC-day roll that trips and re-arms writes NOTHING to events or runs', async () => {
    const t = convexTest(schema, modules)
    const beforeMidnight = Date.parse('2026-07-25T23:50:00.000Z')
    const afterMidnight = Date.parse('2026-07-26T00:10:00.000Z')
    const s = await seed(t, beforeMidnight)
    const budgetId = await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'day', limitAmount: 500, rearmOnPeriodRoll: true,
      createdAt: Date.parse('2026-07-20T00:00:00.000Z'),
    })

    const dump = async () =>
      await t.run(async (ctx) => ({
        events: await ctx.db.query('events').collect(),
        runs: await ctx.db.query('runs').collect(),
      }))
    const before = await dump()

    const tripped: any = await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now: beforeMidnight })
    expect(tripped.state.state).toBe('tripped')
    const rolled: any = await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now: afterMidnight })
    // The new day's window holds none of those runs. A counter figure cannot
    // prove headroom, so it stays tripped — correctly, and only a reset clears it.
    expect(rolled.state.state).toBe('tripped')

    // THE CLAIM: no event appended, none mutated, no run patched, no status changed.
    expect(await dump()).toEqual(before)
  })

  it('a run IN FLIGHT across the roll is neither patched nor terminated', async () => {
    const t = convexTest(schema, modules)
    const beforeMidnight = Date.parse('2026-07-25T23:50:00.000Z')
    const s = await seed(t, beforeMidnight)
    const liveRunId = await t.run(async (ctx) =>
      ctx.db.insert('runs', {
        orgId: s.a.orgId, projectId: s.a.projectId, agentId: s.a.agentId,
        status: 'running', startedAt: beforeMidnight - MIN, metadata: {}, tags: [],
        tokensIn: 5000, tokensOut: 5000,
      }),
    )
    const budgetId = await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in',
      period: 'day', limitAmount: 500, createdAt: Date.parse('2026-07-20T00:00:00.000Z'),
    })
    const runBefore = await t.run(async (ctx) => ctx.db.get(liveRunId))

    const r: any = await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now: beforeMidnight })
    expect(r.state.state).toBe('tripped')
    // The in-flight run is COUNTED and reported as still accruing...
    expect(r.state.determinedFrom[0].approximateBecause).toMatch(/still in flight/i)
    // ...and is otherwise completely untouched.
    expect(await t.run(async (ctx) => ctx.db.get(liveRunId))).toEqual(runBefore)

    await (t as any).mutation(internal.budgets.recordTripIfBreached, { budgetId, now: Date.parse('2026-07-26T00:10:00.000Z') })
    expect(await t.run(async (ctx) => ctx.db.get(liveRunId))).toEqual(runBefore)
  })

  it('manual trip, reset and delete write nothing to events or runs either', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const dump = async () =>
      await t.run(async (ctx) => ({
        events: await ctx.db.query('events').collect(),
        runs: await ctx.db.query('runs').collect(),
      }))
    const before = await dump()

    const budgetId: any = await adminA(t).mutation(api.budgets.createBudget, {
      orgId: s.a.orgId, name: 'cap', scope: 'agent', scopeId: s.a.agentId,
      meter: 'tokens_in', period: 'day', limitAmount: 10,
    })
    await adminA(t).mutation(api.budgets.tripBudget, { budgetId, reason: 'manual' })
    await adminA(t).mutation(api.budgets.resetBudget, { budgetId, reason: 'r' })
    await adminA(t).mutation(api.budgets.deleteBudget, { budgetId })

    expect(await dump()).toEqual(before)
  })
})

// ===========================================================================
// (5) THE CONTRACT'S OWN VALIDATORS
// ===========================================================================

describe("(5) the wire answer satisfies the contract's validators", () => {
  it('a snapshot spanning every band is accepted by all three', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    // tripped (counter), undetermined (counter under limit), armed (reconciled),
    // undetermined (refused cost meter) — four bands, four distinct budgets.
    await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, name: 'trip', meter: 'tokens_in', period: 'lifetime', limitAmount: 100, createdAt: now - DAY })
    await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, name: 'undet', meter: 'tokens_out', period: 'lifetime', limitAmount: 1_000_000, createdAt: now - DAY })
    await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, name: 'cost', meter: 'cost_minor_units', currency: 'USD', period: 'lifetime', limitAmount: 100, createdAt: now - DAY })
    await insertBudget(t, { orgId: s.a.orgId, scope: 'run', scopeId: s.a.loggedRunId, name: 'run', meter: 'tokens_in', period: 'run', limitAmount: 1000, createdAt: now - DAY })

    const snap: any = await adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, agentId: s.a.agentId, runId: s.a.loggedRunId,
    })
    expect(snap.states).toHaveLength(4)
    expect(snap.states.map((x: any) => x.state).sort()).toEqual([
      'armed', 'tripped', 'undetermined', 'undetermined',
    ])
    expect(snapshotUnusableFields(snap)).toEqual([])
    expect(snapshotClaimContradictions(snap)).toEqual([])
    expect(isBreakerSnapshotComplete(snap)).toBe(true)
    expect(snap.freshUntil).toBeGreaterThan(snap.evaluatedAt)
    // X2: the receipt-anchorable duration rides alongside the absolute instant,
    // so transit time does not silently eat the margin. Additive — the contract
    // validators above still pass with it present.
    expect(snap.shelfLifeMs).toBe(snap.freshUntil - snap.evaluatedAt)
    expect(snap.shelfLifeMs).toBeGreaterThan(0)
  })

  it('a disabled budget governs nothing and is not counted as evaluated', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await insertBudget(t, {
      orgId: s.a.orgId, scopeId: s.a.agentId, enabled: false,
      meter: 'tokens_in', period: 'lifetime', limitAmount: 1, createdAt: now - DAY,
    })
    const snap: any = await adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, agentId: s.a.agentId })
    expect(snap.scan.budgetsInScope).toBe(0)
    expect(snap.states).toEqual([])
    expect(isBreakerSnapshotComplete(snap)).toBe(true)
  })

  it('sweep pressure is OBSERVABLE before it bites, and names what lag costs', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, enabled: false, createdAt: now })

    const p: any = await adminA(t).query(api.budgets.getBudgetSweepPressure, { orgId: s.a.orgId })
    expect(p.enabledInOrg).toBe(1)
    expect(p.sweepBatchSize).toBeGreaterThan(0)
    expect(p.sweepCadenceMs).toBeGreaterThan(0)
    // The refit decoupled this: a lagging sweep delays the AUDIT of an unqueried
    // breach and nothing else, because answers are computed fresh on every call.
    expect(p.lagAffects).toBe('audit_latency_only')
    // Admin-only: sweep pressure is deployment-shaped operational detail.
    expect((await outcome(() => memberA(t).query(api.budgets.getBudgetSweepPressure, { orgId: s.a.orgId }))).ok).toBe(false)
  })

  it('the sweep reports its own truncation positively', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    const res: any = await (t as any).action(internal.budgets.sweepBudgetBreakers, {})
    // Positively observed (over-fetch by one), not inferred from a wave of
    // late audits.
    expect(res.sweepTruncated).toBe(false)
    expect(res.evaluated).toBe(1)
  })

  it('the sweep evaluates enabled budgets and skips disabled ones', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const on = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, meter: 'tokens_in', period: 'lifetime', limitAmount: 100, createdAt: now - DAY })
    const off = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, enabled: false, meter: 'tokens_in', period: 'lifetime', limitAmount: 100, createdAt: now - DAY })

    const res: any = await (t as any).action(internal.budgets.sweepBudgetBreakers, {})
    expect(res.evaluated).toBe(1)
    expect((await t.run(async (ctx) => ctx.db.get(on)) as any).trippedAt).toBeTruthy()
    expect((await t.run(async (ctx) => ctx.db.get(off)) as any).trippedAt).toBeUndefined()
  })
})

// ===========================================================================
// (6) KEY-AUTHENTICATED PRIVILEGED MUTATIONS
//
// An API key carries no role, so Team C correctly refused to write the admin
// check in the web tier — that tier does not hold `user_memberships`. The
// resolution lives here: an EXPLICIT privileged scope (the opt-in) ANDed with
// the key creator's LIVE org role (the authority).
// ===========================================================================

async function makeKey(
  t: ReturnType<typeof convexTest>,
  orgId: any,
  hash: string,
  createdBy: string,
  scopes: string[] | undefined,
) {
  const now = Date.now()
  await t.run(async (ctx) => {
    await ctx.db.insert('api_keys', {
      orgId, name: hash, keyHash: hash, createdAt: now, createdBy,
      ...(scopes !== undefined ? { scopes } : {}),
    } as any)
  })
}

describe('(6) key-authed trip and reset', () => {
  it('an admin-created key with both scopes can trip AND reset, with a receipt', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    await makeKey(t, s.a.orgId, 'k_admin', 'admin_a', ['budget:trip', 'budget:reset'])

    const trip: any = await t.mutation(api.budget_gate.sdkTripBudget, {
      apiKeyHash: 'k_admin', budgetId, reason: 'spend spike on checkout agent',
    })
    // THE RECEIPT. The contract's BudgetMutationResult — an operator can cite
    // auditLogId in the incident ticket instead of scanning the log by timestamp.
    expect(trip.budgetId).toBe(budgetId)
    expect(trip.appliedAt).toBeGreaterThan(0)
    expect(trip.auditLogId).toBeTruthy()
    const cited: any = await t.run(async (ctx) => ctx.db.get(trip.auditLogId))
    expect(cited.action).toBe('budget.tripped')
    expect(cited.actorClerkUserId).toBe('admin_a') // the key acts AS its creator
    expect(cited.metadata.via).toBe('api_key')
    expect(cited.metadata.operatorNote).toBe('spend spike on checkout agent')

    const reset: any = await t.mutation(api.budget_gate.sdkResetBudget, {
      apiKeyHash: 'k_admin', budgetId, reason: 'rolled back the bad prompt',
    })
    expect((await t.run(async (ctx) => ctx.db.get(reset.auditLogId)) as any).action).toBe('budget.reset')
    expect((await t.run(async (ctx) => ctx.db.get(budgetId)) as any).trippedAt).toBeUndefined()
  })

  it('THE ASYMMETRY SURVIVES KEY AUTH: a member-created key may trip but not reset', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    await makeKey(t, s.a.orgId, 'k_member', 'member_a', ['budget:trip', 'budget:reset'])

    // Scope granted for both; the ROLE is what stops the dangerous one.
    const trip = await outcome(() => t.mutation(api.budget_gate.sdkTripBudget, {
      apiKeyHash: 'k_member', budgetId, reason: 'pulling the cord',
    }))
    expect(trip.ok).toBe(true)

    const reset = await outcome(() => t.mutation(api.budget_gate.sdkResetBudget, {
      apiKeyHash: 'k_member', budgetId, reason: 'undo',
    }))
    expect(reset.ok).toBe(false)
    expect(reset.error).toMatch(/admin/i)
  })

  it('THE BACK-COMPAT HOLE IS CLOSED: an unscoped legacy key gets neither', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    // `scopes: undefined` means FULL ACCESS on the ingest path. If that grant
    // reached these mutations, every key an admin ever created would silently
    // have gained the power to clear a proven breach the day this shipped.
    await makeKey(t, s.a.orgId, 'k_legacy', 'admin_a', undefined)
    for (const fn of [api.budget_gate.sdkTripBudget, api.budget_gate.sdkResetBudget]) {
      const r = await outcome(() => t.mutation(fn, { apiKeyHash: 'k_legacy', budgetId, reason: 'x' }))
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/explicitly-granted/i)
    }
    // ...and an ingest-only key likewise.
    await makeKey(t, s.a.orgId, 'k_ingest', 'admin_a', ['ingest:write'])
    expect((await outcome(() => t.mutation(api.budget_gate.sdkTripBudget, {
      apiKeyHash: 'k_ingest', budgetId, reason: 'x',
    }))).ok).toBe(false)
  })

  it('THE ROLE IS LIVE: demoting the creator revokes the key, with no rotation', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    await makeKey(t, s.a.orgId, 'k_admin', 'admin_a', ['budget:reset'])
    expect((await outcome(() => t.mutation(api.budget_gate.sdkResetBudget, {
      apiKeyHash: 'k_admin', budgetId, reason: 'first',
    }))).ok).toBe(true)

    // Demote the creator. This is the property a static scope cannot give.
    await t.run(async (ctx) => {
      const m = await ctx.db.query('user_memberships')
        .withIndex('by_clerk_user', (q: any) => q.eq('clerkUserId', 'admin_a'))
        .filter((q: any) => q.eq(q.field('orgId'), s.a.orgId)).unique()
      await ctx.db.patch(m!._id, { role: 'member' })
    })
    const after = await outcome(() => t.mutation(api.budget_gate.sdkResetBudget, {
      apiKeyHash: 'k_admin', budgetId, reason: 'second',
    }))
    expect(after.ok).toBe(false)

    // Removing the membership entirely is indistinguishable from demotion —
    // a key holder must not be able to probe another person's role.
    await t.run(async (ctx) => {
      const m = await ctx.db.query('user_memberships')
        .withIndex('by_clerk_user', (q: any) => q.eq('clerkUserId', 'admin_a'))
        .filter((q: any) => q.eq(q.field('orgId'), s.a.orgId)).unique()
      await ctx.db.delete(m!._id)
    })
    const removed = await outcome(() => t.mutation(api.budget_gate.sdkResetBudget, {
      apiKeyHash: 'k_admin', budgetId, reason: 'third',
    }))
    expect(removed).toEqual(after)
  })

  it('reason is REQUIRED and non-empty, and never defaulted', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    await makeKey(t, s.a.orgId, 'k_admin', 'admin_a', ['budget:trip'])
    for (const reason of ['', '   ']) {
      const r = await outcome(() => t.mutation(api.budget_gate.sdkTripBudget, { apiKeyHash: 'k_admin', budgetId, reason }))
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/reason is required/i)
    }
    // The Clerk twin agrees — the two no longer disagree about the contract.
    const clerk = await outcome(() => adminA(t).mutation(api.budgets.tripBudget, { budgetId, reason: '  ' }))
    expect(clerk.ok).toBe(false)
    expect(clerk.error).toMatch(/reason is required/i)
  })

  it('a key cannot touch another org\'s budget, or tell it from a missing one', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const foreign = await insertBudget(t, { orgId: s.b.orgId, scopeId: s.b.agentId, createdAt: now })
    const ghost = await insertBudget(t, { orgId: s.b.orgId, scopeId: s.b.agentId, createdAt: now })
    await t.run(async (ctx) => ctx.db.delete(ghost))
    await makeKey(t, s.a.orgId, 'k_admin', 'admin_a', ['budget:trip', 'budget:reset'])

    for (const fn of [api.budget_gate.sdkTripBudget, api.budget_gate.sdkResetBudget]) {
      const f = await outcome(() => t.mutation(fn, { apiKeyHash: 'k_admin', budgetId: foreign, reason: 'x' }))
      const m = await outcome(() => t.mutation(fn, { apiKeyHash: 'k_admin', budgetId: ghost, reason: 'x' }))
      expect(f).toEqual(m)
      expect(f.ok).toBe(false)
    }
  })

  it('the Clerk mutations return the same receipt shape', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const budgetId = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    const r: any = await adminA(t).mutation(api.budgets.tripBudget, { budgetId, reason: 'incident 4471' })
    expect(Object.keys(r).sort()).toEqual(['appliedAt', 'auditLogId', 'budgetId'])
    expect((await t.run(async (ctx) => ctx.db.get(r.auditLogId)) as any).metadata.via).toBe('clerk')
  })
})

describe('(7) per-budget snapshot narrowing', () => {
  it('budgetId narrows to one budget and stays a full, valid snapshot', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const tight = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, name: 'tight', meter: 'tokens_in', period: 'lifetime', limitAmount: 100, createdAt: now - DAY })
    await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, name: 'loose', meter: 'tokens_in', period: 'lifetime', limitAmount: 1_000_000, createdAt: now - DAY })

    const snap: any = await adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, budgetId: tight })
    expect(snap.states).toHaveLength(1)
    expect(snap.states[0].trippedBudgetId).toBe(tight)
    expect(snap.scan.budgetsInScope).toBe(1)
    // Still a FULL snapshot: scan, freshUntil and the state's reasons all
    // present, so it is not the projection Team C refuses on the route.
    expect(snapshotUnusableFields(snap)).toEqual([])
    expect(snapshotClaimContradictions(snap)).toEqual([])
    expect(isBreakerSnapshotComplete(snap)).toBe(true)
  })

  it('budgetId cannot be combined with a subject', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const b = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, createdAt: now })
    const r = await outcome(() => adminA(t).query(api.budgets.checkBudget, {
      orgId: s.a.orgId, budgetId: b, agentId: s.a.agentId,
    }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cannot be combined/i)
  })

  it('a foreign budgetId is indistinguishable from a missing one', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const foreign = await insertBudget(t, { orgId: s.b.orgId, scopeId: s.b.agentId, createdAt: now })
    const ghost = await insertBudget(t, { orgId: s.b.orgId, scopeId: s.b.agentId, createdAt: now })
    await t.run(async (ctx) => ctx.db.delete(ghost))
    expect(await outcome(() => adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, budgetId: foreign })))
      .toEqual(await outcome(() => adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, budgetId: ghost })))
  })

  it('a disabled budget narrowed to still governs nothing', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const s = await seed(t, now)
    const off = await insertBudget(t, { orgId: s.a.orgId, scopeId: s.a.agentId, enabled: false, limitAmount: 1, createdAt: now - DAY })
    const snap: any = await adminA(t).query(api.budgets.checkBudget, { orgId: s.a.orgId, budgetId: off })
    expect(snap.scan.budgetsInScope).toBe(0)
    expect(snap.states).toEqual([])
  })
})
