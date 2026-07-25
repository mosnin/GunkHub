/**
 * services/budgets.ts — Clerk-authed service layer for budget circuit
 * breakers, wrapping `convex/budgets.ts`.
 *
 * Mirrors services/alerts.ts: resolves the Clerk org to a Convex orgId, then
 * calls the org-scoped Convex functions. CONVEX ENFORCES THE ROLE CHECKS —
 * this layer does not duplicate them, it only surfaces what Convex throws. The
 * split is not uniform and this layer must not flatten it:
 *
 *   createBudget / updateBudget / deleteBudget   ADMIN
 *   tripBudget                                   MEMBER   <- tripping withholds
 *   resetBudget                                  ADMIN    <- resetting resumes spend
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS LAYER DOES BEYOND FORWARDING
 * ---------------------------------------------------------------------------
 *
 * It refuses to hand a renderer a snapshot that cannot be trusted, and it
 * refuses in a way that CANNOT BE MISTAKEN FOR AN EMPTY ONE.
 *
 * The Convex ref returns `unknown` by design (see convexFunctions.ts), so
 * something has to establish what actually arrived. That something is
 * contracts' own `breakerSnapshotRefusals` — the SAME function the SDK gate
 * uses — rather than a check invented here, because three layers with three
 * notions of "trustworthy" is how three layers come to disagree about what is
 * safe to enforce on.
 *
 * `readOrgBreakerSnapshot` therefore returns a DISCRIMINATED UNION, not a
 * nullable snapshot. A `null` would have collapsed "we could not read your
 * breakers" into the same shape as "you have no breakers", and those two must
 * never render alike: the first is an outage, the second is an absence of cost
 * control, and both look like a quiet screen.
 */
import {
  breakerSnapshotRefusals,
  type BreakerSnapshot,
  type BreakerTripCause,
  type BudgetLimit,
  type BudgetMeter,
  type BudgetPeriod,
  type BudgetScope,
} from '@agent-flight-recorder/contracts'
import { auth } from '@clerk/nextjs/server'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId, withConvexTimeout } from '@/lib/convexServer'

/**
 * A budget as this UI shows it: the contract's {@link BudgetLimit} plus the
 * operator-facing facts the Convex row carries.
 *
 * EXTENDS the contract type rather than restating it (CLAUDE.md Repo
 * Conventions -> Types). The added fields are all RECORDED FACTS — a name, a
 * trip, a reset — never an evaluated state. There is deliberately no `state`
 * field here: breaker state is derived and arrives on a snapshot, and a copy of
 * it hanging off a budget row would be a stored projection that can disagree
 * with the runs it came from (CLAUDE.md Event Log Rule 2).
 */
export interface BudgetRecord extends BudgetLimit {
  name: string
  /** Re-arm when the accounting period rolls past the trip, rather than only on an operator reset. */
  rearmOnPeriodRoll: boolean
  /** Present iff this breaker is currently tripped. A recorded fact, not an evaluation. */
  trippedAt?: number
  trippedBy?: BreakerTripCause
  /**
   * The system's own past-tense account of the trip, composed server-side under
   * a guard that forbids execution claims. Rendered verbatim; never rephrased
   * here, because rephrasing is how a caveat gets dropped.
   */
  trippedBecause?: string
  /** Operator free text from a manual trip or reset. A HUMAN'S words — displayed as theirs, never as ours. */
  operatorNote?: string
  /** Last operator reset; the start of the current accounting window. */
  resetAt?: number
}

/**
 * The result of asking what the breakers say.
 *
 * THREE ARMS, AND THE THIRD IS THE POINT. `unreadable` is not an error state to
 * be swallowed into an empty list — it is the answer, and it must reach the
 * screen saying so.
 */
export type BreakerSnapshotRead =
  /** A snapshot that contracts' own gate is willing to be enforced on. */
  | { kind: 'snapshot'; snapshot: BreakerSnapshot }
  /**
   * A body arrived and it CANNOT be enforced on. Carries every refusal reason
   * verbatim, because "the breaker data is malformed" without saying which
   * field is a bug report nobody can act on.
   */
  | { kind: 'unreadable'; refusals: string[] }

async function requireOrgContext(): Promise<{ convexOrgId: string }> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Unauthorized: no organization context')
  return { convexOrgId: await resolveConvexOrgId(clerkOrgId) }
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function optionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Map one `budget_breakers` document to a {@link BudgetRecord}.
 *
 * Exported for `tests/unit/budget_ui_*.test.ts`, which is the only way to pin
 * this mapping without a live Convex deployment — the ref it crosses is a
 * string and typechecks against nothing.
 */
