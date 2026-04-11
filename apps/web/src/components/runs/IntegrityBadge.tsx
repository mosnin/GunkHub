import type { VerificationStatus } from '@/lib/services/projection_verify'

interface IntegrityBadgeProps {
  status: VerificationStatus
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (days >= 2) return `${days}d ago`
  if (hours >= 1) return `${hours}h ago`
  return 'just now'
}

export function IntegrityBadge({ status }: IntegrityBadgeProps) {
  if (!status.verified) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono text-neutral-600 border border-neutral-800"
        title="Projection integrity not yet verified"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-neutral-700" aria-hidden="true" />
        unverified
      </span>
    )
  }

  const when = status.verifiedAt ? relativeTime(status.verifiedAt) : ''
  const title = status.summary ?? ''

  if (status.isValid) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono text-emerald-700 border border-emerald-900"
        title={`Integrity verified ${when}: ${title}`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" aria-hidden="true" />
        verified
      </span>
    )
  }

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono text-red-500 border border-red-900"
      title={`Integrity check failed ${when}: ${title}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-red-600" aria-hidden="true" />
      check failed
    </span>
  )
}
