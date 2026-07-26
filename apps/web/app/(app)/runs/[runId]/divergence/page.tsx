/**
 * Single-run divergence — would this recorded run still have been possible on a
 * target version, and where does it break.
 *
 * Stable, shareable URL: `/runs/<runId>/divergence?target=<versionId>`. This is
 * the drill-down target from every reason group in the fleet blast radius, so
 * the URL shape is part of the feature rather than an implementation detail.
 *
 * All four service answers are handled explicitly and none shares copy with
 * another — see the blast-radius page, and lib/services/divergence.ts for why
 * `unanalysable` is a first-class status rather than an empty state.
 */

import { notFound } from 'next/navigation'

import type { AgentVersion, Run } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import {
  DivergenceErrorResult,
  NoTargetChosen,
  UnanalysableResult,
} from '@/components/divergence/DivergenceStates'
import { RunDivergenceView } from '@/components/divergence/RunDivergenceView'
import { RunVersionPicker } from '@/components/divergence/TargetVersionPicker'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { listAgentVersions } from '@/lib/services/agent_versions'
import { getRunDivergence } from '@/lib/services/divergence'
import { getRun } from '@/lib/services/runs'
import { truncateId } from '@/lib/utils'

export const metadata: Metadata = { title: 'Divergence' }

interface Props {
  params: { runId: string }
  searchParams: { target?: string }
}

export default async function RunDivergencePage({ params, searchParams }: Props) {
  const { runId } = params
  const targetId = searchParams.target

  let run: Run | null = null
  try {
    // `getRun` returns the GetRunResponse envelope (run + counts).
    run = (await getRun(runId)).run
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.toLowerCase().includes('not found')) notFound()
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <DivergenceErrorResult message="Could not load this run, so no analysis was attempted." />
      </div>
    )
  }
  if (run === null) notFound()

  let versions: AgentVersion[] = []
  let versionsFailed = false
  try {
    versions = await listAgentVersions(run.agentId)
  } catch {
    versionsFailed = true
  }

  const action = `/runs/${encodeURIComponent(runId)}/divergence`

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Divergence"
        subtitle={`Run ${truncateId(runId, 16)} checked against a target version. Nothing is executed — this compares recorded history to the target's configuration.`}
      />

      <div className="p-6 max-w-5xl w-full mx-auto flex flex-col gap-4">
        {versionsFailed ? (
          <DivergenceErrorResult message="Could not load the agent's versions, so there is nothing to analyse against. Retry, and check backend status if it persists." />
        ) : versions.length === 0 ? (
          <EmptyState
            title="No versions to analyse against"
            description="This run's agent has no recorded versions. Create a version with a configuration snapshot to check this run against it."
            action={{ label: 'Back to run', href: `/runs/${encodeURIComponent(runId)}` }}
          />
        ) : (
          <>
            <Card>
              <div className="px-4 py-3">
                <RunVersionPicker versions={versions} targetId={targetId} action={action} />
              </div>
            </Card>

            {targetId === undefined ? (
              <NoTargetChosen description="The analysis walks this run's recorded events in sequence and reports the first point at which the trajectory could not have happened on the selected version." />
            ) : (
              <Analysis runId={runId} targetId={targetId} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

async function Analysis({ runId, targetId }: { runId: string; targetId: string }) {
  const result = await getRunDivergence(runId, targetId)

  switch (result.status) {
    case 'ok':
      return (
        <RunDivergenceView
          report={result.report}
          targetVersionLabel={result.targetVersionLabel}
        />
      )
    case 'unanalysable':
      return <UnanalysableResult why={result.why} remedy={result.remedy} />
    case 'empty':
      return (
        <EmptyState
          title="Nothing recorded to analyse"
          description={result.message}
          action={{ label: 'Back to run', href: `/runs/${encodeURIComponent(runId)}` }}
        />
      )
    case 'error':
      return <DivergenceErrorResult message={result.message} />
  }
}
