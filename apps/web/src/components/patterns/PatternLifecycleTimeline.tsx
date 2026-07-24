import type { PatternLifecycleTransition } from '@agent-flight-recorder/contracts'

import { cn, formatRelativeTime, truncateId } from '@/lib/utils'

interface PatternLifecycleTimelineProps {
  /** Oldest-first, as returned by `getPatternResolutionEvidence`. */
  transitions: PatternLifecycleTransition[]
  /** Rendered as the implicit first node — a pattern's life starts when it was first seen, which is not an audited transition. */
  firstSeenAt?: number
  /** Version string for the resolution, annotated onto the `resolved` node so "resolved in which version" is answered inline. */
  resolvedInVersion?: string
  className?: string
}

/**
 * The debugging artifact: first seen → acknowledged → resolved (in which
 * version) → regressed → resolved again, scannable top-to-bottom.
 *
 * Reconstructed from the append-only audit log, so it is a projection over
 * immutable facts rather than a mutable history table — and it therefore
 * includes the transitions no human performed. `failure_pattern.regressed` is
 * the regression guard's AUTOMATIC reopen, recorded under the literal "system"
 * actor; it is the one node that gets emphasis, because "your fix didn't hold"
 * is the fact an engineer is scanning this column to find.
 *
 * Density follows the rest of the product: one line per event, timestamp and
 * actor in mono, no card chrome per row. The rail is a 1px graphite line with
 * a node per transition — depth from layered near-black surfaces, never a
 * shadow.
 */
const ACTION_LABEL: Record<string, string> = {
  'failure_pattern.acknowledged': 'Acknowledged',
  'failure_pattern.resolved': 'Resolved',
  'failure_pattern.reopened': 'Reopened manually',
  'failure_pattern.regressed': 'Regressed — fix did not hold',
  'failure_pattern.muted': 'Alerts muted',
  'failure_pattern.unmuted': 'Alerts unmuted',
}

/** Strips the `failure_pattern.` namespace for any action this UI doesn't have bespoke copy for, rather than rendering a raw audit key. */
function labelFor(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/^failure_pattern\./, '').replace(/_/g, ' ')
}

function isRegressionNode(action: string): boolean {
  return action === 'failure_pattern.regressed'
}

const SYSTEM_ACTOR = 'system'

function actorLabel(actorClerkUserId: string): string {
  if (actorClerkUserId === SYSTEM_ACTOR) return 'system'
  return actorClerkUserId ? truncateId(actorClerkUserId, 12) : 'unknown actor'
}

export function PatternLifecycleTimeline({
  transitions,
  firstSeenAt,
  resolvedInVersion,
  className,
}: PatternLifecycleTimelineProps) {
  if (transitions.length === 0 && typeof firstSeenAt !== 'number') {
    return <p className="text-sm text-pewter">No lifecycle history has been recorded for this pattern yet.</p>
  }

  // Only the LAST resolution carries the version annotation — annotating every
  // historical `resolved` node with the current version would attribute a
  // later fix to an earlier, failed attempt.
  const lastResolvedIndex = transitions.reduce(
    (acc, t, i) => (t.action === 'failure_pattern.resolved' ? i : acc),
    -1,
  )

  return (
    <ol aria-label="Lifecycle history for this failure pattern" className={cn('flex flex-col', className)}>
      {typeof firstSeenAt === 'number' && (
        <li className="relative pl-5 pb-3">
          <span className="absolute left-0 top-[7px] w-1.5 h-1.5 rounded-full bg-neutral-600" aria-hidden="true" />
          {transitions.length > 0 && (
            <span className="absolute left-[2.5px] top-[13px] bottom-0 w-px bg-graphite-light" aria-hidden="true" />
          )}
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <span className="text-sm text-neutral-300">First seen</span>
            <time
              className="font-mono text-xs text-pewter"
              dateTime={new Date(firstSeenAt).toISOString()}
              title={new Date(firstSeenAt).toISOString()}
            >
              {formatRelativeTime(firstSeenAt)}
            </time>
          </div>
        </li>
      )}

      {transitions.map((t, i) => {
        const regression = isRegressionNode(t.action)
        const isLast = i === transitions.length - 1
        return (
          <li key={`${t.action}-${t.timestamp}-${i}`} className={cn('relative pl-5', isLast ? 'pb-0' : 'pb-3')}>
            <span
              className={cn(
                'absolute left-0 top-[7px] w-1.5 h-1.5 rounded-full',
                regression
                  ? 'bg-neon-glow shadow-[var(--shadow-glow)] motion-safe:animate-neon-pulse forced-colors:bg-[Highlight]'
                  : 'bg-neutral-600',
              )}
              aria-hidden="true"
            />
            {!isLast && (
              <span className="absolute left-[2.5px] top-[13px] bottom-0 w-px bg-graphite-light" aria-hidden="true" />
            )}
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className={cn('text-sm', regression ? 'text-neon-glow font-medium' : 'text-neutral-300')}>
                {labelFor(t.action)}
              </span>
              <time
                className="font-mono text-xs text-pewter"
                dateTime={new Date(t.timestamp).toISOString()}
                title={new Date(t.timestamp).toISOString()}
              >
                {formatRelativeTime(t.timestamp)}
              </time>
            </div>
            <p className="text-xs text-pewter font-mono mt-0.5">
              <span className="sr-only">by </span>
              {actorLabel(t.actorClerkUserId)}
              {i === lastResolvedIndex && resolvedInVersion && (
                <span className="text-cloud"> · in {resolvedInVersion}</span>
              )}
            </p>
          </li>
        )
      })}
    </ol>
  )
}