export function mapBudgetRow(row: Record<string, unknown>): BudgetRecord {
  const trippedBy = row['trippedBy']
  // Bound to consts rather than called twice inside each conditional spread.
  // Calling twice re-widens the result to `number | undefined` on the second
  // call, which `exactOptionalPropertyTypes` rejects — and the test project
  // compiles apps/web under that stricter flag (see tests/tsconfig.dom.json's
  // write-up of the same divergence). Binding once keeps this file correct
  // under both configurations rather than only under its own.
  const trippedAt = optionalNumber(row, 'trippedAt')
  const resetAt = optionalNumber(row, 'resetAt')
  return {
    budgetId: str(row, '_id'),
    orgId: str(row, 'orgId'),
    scope: row['scope'] as BudgetScope,
    scopeId: str(row, 'scopeId'),
    meter: row['meter'] as BudgetMeter,
    period: row['period'] as BudgetPeriod,
    limitAmount: typeof row['limitAmount'] === 'number' ? row['limitAmount'] : 0,
    ...(typeof row['currency'] === 'string' ? { currency: row['currency'] } : {}),
    enabled: row['enabled'] === true,
    createdAt: optionalNumber(row, 'createdAt') ?? 0,
    name: str(row, 'name'),
    rearmOnPeriodRoll: row['rearmOnPeriodRoll'] === true,
    ...(trippedAt !== undefined ? { trippedAt } : {}),
    ...(trippedBy === 'limit_reached' || trippedBy === 'manual_trip'
      ? { trippedBy: trippedBy as BreakerTripCause }
      : {}),
    ...(typeof row['trippedBecause'] === 'string' ? { trippedBecause: row['trippedBecause'] } : {}),
    ...(typeof row['operatorNote'] === 'string' ? { operatorNote: row['operatorNote'] } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

/**
 * Every budget configured for the caller's org.
 *
 * THROWS rather than returning an empty array on failure, and that is
 * deliberate: a caller that cannot distinguish "no budgets" from "the read
 * failed" will render the same quiet screen for both, and one of those two
 * means an organization believes it has cost control that it does not have.
 */
export async function listBudgets(): Promise<BudgetRecord[]> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  const rows = await withConvexTimeout(client.query(convex.budgets.listBudgets, { orgId: convexOrgId }))
  if (!Array.isArray(rows)) return []
  return (rows as Record<string, unknown>[]).map(mapBudgetRow)
}

/**
 * Decide whether a body from the wire may be shown as a breaker snapshot.
 *
 * Pure and exported so `tests/unit/budget_ui_snapshot_read.test.ts` can pin it
 * without Convex. Uses contracts' `breakerSnapshotRefusals` — the SAME gate the
 * SDK applies — rather than a second opinion invented here.
 */
export function readBreakerSnapshot(raw: unknown): BreakerSnapshotRead {
  const refusals = breakerSnapshotRefusals(raw as BreakerSnapshot)
  if (refusals.length > 0) return { kind: 'unreadable', refusals }
  return { kind: 'snapshot', snapshot: raw as BreakerSnapshot }
}

/** The subject a breaker evaluation is about. Every field optional; omitting all of them asks about the org. */
export interface BreakerSubjectQuery {
  projectId?: string
  agentId?: string
  agentVersionId?: string
  runId?: string
}

/**
 * What the breakers say about a subject in the caller's org.
 *
 * The narrowing ids are forwarded EXPLICITLY rather than spread from an object,
 * because this crosses the hand-maintained `makeFunctionReference` seam where a
 * silently dropped field is not a type error — and a dropped `runId` returns a
 * well-formed snapshot about the WRONG SUBJECT, which is the one failure this
 * surface must not have.
 */
export async function readOrgBreakerSnapshot(
  subject: BreakerSubjectQuery = {},
): Promise<BreakerSnapshotRead> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  const raw = await withConvexTimeout(
    client.query(convex.budgets.checkBudget, {
      orgId: convexOrgId,
      ...(subject.projectId !== undefined && { projectId: subject.projectId }),
      ...(subject.agentId !== undefined && { agentId: subject.agentId }),
      ...(subject.agentVersionId !== undefined && { agentVersionId: subject.agentVersionId }),
      ...(subject.runId !== undefined && { runId: subject.runId }),
    }),
  )
  return readBreakerSnapshot(raw)
}

/**
 * How close this org is to the breaker sweep's ceiling.
 *
 * `lagAffects` IS CARRIED THROUGH RATHER THAN INTERPRETED HERE, and it is the
 * field that keeps this panel from becoming a false alarm. A lagging sweep does
 * NOT make a breaker answer stale — state is computed fresh on every check and
 * never reads the sweep's output — so the only cost is that a breach nobody
 * queried is audited later than it happened. A layer that translated this into
 * "breaker state may be stale" would be manufacturing an alarm in the
 * halt-a-business direction.
 */
export interface SweepPressure {
  enabledInOrg: number
  /** GLOBAL across every org. Being well under it is not proof of safety. */
  sweepBatchSize: number
  sweepCadenceMs: number
  lagAffects: string
}

/** ADMIN-gated. Returns `null` when the caller is not an admin, or on any failure. */
export async function readSweepPressure(): Promise<SweepPressure | null> {
  try {
    const { convexOrgId } = await requireOrgContext()
    const client = await getAuthedClient()
    const raw = await withConvexTimeout(
      client.query(convex.budgets.getBudgetSweepPressure, { orgId: convexOrgId }),
    )
    if (raw === null || typeof raw !== 'object') return null
    const row = raw as Record<string, unknown>
    return {
      enabledInOrg: typeof row['enabledInOrg'] === 'number' ? row['enabledInOrg'] : 0,
      sweepBatchSize: typeof row['sweepBatchSize'] === 'number' ? row['sweepBatchSize'] : 0,
      sweepCadenceMs: typeof row['sweepCadenceMs'] === 'number' ? row['sweepCadenceMs'] : 0,
      lagAffects: typeof row['lagAffects'] === 'string' ? row['lagAffects'] : 'unknown',
    }
    // `null` on failure is safe HERE and only here: this is an operational
    // observability panel, not an answer about spend. Nothing is concluded from
    // its absence, and the panel simply does not render — unlike the budget
    // list and the snapshot, where a swallowed failure would read as an
    // all-clear.
  } catch {
    return null
  }
}

export interface CreateBudgetInput {
  name: string
  scope: BudgetScope
  scopeId: string
  meter: BudgetMeter
  period: BudgetPeriod
  limitAmount: number
  currency?: string
  rearmOnPeriodRoll?: boolean
  enabled?: boolean
}

/** Create a budget. ADMIN-gated and audited server-side; Convex enforces both. */
export async function createBudget(input: CreateBudgetInput): Promise<string> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  const budgetId = await withConvexTimeout(
    client.mutation(convex.budgets.createBudget, {
      orgId: convexOrgId,
      name: input.name,
      scope: input.scope,
      scopeId: input.scopeId,
      meter: input.meter,
      period: input.period,
      limitAmount: input.limitAmount,
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.rearmOnPeriodRoll !== undefined && { rearmOnPeriodRoll: input.rearmOnPeriodRoll }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    }),
  )
  return typeof budgetId === 'string' ? budgetId : ''
}

