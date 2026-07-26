import type { Metadata } from 'next'

import { BreakerSnapshotPanel } from '@/components/budgets/BreakerSnapshotPanel'
import { BudgetsSection } from '@/components/budgets/BudgetsSection'
import { Card } from '@/components/ui/Card'
import { getCurrentAuth } from '@/lib/auth'
import { resolveConvexOrgId } from '@/lib/convexServer'
import {
  listBudgets,
  readOrgBreakerSnapshot,
  readSweepPressure,
  type BreakerSnapshotRead,
  type BudgetRecord,
} from '@/lib/services/budgets'

export const metadata: Metadata = { title: 'Budgets — Settings' }

/**
 * /settings/budgets — budget circuit breakers.
 *
 * ---------------------------------------------------------------------------
 * TWO INDEPENDENT READS, AND NEITHER FAILURE IS ALLOWED TO LOOK LIKE ABSENCE
 * ---------------------------------------------------------------------------
 *
 * The page asks two different questions of the backend and they fail
 * separately:
 *
 *   WHAT IS CONFIGURED   the budget rows. A recorded fact.
 *   WHAT DO THEY SAY     the breaker snapshot. A derived answer, recomputed on
 *                        every read and never stored back (CLAUDE.md Event Log
 *                        Rule 2).
 *
 * Each is caught on its own and each carries its failure to the screen as a
 * FAILURE. A single try/catch around both, or a `?? []` on either, would
 * produce the quiet screen that means "you have nothing configured" out of an
 * outage — and in this feature that quiet reads as reassurance, which is the
 * dangerous direction.
 *
 * `getCurrentAuth()` throws when there is no session or no org, which the
 * route group's error boundary renders; there is no client-side guard here and
 * must not be one.
 */
export default async function SettingsBudgetsPage() {
  const { orgRole } = getCurrentAuth()

  let convexOrgId = ''
  let budgets: BudgetRecord[] | null = null
  let budgetsError: string | null = null
  try {
    // Resolved for the create form: an org-scoped budget's `scopeId` must be
    // the organization's OWN Convex id, and Convex rejects anything else — for
    // the good reason that any other value would let a budget name another
    // tenant.
    const { orgId: clerkOrgId } = getCurrentAuth()
    convexOrgId = await resolveConvexOrgId(clerkOrgId)
    budgets = await listBudgets()
  } catch (err) {
    budgets = null
    budgetsError = err instanceof Error ? err.message : 'Failed to read budgets'
  }

  let snapshotRead: BreakerSnapshotRead
  try {
    snapshotRead = await readOrgBreakerSnapshot()
  } catch (err) {
    // A thrown query and a body that cannot be enforced on are the SAME
    // outcome for a reader — no trustworthy answer — so they land in the same
    // arm rather than one becoming an empty snapshot.
    snapshotRead = {
      kind: 'unreadable',
      refusals: [err instanceof Error ? err.message : 'the breaker evaluation request failed'],
    }
  }

  // Operational observability, admin-only, and DELIBERATELY the one read on
  // this page whose failure is silent: it says nothing about spend, so its
  // absence concludes nothing. The other two reads must never be treated this
  // way — see their comments above.
  const sweep = orgRole === 'admin' ? await readSweepPressure() : null

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="text-sm font-semibold text-whiteout">Breaker state</h2>
        <p className="mt-1.5 text-sm text-pewter leading-relaxed">
          Evaluated fresh on every read, for this organization. A breaker records what the meter shows and the SDK
          decides whether to proceed; neither this service nor the SDK can stop a process it does not control.
        </p>
        <div className="mt-3">
          <BreakerSnapshotPanel read={snapshotRead} />
        </div>

        {sweep !== null && (
          <div className="mt-4 rounded-[4px] border border-graphite bg-graphite-deep p-3">
            <p className="font-mono text-xs uppercase tracking-wider text-pewter">Sweep pressure</p>
            <p className="mt-1 text-sm text-cloud leading-relaxed">
              <span className="font-mono tabular-nums text-whiteout">{sweep.enabledInOrg}</span> enabled budgets in
              this organization, against a sweep batch of{' '}
              <span className="font-mono tabular-nums text-whiteout">{sweep.sweepBatchSize}</span> every{' '}
              <span className="font-mono tabular-nums text-whiteout">{sweep.sweepCadenceMs / 1000}s</span>.
            </p>
            {/* THE CAVEAT TRAVELS WITH THE NUMBER. The batch is GLOBAL across
                every organization, so this figure can show that an org is a
                large contributor to the pressure and can never show that the
                sweep is keeping up. */}
            <p className="mt-1.5 text-sm text-pewter leading-relaxed">
              The batch is global across every organization, so being well under it is evidence that this
              organization is not a large contributor — not proof that the sweep is keeping up. Falling behind
              affects {sweep.lagAffects.replace(/_/g, ' ')}: a breach nobody queried is recorded later than it
              happened. It does not make any breaker answer stale, because state is computed fresh on every read.
            </p>
          </div>
        )}
      </Card>

      <BudgetsSection budgets={budgets} loadError={budgetsError} orgRole={orgRole} orgId={convexOrgId} />
    </div>
  )
}
