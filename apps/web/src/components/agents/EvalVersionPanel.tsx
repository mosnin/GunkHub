import type { EvalVersionRollup } from '@/lib/services/evals'

import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

interface EvalVersionPanelProps {
  version: string
  evalRules: Record<string, unknown>[]
  rollup: EvalVersionRollup
}

/** Render one eval rule generically — `kind` first, then its remaining fields as key: value. */
function RuleRow({ rule }: { rule: Record<string, unknown> }) {
  const { kind, ...rest } = rule
  return (
    <div className="px-3 py-2 rounded-[4px] border border-graphite bg-graphite-deep">
      <span className="text-xs font-mono font-medium text-whiteout">{String(kind ?? 'unknown')}</span>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
        {Object.entries(rest).map(([k, v]) => (
          <div key={k} className="flex gap-1 text-xs font-mono">
            <dt className="text-pewter">{k}:</dt>
            <dd className="text-cloud break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * Agent-version Evals section — read-only display of the version's
 * configured evalRules (editing is a future cycle) plus the eval pass-rate
 * rollup from Team B's insights.listEvalsForVersion.
 */
export function EvalVersionPanel({ version, evalRules, rollup }: EvalVersionPanelProps) {
  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">Evals — v{version}</h2>
        <p className="mt-0.5 text-xs text-neutral-400">
          Configured eval rules (read-only) and the recent pass-rate rollup.
        </p>
      </div>

      <div className="px-5 py-4 flex flex-col gap-5">
        <div>
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
            Configured rules
          </h3>
          {evalRules.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No eval rules configured on this version. Evals can still be recorded manually via the API.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {evalRules.map((rule, i) => (
                // Rules have no stable id — keyed by kind + position, which is
                // stable enough since this is a static, read-only display.
                <RuleRow key={`${String(rule.kind ?? 'rule')}-${String(i)}`} rule={rule} />
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
            Pass rate
          </h3>
          {!rollup.available ? (
            <EmptyState
              title="No eval rollup available yet"
              description="This fills in once evals have been recorded against runs of this version."
            />
          ) : rollup.sampleSize === 0 ? (
            <p className="text-sm text-neutral-500">No evals recorded against this version yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <dl className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-[100px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
                  <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Pass rate</dt>
                  <dd className={`mt-1 font-mono text-xl tabular-nums ${rollup.passRate >= 0.9 ? 'text-neon-glow' : rollup.passRate < 0.5 ? 'text-destructive-500' : 'text-whiteout'}`}>
                    {(rollup.passRate * 100).toFixed(1)}%
                  </dd>
                </div>
                <div className="flex-1 min-w-[100px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
                  <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Passed</dt>
                  <dd className="mt-1 font-mono text-xl text-whiteout tabular-nums">{rollup.passed}</dd>
                </div>
                <div className="flex-1 min-w-[100px] rounded-[4px] border border-graphite bg-graphite-deep px-4 py-3">
                  <dt className="text-xs font-medium text-pewter uppercase tracking-wider">Failed</dt>
                  <dd className="mt-1 font-mono text-xl text-destructive-500 tabular-nums">{rollup.failed}</dd>
                </div>
              </dl>

              {rollup.truncated && (
                <p className="text-xs text-pewter">Based on a bounded sample, not the full history.</p>
              )}

              {rollup.recentFailures.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-medium text-pewter uppercase tracking-wider">Recent failures</p>
                  {rollup.recentFailures.map((f) => (
                    <a
                      key={f.evalId}
                      href={`/runs/${f.runId}`}
                      className="flex items-center gap-2 px-3 py-2 rounded-[4px] border border-graphite bg-graphite-deep hover:bg-graphite transition-colors duration-100 text-xs"
                    >
                      <span className="text-whiteout font-medium">{f.name}</span>
                      <span className="text-pewter font-mono">{f.kind}</span>
                      {f.details && <span className="text-ash truncate flex-1">{f.details}</span>}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
