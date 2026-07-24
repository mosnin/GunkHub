'use client'

import { useState, useTransition } from 'react'

import type { VerificationStatus } from '@/lib/services/projection_verify'

import { IntegrityBadge } from '@/components/runs/IntegrityBadge'
import { VerificationFailureDetail } from '@/components/runs/VerificationFailureDetail'
import { reverifyRunAction } from '@/lib/actions/verification'
import { formatRelativeTime } from '@/lib/utils'

interface VerificationPanelProps {
  runId: string
  initialStatus: VerificationStatus | null
  isTerminal: boolean
}

const UNVERIFIED_STATUS: VerificationStatus = {
  verified: false,
  isValid: null,
  verifiedAt: null,
  summary: null,
  sequenceGaps: [],
  duplicateSeqNums: [],
  checksRan: [],
  replayPassed: null,
  failureSummaryPassed: null,
}

interface CheckPillProps {
  label: string
  ran: boolean
  passed: boolean | null
}

function CheckPill({ label, ran, passed }: CheckPillProps) {
  if (!ran) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono text-pewter border border-neutral-800">
        <span className="w-1.5 h-1.5 rounded-full bg-neutral-800" aria-hidden="true" />
        {label}
        {/* Was text-neutral-800 — Graphite used as TEXT, 1.38:1 on Blackout.
            That is not "dim", it is invisible, and "skipped" is content: it is
            the whole reason this badge renders. Ash is the dimmest token that
            still clears AA on Blackout (5.09:1), so it stays quieter than the
            Pewter label beside it without disappearing. */}
        <span className="text-ash">skipped</span>
      </span>
    )
  }
  if (passed) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono text-neutral-500 border border-neutral-800">
        <span className="w-1.5 h-1.5 rounded-full bg-neon-glow" aria-hidden="true" />
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono text-destructive-500 border border-destructive-700">
      <span className="w-1.5 h-1.5 rounded-full bg-destructive-500" aria-hidden="true" />
      {label}
      <span className="text-destructive-500">failed</span>
    </span>
  )
}

export function VerificationPanel({ runId, initialStatus, isTerminal }: VerificationPanelProps) {
  const [status, setStatus] = useState<VerificationStatus>(
    initialStatus ?? UNVERIFIED_STATUS,
  )
  const [reverifyError, setReverifyError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (!isTerminal) return null

  function handleReverify() {
    setReverifyError(null)
    startTransition(async () => {
      const result = await reverifyRunAction(runId)
      if (result.error) {
        setReverifyError(result.error)
      } else if (result.status) {
        setStatus(result.status)
      }
    })
  }

  const isPartial = status.verified && !status.checksRan.includes('replay')
  const seqPassed = status.verified
    ? status.sequenceGaps.length === 0 && status.duplicateSeqNums.length === 0
    : null

  return (
    <div className="px-6 py-3 border-b border-neutral-800 bg-neutral-950">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-xs text-pewter font-mono uppercase tracking-wider">
          Integrity
        </span>

        <IntegrityBadge status={status} />

        {status.verifiedAt && (
          <span className="text-xs text-pewter">
            verified {formatRelativeTime(status.verifiedAt)}
          </span>
        )}

        {/* Check pills */}
        {status.verified && (
          <div className="flex items-center gap-1.5">
            <CheckPill
              label="sequence"
              ran={true}
              passed={seqPassed}
            />
            <CheckPill
              label="replay"
              ran={status.checksRan.includes('replay')}
              passed={status.replayPassed}
            />
            <CheckPill
              label="failureSummary"
              ran={status.checksRan.includes('failureSummary')}
              passed={status.failureSummaryPassed}
            />
          </div>
        )}

        {/* Re-verify button */}
        <button
          type="button"
          onClick={handleReverify}
          disabled={isPending}
          className="ml-auto text-xs font-mono text-pewter hover:text-cloud disabled:text-pewter transition-colors border border-neutral-800 hover:border-neutral-700 disabled:border-neutral-800 px-2 py-0.5 rounded"
        >
          {isPending ? 'Verifying…' : 'Re-verify'}
        </button>
      </div>

      {/* Partial verification notice */}
      {isPartial && (
        <p className="mt-1.5 text-xs text-pewter">
          Partial — sequence checked only. Full derivation requires{' '}
          <span className="font-mono">INTERNAL_VERIFY_URL</span> to be configured.
        </p>
      )}

      {/* Error feedback */}
      {reverifyError && (
        <p className="mt-1.5 text-xs text-destructive-500 font-mono">{reverifyError}</p>
      )}

      {/* Failure detail — shown when verification found issues */}
      {status.verified && !status.isValid && (
        <VerificationFailureDetail status={status} />
      )}
    </div>
  )
}
