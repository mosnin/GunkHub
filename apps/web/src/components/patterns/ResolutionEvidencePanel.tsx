import type { AdaptedFailurePattern, AdaptedResolutionEvidence } from '@/components/patterns/adapt'

import { FixConfidenceBadge } from '@/components/patterns/FixConfidenceBadge'
import { FixConfidenceMeter } from '@/components/patterns/FixConfidenceMeter'
import { PatternLifecycleTimeline } from '@/components/patterns/PatternLifecycleTimeline'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { formatRelativeTime } from '@/lib/utils'

/**
 * Every state this panel can be in, explicitly. There is no implicit fourth
 * case that renders nothing: a resolved pattern whose evidence failed to load
 * must say so, because silence here reads as "nothing to report", which is
 * indistinguishable from "the fix held" — the exact confusion this feature
 * exists to remove.
 */
export type ResolutionEvidenceState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      evidence: AdaptedResolutionEvidence
      /** Human-readable version string for the resolution's `resolvedInVersionId`, resolved by the page. */
      resolvedInVersion?: string
    }

interface ResolutionEvidencePanelProps {
  pattern: AdaptedFailurePattern
  state: ResolutionEvidenceState
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="pattern-evidence-heading"
      className="rounded-[4px] border border-graphite-light bg-graphite-deep px-5 py-4"
    >
      <h2 id="pattern-evidence-heading" className="text-xs font-mono uppercase tracking-wider text-pewter mb-3">
        Did the fix hold?
      </h2>
      {children}
    </section>
  )
}

/**
 * The answer to "did the fix hold?", rendered as evidence rather than as a
 * claim.
 *
 * The distinction this panel exists to make: "resolved 3 days ago, zero runs
 * since" and "resolved, 400 runs since, no recurrence" are completely
 * different facts, and cycle 1 rendered them identically. Here the first is
 * ASSERTED (greyscale, explicitly untested) and the second is PROVEN (the
 * accent treatment, with the run count stated as the reason).
 *
 * Two lifecycle cases that look similar and are not, handled distinctly:
 *
 *  - AUTO-REOPEN (regression): the guard keeps `resolvedAt` so the "it didn't
 *    hold" evidence stays computable. So `status === 'open'` arrives WITH a
 *    live resolution and real exposure. This is the emotional core — it gets
 *    the alert banner and the full evidence.
 *  - MANUAL REOPEN: `reopenPattern` clears `resolvedAt`, so resolution and
 *    exposure are both null. There is no fix to evidence; the panel says the
 *    prior claim was withdrawn rather than showing an empty score.
 */
export function ResolutionEvidencePanel({ pattern, state }: ResolutionEvidencePanelProps) {
  if (state.kind === 'loading') {
    return (
      <Shell>
        <LoadingState message="Checking whether this fix held…" />
      </Shell>
    )
  }

  if (state.kind === 'error') {
    return (
      <Shell>
        <ErrorState title="Couldn't load resolution evidence" message={state.message} />
      </Shell>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <Shell>
        <p className="text-sm text-neutral-500 leading-relaxed">
          Resolution evidence isn&apos;t available for this pattern yet. Until it is, a resolution here is an
          unverified assertion — treat it as a claim, not a proven fix.
        </p>
      </Shell>
    )
  }

  const { evidence, resolvedInVersion } = state
  const { resolution, exposure, confidence, transitions } = evidence

  // No live resolution: either never resolved, or manually reopened (which
  // clears `resolvedAt`). These are different facts and read differently.
  if (resolution === null) {
    const withdrawn = transitions.some((t) => t.action === 'failure_pattern.reopened')
    return (
      <Shell>
        <p className="text-sm text-neutral-500 leading-relaxed">
          {withdrawn
            ? 'This pattern was reopened manually, which withdrew the previous resolution. There is no active fix to evidence — the earlier claim no longer stands.'
            : 'This pattern has never been resolved, so there is no fix to prove. This is not an unproven fix; it is the absence of one.'}
        </p>
        {transitions.length > 0 && (
          <div className="mt-4 pt-4 border-t border-graphite">
            <p className="text-xs font-mono uppercase tracking-wider text-pewter mb-3">Lifecycle</p>
            <PatternLifecycleTimeline transitions={transitions} firstSeenAt={pattern.firstSeenAt} />
          </div>
        )}
      </Shell>
    )
  }

  // `heldSoFar: true` with `runCount: 0` is UNTESTED, not fixed. It must never
  // render as success on its own — this is the sentence that separates an
  // asserted resolution from a proven one.
  const untested = exposure !== null && exposure.runCount === 0
  const runsSince =
    exposure === null
      ? null
      : exposure.runCountTruncated
        ? `${exposure.runCount.toLocaleString()}+`
        : exposure.runCount.toLocaleString()

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        {/* The headline fact, in one scannable sentence. Always names the
            exposure, because the exposure is what makes "it held" mean
            anything at all. */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <p className="text-sm text-whiteout leading-relaxed max-w-xl">
            Resolved {formatRelativeTime(resolution.resolvedAt)}
            {resolvedInVersion && <span className="font-mono text-cloud"> in {resolvedInVersion}</span>}
            {exposure === null ? (
              <span className="text-pewter"> — exposure since the fix has not been measured.</span>
            ) : untested ? (
              <>
                {' '}
                — <span className="text-pewter">no runs since</span>. This fix is{' '}
                <span className="font-medium">untested, not proven</span>: nothing has exercised it, so &ldquo;it
                hasn&apos;t come back&rdquo; is not yet evidence of anything.
              </>
            ) : exposure.recurrenceCount > 0 ? (
              <>
                {' '}
                — but it failed again{' '}
                <span className="font-mono text-neon-glow">
                  {exposure.recurrenceCount.toLocaleString()}
                  {exposure.recurrenceCount === 1 ? ' time' : ' times'}
                </span>{' '}
                across <span className="font-mono">{runsSince}</span> runs since.
              </>
            ) : (
              <>
                {' '}
                — <span className="font-mono text-whiteout">{runsSince}</span> runs since, with no recurrence.
              </>
            )}
          </p>
          {confidence && <FixConfidenceBadge state={confidence.state} compact />}
        </div>

        {/* The inspectable score. Absent when the service hasn't scored this
            pattern — in which case the raw evidence above still stands on its
            own and we say plainly that no score exists, rather than implying
            one of zero. */}
        <div className="pt-4 border-t border-graphite">
          {confidence ? (
            <FixConfidenceMeter
              confidence={confidence}
              exposure={exposure}
              {...(resolvedInVersion !== undefined && { resolvedInVersion })}
            />
          ) : (
            <p className="text-sm text-neutral-500 leading-relaxed">
              No confidence score has been computed for this resolution. The exposure figures above are the evidence;
              read them directly rather than inferring a verdict.
            </p>
          )}
        </div>

        {/* The lifecycle artifact. */}
        <div className="pt-4 border-t border-graphite">
          <p className="text-xs font-mono uppercase tracking-wider text-pewter mb-3">Lifecycle</p>
          <PatternLifecycleTimeline
            transitions={transitions}
            firstSeenAt={pattern.firstSeenAt}
            {...(resolvedInVersion !== undefined && { resolvedInVersion })}
          />
        </div>
      </div>
    </Shell>
  )
}
