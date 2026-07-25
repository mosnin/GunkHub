/**
 * Fleet blast radius — "can I ship this version, and what breaks if I do?"
 *
 * Stable, shareable URL:
 *   /agents/<agentId>/blast-radius?baseline=<versionId>&target=<versionId>
 *
 * Both versions live in the query string precisely so an operator can paste the
 * analysis into a review thread and have the recipient see the same answer.
 *
 * All FOUR service answers are handled explicitly and none shares copy with
 * another:
 *
 *   nothing selected -> NoTargetChosen (nothing was asked, so nothing is absent)
 *   ok               -> BlastRadiusView, led by the verdict
 *   empty            -> the baseline version genuinely has no recorded runs
 *   unanalysable     -> no config snapshot; THE ANALYSIS DID NOT RUN
 *   error            -> the query failed
 *
 * The `unanalysable` branch is why this page does not reach for `<EmptyState>`
 * on anything ambiguous: `configSnapshot` is optional in the schema, so
 * "cannot analyse" is reachable in production, and rendering it as "no
 * divergences found" would tell an operator a change is safe when the truth is
 * that we never asked.
 */

import { notFound } from 'next/navigation'

import type { Agent, AgentVersion } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { BlastRadiusView } from '@/components/divergence/BlastRadiusView'
import {
  DivergenceErrorResult,
  NoTargetChosen,
  UnanalysableResult,
} from '@/components/divergence/DivergenceStates'
import { FleetVersionPicker } from '@/components/divergence/TargetVersionPicker'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { listAgentVersions } from '@/lib/services/agent_versions'
import { getBlastRadius } from '@/lib/services/divergence'

export const metadata: Metadata = { title: 'Blast radius' }

interface Props {
  params: { agentId: string }
  searchParams: { baseline?: string; target?: string; cursor?: string }
}

async function findAgent(agentId: string): Promise<Agent | null> {
  const { listAgentsByOrg } = await import('@/lib/services/agents')
  const agents = await listAgentsByOrg()
  return agents.find((a) => a.id === agentId) ?? null
}

export default async function BlastRadiusPage({ params, searchParams }: Props) {
  const { agentId } = params
  const { baseline, target, cursor } = searchParams

  let agent: Agent | null = null
  try {
    agent = await findAgent(agentId)
  } catch {
    notFound()
  }
  if (agent === null) notFound()

  // The version list is the page's only control. A failure loading it is
  // surfaced rather than degraded into an empty dropdown, which would look
  // exactly like "this agent has no versions".
  let versions: AgentVersion[] = []
  let versionsFailed = false
  try {
    versions = await listAgentVersions(agentId)
  } catch {
    versionsFailed = true
  }

  const action = `/agents/${encodeURIComponent(agentId)}/blast-radius`

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Blast radius"
        subtitle={`Check a target version against ${agent.name}'s recorded runs. Nothing is executed — this is structural analysis of history.`}
      />

      <div className="p-6 max-w-6xl w-full mx-auto flex flex-col gap-4">
        {versionsFailed ? (
          <DivergenceErrorResult message="Could not load this agent's versions, so there is nothing to analyse against. Retry, and check backend status if it persists." />
        ) : versions.length < 2 ? (
          <EmptyState
            title="Not enough versions to compare"
            description="A blast radius needs a baseline version (whose runs are checked) and a target version (the one you are considering shipping). Create a second version with a configuration snapshot to run this analysis."
            action={{ label: 'Back to agent', href: `/agents/${encodeURIComponent(agentId)}` }}
          />
        ) : (
          <>
            <Card>
              <div className="px-4 py-3">
                <FleetVersionPicker
                  versions={versions}
                  baselineId={baseline}
                  targetId={target}
                  action={action}
                />
              </div>
            </Card>

            {baseline === undefined || target === undefined ? (
              <NoTargetChosen description="The analysis replays the baseline version's recorded runs against the target version's configuration and reports where the recorded trajectory could not have happened — grouped by distinct reason, not by run." />
            ) : (
              <Analysis
                baselineId={baseline}
                targetId={target}
                agentId={agentId}
                cursor={cursor}
                action={action}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

async function Analysis({
  baselineId,
  targetId,
  agentId,
  cursor,
  action,
}: {
  baselineId: string
  targetId: string
  agentId: string
  cursor: string | undefined
  action: string
}) {
  const result = await getBlastRadius(baselineId, targetId, cursor)

  switch (result.status) {
    case 'ok':
      return (
        <BlastRadiusView
          report={result.report}
          baselineVersionLabel={result.baselineVersionLabel}
          targetVersionLabel={result.targetVersionLabel}
          nextCursor={result.nextCursor}
          // The continue link carries the version pair so the next batch is
          // analysed against the same question. The cursor is appended by the
          // view, keeping the whole scan position in the shareable URL.
          continueHrefBase={`${action}?baseline=${encodeURIComponent(baselineId)}&target=${encodeURIComponent(targetId)}`}
        />
      )
    case 'unanalysable':
      return <UnanalysableResult why={result.why} remedy={result.remedy} />
    case 'empty':
      return (
        <EmptyState
          title="No recorded runs to check"
          description={result.message}
          action={{ label: 'View runs', href: `/runs?agentId=${encodeURIComponent(agentId)}` }}
        />
      )
    case 'error':
      return <DivergenceErrorResult message={result.message} />
  }
}
