import { Card } from '@/components/ui/Card'
import { type HealthData, getHealthData } from '@/lib/health'

export function SystemHealthPanel() {
  const health: HealthData = getHealthData()

  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">System Health</h2>
        {health && (
          <span
            className={
              health.status === 'ok'
                ? 'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border bg-success-900 text-success-400 border-success-700'
                : 'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border bg-warning-900 text-warning-400 border-warning-700'
            }
          >
            {health.status}
          </span>
        )}
      </div>

      <div className="px-5 py-4">
        {!health ? (
          <p className="text-sm text-neutral-500">Health check unavailable.</p>
        ) : (
          <dl className="flex flex-col gap-3">
            {/* Storage row */}
            <div className="flex items-center justify-between">
              <dt className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Storage
              </dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono text-xs text-neutral-300">{health.storage.adapter}</span>
                <span
                  className={
                    health.storage.configured
                      ? 'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border bg-success-900 text-success-400 border-success-700'
                      : 'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border bg-neutral-800 text-neutral-400 border-neutral-700'
                  }
                >
                  {health.storage.configured ? 'configured' : 'unconfigured'}
                </span>
              </dd>
            </div>

            {/* Projection row */}
            <div className="flex items-center justify-between">
              <dt className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Projection
              </dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono text-xs text-neutral-300">{health.projection.model}</span>
                <span className="text-xs text-pewter">always fresh from canonical events</span>
              </dd>
            </div>

            {/* Environment row */}
            <div className="flex items-center justify-between">
              <dt className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Environment
              </dt>
              <dd>
                <span className="font-mono text-xs text-neutral-400">{health.environment}</span>
              </dd>
            </div>

            {/* Timestamp row */}
            <div className="flex items-center justify-between border-t border-neutral-800 pt-3 mt-1">
              <dt className="text-xs font-medium text-pewter">Last checked</dt>
              <dd>
                <time className="font-mono text-xs text-pewter" dateTime={health.timestamp}>
                  {new Date(health.timestamp).toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  })}
                </time>
              </dd>
            </div>
          </dl>
        )}
      </div>
    </Card>
  )
}
