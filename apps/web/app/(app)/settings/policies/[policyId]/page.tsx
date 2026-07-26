import Link from 'next/link'

import type { Metadata } from 'next'

import { PolicyEvaluationPanel } from '@/components/policies/PolicyEvaluationView'
import { ErrorState } from '@/components/ui/ErrorState'
import { getCurrentAuth } from '@/lib/auth'
import { scanRunsAgainstPolicy, type PolicyEvaluationRead } from '@/lib/services/policies'

export const metadata: Metadata = { title: 'Policy evaluation — Settings' }

/**
 * /settings/policies/[policyId] — ONE policy, evaluated across recorded runs.
 *
 * ===========================================================================
 * DERIVED, NEVER STORED (CLAUDE.md Event Log Rule 2)
 * ===========================================================================
 *
 * This page recomputes the evaluation on every load, from the policies table and
 * the event log, and writes nothing back. A stored compliance result is one that
 * keeps being true after the log it summarised has changed — which is the exact
 * shape of a report somebody quotes six months after the run it describes was
 * purged under retention.
 *
 * ===========================================================================
 * THE SCAN IS BOUNDED, AND ITS BOUNDS ARE PART OF THE RESULT
 * ===========================================================================
 *
 * `convex/policies.ts`'s `scanRunsAgainstPolicy` reads one page of runs and
 * emits an EXPLICIT finding for every run it did not reach, naming the run. That
 * is deliberate on their side and honoured here: a run missing from a compliance
 * report reads as a run with nothing to report, so the not-evaluable cards for
 * unopened runs are rendered exactly like the rest rather than filtered out as
 * noise.
 *
 * A FAILED READ IS RENDERED AS A FAILURE. It is never converted into an empty
 * evaluation, because an empty compliance report and a clean one are
 * indistinguishable to whoever reads the screenshot next.
 */
export default async function PolicyEvaluationPage({
  params,
}: {
  params: { policyId: string }
}) {
  getCurrentAuth()

  let read: PolicyEvaluationRead
  try {
    read = await scanRunsAgainstPolicy(params.policyId)
  } catch (err) {
    read = {
      kind: 'unreadable',
      because:
        (err instanceof Error ? err.message : 'the evaluation request failed') +
        ' — nothing was checked. This is not a statement that nothing was found.',
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-sm font-semibold text-whiteout">Policy evaluation</h1>
        <code className="text-xs font-mono text-pewter">{params.policyId}</code>
        <Link
          href="/settings/policies"
          className="text-xs font-mono text-cloud underline underline-offset-2"
        >
          all policies
        </Link>
      </header>

      <p className="text-sm text-cloud leading-relaxed">
        Computed now, from this policy and the recorded event log. Nothing on this page is stored: a compliance
        result written down keeps being true after the log it summarised has changed.
      </p>

      {read.kind === 'unreadable' ? (
        <ErrorState title="The evaluation could not be read" message={read.because} />
      ) : (
        <PolicyEvaluationPanel
          evaluation={read.evaluation}
          scopeLabel={`policy ${params.policyId}, over one page of recorded runs`}
        />
      )}
    </div>
  )
}
