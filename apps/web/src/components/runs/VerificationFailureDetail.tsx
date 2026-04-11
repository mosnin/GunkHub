import type { VerificationStatus } from '@/lib/services/projection_verify'

interface VerificationFailureDetailProps {
  status: VerificationStatus
}

interface FailureIssue {
  title: string
  detail: string
  hint: string
}

function buildIssues(status: VerificationStatus): FailureIssue[] {
  const issues: FailureIssue[] = []

  if (status.sequenceGaps.length > 0) {
    const shown = status.sequenceGaps.slice(0, 5).join(', ')
    const suffix = status.sequenceGaps.length > 5 ? ', …' : ''
    issues.push({
      title: `${status.sequenceGaps.length} sequence gap${status.sequenceGaps.length === 1 ? '' : 's'}`,
      detail: `Missing sequence numbers: ${shown}${suffix}`,
      hint: 'Check SDK ingest logs for dropped or failed event submissions.',
    })
  }

  if (status.duplicateSeqNums.length > 0) {
    const shown = status.duplicateSeqNums.slice(0, 5).join(', ')
    const suffix = status.duplicateSeqNums.length > 5 ? ', …' : ''
    issues.push({
      title: `${status.duplicateSeqNums.length} duplicate sequence number${status.duplicateSeqNums.length === 1 ? '' : 's'}`,
      detail: `Duplicated at: ${shown}${suffix}`,
      hint: 'Check SDK retry logic and idempotency handling in sendEvents().',
    })
  }

  if (status.replayPassed === false) {
    issues.push({
      title: 'Replay projection failed',
      detail: 'buildReplayProjection threw or produced an inconsistent result for this run.',
      hint: 'Run scripts/rebuild-projection.ts against this run ID to inspect the error.',
    })
  }

  if (status.failureSummaryPassed === false) {
    issues.push({
      title: 'Failure summary derivation failed',
      detail: 'buildFailureSummary threw or returned an unexpected result.',
      hint: 'Inspect the RUN_FAILED event payload for this run — the error field may be malformed.',
    })
  }

  return issues
}

export function VerificationFailureDetail({ status }: VerificationFailureDetailProps) {
  const issues = buildIssues(status)
  if (issues.length === 0) return null

  return (
    <div className="mt-3 space-y-2">
      {issues.map((issue, i) => (
        <div key={i} className="border-l-2 border-red-900 pl-3 py-1">
          <p className="text-xs font-medium text-red-400">{issue.title}</p>
          <p className="text-xs text-neutral-500 mt-0.5">{issue.detail}</p>
          <p className="text-xs text-neutral-600 mt-0.5">{issue.hint}</p>
        </div>
      ))}
    </div>
  )
}

export { buildIssues }
export type { FailureIssue }
