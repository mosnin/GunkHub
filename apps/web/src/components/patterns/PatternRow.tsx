import Link from 'next/link'

import type { AdaptedFailurePattern, AdaptedFixConfidence } from '@/components/patterns/adapt'

import { isRegressedPattern } from '@/components/patterns/adapt'
import { FixConfidenceBadge } from '@/components/patterns/FixConfidenceBadge'
import { MutedBadge } from '@/components/patterns/MutedBadge'
import { PatternStatusBadge } from '@/components/patterns/PatternStatusBadge'
import { SpikeBadge } from '@/components/patterns/SpikeBadge'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { formatRelativeTime, truncateId } from '@/lib/utils'

interface PatternRowProps {
  pattern: AdaptedFailurePattern
  /**
   * Fix confidence for this row, when the caller has it.
   *
   * Rendered INSIDE the existing Status cell rather than as a new column, so
   * the table's column widths stay stable whether or not confidence is
   * available — a list that reflows depending on which rows happen to be
   * resolved is unscannable.
   *
   * `null`/absent means "not scored", which renders nothing at all. It must
   * never fall back to `unproven`: a pattern that was never resolved has no
   * fix to prove, and a row we simply haven't scored is not evidence of
   * anything. Post-resolution exposure is live-derived per pattern and is not
   * on the rollup, so the list only shows this where a caller supplies it.
   */
  confidence?: AdaptedFixConfidence | null
}

function formatFailureClass(cls: string): string {
  return cls.replace(/_/g, ' ')
}

/**
 * One row in the Patterns list. Keyboard nav follows the same convention as
 * SelectableRunList: the label is a real, focusable Link; other cells wrap a
 * `tabIndex={-1} aria-hidden` Link so clicking anywhere in the row navigates
 * without duplicating focus stops.
 */
export function PatternRow({ pattern, confidence }: PatternRowProps) {
  const href = `/patterns/${encodeURIComponent(pattern.fingerprintHash)}`
  const isSpiking = pattern.lastSpikeAssessment?.isSpiking === true
  const regressed = isRegressedPattern(pattern)

  return (
    <tr className="hover:bg-neutral-900 transition-colors duration-100 group border-b border-graphite last:border-b-0">
      <td className="px-4 py-3 max-w-[320px]">
        <Link
          href={href}
          className="block text-sm text-whiteout group-hover:text-neon-glow transition-colors duration-100 truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow rounded-[4px]"
          title={pattern.label}
        >
          {pattern.label}
        </Link>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-xs font-mono text-pewter truncate" title={pattern.fingerprintHash}>
            {truncateId(pattern.fingerprintHash, 12)}
          </span>
          <CopyToClipboardButton
            value={pattern.fingerprintHash}
            label="Copy fingerprint hash"
            className="opacity-0 group-hover:opacity-100 focus:opacity-100"
          />
        </div>
      </td>
      <td className="px-4 py-3">
        <Link href={href} tabIndex={-1} aria-hidden>
          <span className="inline-flex items-center px-2 py-0.5 rounded-[4px] text-xs font-mono font-medium border bg-graphite text-cloud border-graphite-light whitespace-nowrap">
            {formatFailureClass(pattern.class)}
          </span>
        </Link>
      </td>
      <td className="px-4 py-3 text-right">
        <Link href={href} tabIndex={-1} aria-hidden className="font-mono text-sm text-neutral-200">
          {pattern.count.toLocaleString()}
        </Link>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <Link href={href} tabIndex={-1} aria-hidden className="font-mono text-xs text-neutral-400" title={new Date(pattern.firstSeenAt).toISOString()}>
          {formatRelativeTime(pattern.firstSeenAt)}
        </Link>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <Link href={href} tabIndex={-1} aria-hidden className="font-mono text-xs text-neutral-300" title={new Date(pattern.lastSeenAt).toISOString()}>
          {formatRelativeTime(pattern.lastSeenAt)}
        </Link>
      </td>
      <td className="px-4 py-3 text-right">
        <Link href={href} tabIndex={-1} aria-hidden className="font-mono text-sm text-neutral-300">
          {pattern.hasAffectedVersions ? pattern.affectedAgentVersionIds.length.toLocaleString() : '—'}
        </Link>
      </td>
      <td className="px-4 py-3">
        <Link href={href} tabIndex={-1} aria-hidden className="inline-flex items-center gap-1.5 flex-wrap">
          <PatternStatusBadge status={pattern.status} regressed={regressed} />
          {/* A resolved row and a PROVEN resolved row must not read the same.
              Suppressed on regressed rows, where the status badge already
              says it louder and two pulsing badges would be noise. */}
          {confidence && !regressed && <FixConfidenceBadge state={confidence.state} compact />}
        </Link>
      </td>
      <td className="px-4 py-3">
        <Link href={href} tabIndex={-1} aria-hidden className="inline-flex items-center gap-1.5">
          <SpikeBadge isSpiking={isSpiking} assessed={pattern.hasSpikeAssessment} mutedAlerts={pattern.muted} />
          {pattern.muted && !isSpiking && <MutedBadge mutedAt={pattern.mutedAt} />}
        </Link>
      </td>
    </tr>
  )
}
