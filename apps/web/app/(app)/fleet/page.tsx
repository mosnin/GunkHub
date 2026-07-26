/**
 * /fleet — the screen an operator opens DURING an incident.
 *
 * ===========================================================================
 * THE FRAMING THAT DRIVES EVERY DECISION ON THIS PAGE
 * ===========================================================================
 *
 * This is not a dashboard someone browses on a Tuesday. It is what someone
 * opens when something is wrong across many agents and they need to know
 * WHAT, HOW BAD, and WHAT IS SHARED — in seconds, under stress. Three
 * consequences follow, and each is implemented rather than merely intended:
 *
 *   RANKED BY BREADTH, NOT RECENCY. The newest cluster is usually a downstream
 *   symptom — retries piling up, a queue draining into a second agent — while
 *   the broadest is usually nearest whatever actually changed.
 *   `rankFleetCorrelations` (contracts) makes recency a tiebreak only.
 *
 *   WHAT IS SHARED LEADS. The widest column holds `observedFact`, the engine's
 *   own past-tense sentence about what was recorded. Nine agent rows are raw
 *   material; "nine agents recorded failures matching fingerprint 9f3c between
 *   14:03 and 14:31" is the answer.
 *
 *   TIME IS A FIRST-CLASS AXIS. Every row carries where it sits inside the
 *   scan window and how wide it is. A count cannot express any of that.
 *
 * And the rule that outranks all three: an OBSERVED CORRELATION, a
 * HYPOTHESISED CAUSE and an UNANSWERED QUESTION never share a treatment. The
 * contract makes the three non-unifiable; `@/components/fleet/EvidenceMarker`
 * and `@/components/fleet/HypothesisList` carry that separation on screen
 * through five non-colour channels.
 *
 * A hypothesis is subordinate by construction: it has no blast radius, is
 * never ranked, and cannot move the verdict — `FleetHealthVerdictInput` has no
 * slot for one. And it always renders its DENOMINATOR: an unmeasured base rate
 * (`null`, which is the opposite of `0`) is reported as having no denominator
 * rather than as weak support.
 *
 * ---------------------------------------------------------------------------
 * STATES
 * ---------------------------------------------------------------------------
 *
 * Loading is `loading.tsx`. The rest are explicit and distinct: findings;
 * "nothing correlated and nothing failing" (an earned, scoped all-clear);
 * "agents failing, nothing connects them" (neither of the above); "scan did
 * not finish" (not an answer at all, and the most likely outcome during a real
 * incident); and "scan failed". No blank screens, and no two share copy.
 *
 * Auth: `(app)/layout.tsx` redirects unauthenticated users to /sign-in, and
 * every Convex query behind the service layer is org-scoped and membership-
 * gated server-side (CLAUDE.md Tenancy Rules). This page adds no client-side
 * route guard.
 */

import type { Metadata } from 'next'

import { FleetIncidentView } from '@/components/fleet/FleetIncidentView'
import { FleetScanFailed } from '@/components/fleet/FleetStates'
import { WindowPicker } from '@/components/fleet/WindowPicker'
import { PageHeader } from '@/components/layout/PageHeader'
import { fleetHref, neighbourWindow, resolveFleetWindow } from '@/lib/fleet/window'
import { getFleetHealth } from '@/lib/services/fleet'

export const metadata: Metadata = { title: 'Fleet' }

// The window is read from the URL on every request, so this page can never be
// statically cached into a stale incident view.
export const dynamic = 'force-dynamic'

interface FleetPageProps {
  searchParams: { window?: string; at?: string; cursor?: string }
}

export default async function FleetPage({ searchParams }: FleetPageProps) {
  const window = resolveFleetWindow(searchParams, Date.now())
  const result = await getFleetHealth(window)

  // Neighbouring windows, so "found nothing" and "scan truncated" can each
  // offer the move that actually helps: widen when the window may be too
  // narrow to contain the burst, narrow when the scan could not fit its budget.
  const wider = neighbourWindow(window.option, 1)
  const narrower = neighbourWindow(window.option, -1)
  const at = window.pinned ? window.endedAt : null

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Fleet"
        subtitle="Failures happening across more than one agent at once — ranked by how many agents each one is hitting."
      />

      <div className="mt-4 flex flex-col gap-4">
        <WindowPicker window={window} />

        {result.status === 'error' ? (
          <FleetScanFailed
            message={result.message}
            retryHref={fleetHref({ window: window.option.id, at })}
          />
        ) : (
          <FleetIncidentView
            report={result.report}
            widenHref={fleetHref({ window: wider.id, at })}
            widenLabel={wider.label}
            narrowHref={fleetHref({ window: narrower.id, at })}
            narrowLabel={narrower.label}
            {...(result.report.scan.nextCursor !== undefined && {
              continueHref: fleetHref({
                window: window.option.id,
                at,
                cursor: result.report.scan.nextCursor,
              }),
            })}
          />
        )}
      </div>
    </div>
  )
}
