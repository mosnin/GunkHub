import Link from 'next/link'

import type { AdaptedFailurePattern } from '@/components/patterns/adapt'

import { SpikeBadge } from '@/components/patterns/SpikeBadge'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { formatRelativeTime, truncateId } from '@/lib/utils'

interface PatternRowProps {
  pattern: AdaptedFailurePattern
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
export function PatternRow({ pattern }: PatternRowProps) {
  const href = `/patterns/${encodeURIComponent(pattern.fingerprintHash)}`
  const isSpiking = pattern.lastSpikeAssessment?.isSpiking === true

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
        <Link href={href} tabIndex={-1} aria-hidden className="inline-flex">
          <SpikeBadge isSpiking={isSpiking} assessed={pattern.hasSpikeAssessment} />
        </Link>
      </td>
    </tr>
  )
}