export interface UpdateBudgetInput {
  name?: string
  enabled?: boolean
  limitAmount?: number
  rearmOnPeriodRoll?: boolean
}

/**
 * Change a budget's configuration. ADMIN-gated and audited.
 *
 * NOTE WHAT IT CANNOT DO: clear a trip. Raising a limit is not a decision that
 * the earlier breach did not happen, so `resetBudget` is the only path — and it
 * is a separate call behind the same admin gate rather than one extra field
 * here.
 */
export async function updateBudget(budgetId: string, input: UpdateBudgetInput): Promise<void> {
  const client = await getAuthedClient()
  await withConvexTimeout(
    client.mutation(convex.budgets.updateBudget, {
      budgetId,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.limitAmount !== undefined && { limitAmount: input.limitAmount }),
      ...(input.rearmOnPeriodRoll !== undefined && { rearmOnPeriodRoll: input.rearmOnPeriodRoll }),
    }),
  )
}

/** Delete a budget. ADMIN-gated. The row goes; the audit rows do not. */
export async function deleteBudget(budgetId: string): Promise<void> {
  const client = await getAuthedClient()
  await withConvexTimeout(client.mutation(convex.budgets.deleteBudget, { budgetId }))
}

/**
 * Trip a breaker by hand. MEMBER-gated and audited under the operator's own id.
 *
 * `reason` is required here even though the Convex validator accepts an
 * optional `note`, and the strictness is the contract's: `ManualTripRequest`
 * makes it required because a manual trip has no meter reading behind it, so
 * the audit entry's only content is the sentence a human wrote.
 */
export async function tripBudget(budgetId: string, reason: string): Promise<void> {
  const client = await getAuthedClient()
  await withConvexTimeout(client.mutation(convex.budgets.tripBudget, { budgetId, reason }))
}

/**
 * Clear a trip and begin a new accounting period. ADMIN-gated and audited.
 *
 * The gate is stricter than `tripBudget`'s on purpose and this layer must not
 * even them out: tripping withholds and costs delay; resetting resumes spend
 * with no ceiling in front of it.
 */
export async function resetBudget(budgetId: string, reason: string): Promise<void> {
  const client = await getAuthedClient()
  await withConvexTimeout(client.mutation(convex.budgets.resetBudget, { budgetId, reason }))
}
