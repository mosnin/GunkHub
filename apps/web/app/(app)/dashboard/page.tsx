import type { Run } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { RunList } from '@/components/runs/RunList'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { ErrorState } from '@/components/ui/ErrorState'
import { listRuns } from '@/lib/services/runs'

export const metadata: Metadata = { title: 'Dashboard' }

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="px-4 py-4">
        <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</p>
        <p className="mt-1.5 text-2xl font-semibold text-neutral-100 font-mono">{value}</p>
      </div>
    </Card>
  )
}

const SDK_INSTALL = `npm install @agent-flight-recorder/sdk`

export default async function DashboardPage() {
  let runs: Run[] = []
  let error: string | null = null

  try {
    const result = await listRuns({ limit: 20 })
    runs = result.runs
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load runs'
  }

  const totalRuns = runs.length
  const failedRuns = runs.filter((r) => r.status === 'failed').length
  const activeRuns = runs.filter((r) => r.status === 'running').length
  const hasRuns = totalRuns > 0

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader title="Dashboard" />

      {error ? (
        <div className="mt-6">
          <ErrorState title="Failed to load data" message={error} />
        </div>
      ) : (
        <>
          {/* Stats row */}
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard label="Recent Runs" value={String(totalRuns)} />
            <StatCard label="Failed" value={String(failedRuns)} />
            <StatCard label="Active" value={String(activeRuns)} />
          </div>

          {hasRuns ? (
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-neutral-300 mb-4">Recent Runs</h2>
              <RunList runs={runs} />
            </div>
          ) : (
            /* Getting Started guide — only show when there are no runs yet */
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-neutral-300 mb-4">Getting Started</h2>
              <Card>
                <div className="px-5 py-4 border-b border-neutral-800">
                  <p className="text-sm font-medium text-neutral-200">Record your first run in 4 steps</p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    No run recorded yet. Follow the steps below.
                  </p>
                </div>
                <div className="px-5 py-5 flex flex-col gap-5">
                  {/* Step 1 */}
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-mono font-bold text-neutral-400">1</span>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-neutral-300">Create a project</p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Projects group your agents and their runs.
                      </p>
                      <a
                        href="/projects"
                        className="mt-1.5 inline-flex text-xs text-primary-400 hover:text-primary-300 underline underline-offset-2 transition-colors duration-100"
                      >
                        Go to Projects →
                      </a>
                    </div>
                  </div>

                  {/* Step 2 */}
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-mono font-bold text-neutral-400">2</span>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-neutral-300">Create an agent</p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Within your project, create an agent to represent the code you&#39;re instrumenting.
                      </p>
                    </div>
                  </div>

                  {/* Step 3 */}
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-mono font-bold text-neutral-400">3</span>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-neutral-300">Generate an API key</p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        The SDK uses this key to authenticate when recording runs.
                      </p>
                      <a
                        href="/settings"
                        className="mt-1.5 inline-flex text-xs text-primary-400 hover:text-primary-300 underline underline-offset-2 transition-colors duration-100"
                      >
                        Go to Settings →
                      </a>
                    </div>
                  </div>

                  {/* Step 4 */}
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-mono font-bold text-neutral-400">4</span>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-neutral-300">Install the SDK and record a run</p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Install the SDK, add your agent ID from the project page, and record your first run.
                      </p>
                      <div className="mt-2">
                        <CodeBlock content={SDK_INSTALL} language="bash" maxHeight="60px" />
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  )
}
