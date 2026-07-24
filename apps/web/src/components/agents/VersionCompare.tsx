'use client'

import { useState, useTransition } from 'react'

import type {
  VersionCompareResult,
  VersionCohortStats,
  VersionCompareNarrative,
} from '@/lib/services/agent_versions'
import type { AgentVersion } from '@agent-flight-recorder/contracts'

import { Card } from '@/components/ui/Card'
import { compareVersionsAction } from '@/lib/actions/agent_versions'

interface VersionCompareProps {
  versions: AgentVersion[]
}

const VERDICT_STYLE: Record<string, { label: string; className: string }> = {
  likely_regression: { label: 'Likely regression', className: 'bg-destructive-900 text-destructive-400 border-destructive-700' },
  likely_improvement: { label: 'Likely improvement', className: 'bg-success-900 text-success-400 border-success-700' },
  inconclusive: { label: 'Inconclusive', className: 'bg-graphite text-cloud border-graphite-light' },
  insufficient_data: { label: 'Insufficient data', className: 'bg-graphite text-pewter border-graphite-light' },
}

/** Tone for the plain-English "what changed" narrative — honest, not decorative:
    destructive for a real regression, neon only for a real improvement,
    neutral pewter for anything the data can't yet support a strong claim about. */
const NARRATIVE_STYLE: Record<VersionCompareNarrative['significance'], { label: string; textClassName: string }> = {
  likely_regression: { label: 'Likely regression', textClassName: 'text-destructive-400' },
  likely_improvement: { label: 'Likely improvement', textClassName: 'text-neon-glow' },
  inconclusive: { label: 'Inconclusive', textClassName: 'text-pewter' },
  insufficient_data: { label: 'Insufficient data', textClassName: 'text-pewter' },
}

function NarrativeCallout({ narrative }: { narrative: VersionCompareNarrative }) {
  const style = NARRATIVE_STYLE[narrative.significance] ?? NARRATIVE_STYLE.inconclusive
  return (
    <div className="rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
      <p className="text-xs font-mono uppercase tracking-wider text-pewter mb-1.5">
        What changed · <span className={style.textClassName}>{style.label}</span>
      </p>
      <p className="text-sm leading-relaxed text-whiteout">{narrative.narrative}</p>
    </div>
  )
}

function CohortCard({ label, stats }: { label: string; stats: VersionCohortStats }) {
  const total = Object.values(stats.countsByStatus).reduce((a, b) => a + b, 0)
  const failed = stats.countsByStatus['failed'] ?? 0
  const failureRate = total > 0 ? Math.round((failed / total) * 1000) / 10 : null
  return (
    <div className="flex-1 min-w-[200px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
      <p className="text-xs font-medium text-pewter uppercase tracking-wider">{label}</p>
      <p className="mt-1 font-mono text-sm text-whiteout">v{stats.version}</p>
      <dl className="mt-2 flex flex-col gap-1 text-xs font-mono">
        <div className="flex justify-between">
          <dt className="text-pewter">sample</dt>
          <dd className="text-cloud">{stats.sampleSize}{stats.truncated ? ' (sampled)' : ''}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-pewter">failure rate</dt>
          <dd className={failureRate && failureRate > 0 ? 'text-destructive-400' : 'text-cloud'}>
            {failureRate === null ? '—' : `${failureRate}%`}
          </dd>
        </div>
      </dl>
    </div>
  )
}

/**
 * Version comparison (cohort A/B) — pick two versions, show Team B's
 * insights.compareVersions cohort stats + significance verdict.
 */
export function VersionCompare({ versions }: VersionCompareProps) {
  const [versionAId, setVersionAId] = useState(versions[1]?.id ?? '')
  const [versionBId, setVersionBId] = useState(versions[0]?.id ?? '')
  const [result, setResult] = useState<VersionCompareResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (versions.length < 2) {
    return (
      <Card>
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">Compare versions</h2>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-neutral-500">
            Create a second version to compare cohorts.
          </p>
        </div>
      </Card>
    )
  }

  function handleCompare() {
    setError(null)
    if (versionAId === versionBId) {
      setError('Pick two different versions to compare')
      return
    }
    startTransition(async () => {
      const r = await compareVersionsAction(versionAId, versionBId)
      setResult(r)
    })
  }

  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">Compare versions</h2>
        <p className="mt-0.5 text-xs text-neutral-400">
          Cohort comparison over recent runs of each version.
        </p>
      </div>

      <div className="px-5 py-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-pewter">
            Version A
            <select
              value={versionAId}
              onChange={(e) => setVersionAId(e.target.value)}
              className="h-8 px-2 rounded-[4px] bg-graphite-deep border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>{v.version}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-pewter">
            Version B
            <select
              value={versionBId}
              onChange={(e) => setVersionBId(e.target.value)}
              className="h-8 px-2 rounded-[4px] bg-graphite-deep border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>{v.version}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={handleCompare}
            disabled={isPending}
            className="h-8 px-4 rounded-full bg-whiteout hover:bg-cloud text-graphite-deep text-sm font-medium transition-colors duration-150 disabled:opacity-50"
          >
            {isPending ? 'Comparing…' : 'Compare'}
          </button>
        </div>

        {error && <p className="text-xs text-destructive-400">{error}</p>}

        {result && !result.available && (
          <p className="text-sm text-neutral-500">
            Comparison data isn&#39;t available yet for one or both versions — there may not be enough runs recorded.
          </p>
        )}

        {result?.available && (
          <div className="flex flex-col gap-3">
            {result.narrative && <NarrativeCallout narrative={result.narrative} />}
            <div className="flex flex-wrap gap-3">
              <CohortCard label="Version A" stats={result.versionA} />
              <CohortCard label="Version B" stats={result.versionB} />
            </div>
            {(() => {
              const verdict = VERDICT_STYLE[result.comparison.verdict] ?? VERDICT_STYLE['inconclusive'] ?? {
                label: result.comparison.verdict,
                className: 'bg-graphite text-cloud border-graphite-light',
              }
              return (
                <span
                  className={`inline-flex self-start items-center px-2.5 py-1 rounded-[4px] text-xs font-mono font-medium border ${verdict.className}`}
                >
                  {verdict.label}
                </span>
              )
            })()}
          </div>
        )}
      </div>
    </Card>
  )
}
