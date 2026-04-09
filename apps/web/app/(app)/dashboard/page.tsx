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

const SDK_USAGE = `import { FlightRecorder } from '@agent-flight-recorder/sdk'

const recorder = new FlightRecorder({
  apiKey: process.env.AFR_API_KEY,
})

// Wrap your agent run
const run = await recorder.startRun({ agentId: 'my-agent' })
try {
  // ... your agent logic ...
  await run.complete({ output: result })
} catch (err) {
  await run.fail({ error: err })
}`

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
            /* Quickstart — only show when there are no runs yet */
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-neutral-300 mb-4">Quick Start</h2>
              <Card>
                <div className="px-5 py-4 border-b border-neutral-800">
                  <p className="text-sm font-medium text-neutral-200">Install the SDK</p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Instrument your agent in minutes. No run recorded yet — follow the steps below.
                  </p>
                </div>
                <div className="px-5 py-4 flex flex-col gap-4">
                  <div>
                    <p className="text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wider">1. Install</p>
                    <CodeBlock content={SDK_INSTALL} language="bash" maxHeight="60px" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-neutral-500 mb-2 uppercase tracking-wider">2. Record a run</p>
                    <CodeBlock content={SDK_USAGE} language="typescript" maxHeight="240px" />
                  </div>
                  <div className="pt-1">
                    <p className="text-xs text-neutral-600">
                      Need an API key?{' '}
                      <a
                        href="/settings"
                        className="text-neutral-400 hover:text-neutral-200 underline underline-offset-2 transition-colors duration-100"
                      >
                        Generate one in Settings
                      </a>
                      .
                    </p>
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
