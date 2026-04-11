import Link from 'next/link'
import { notFound } from 'next/navigation'

import type { Agent, AgentVersion } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { VersionSection } from '@/components/agents/VersionSection'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { getProject } from '@/lib/services/projects'

export const metadata: Metadata = { title: 'Agent' }

interface Props {
  params: { agentId: string }
}

/**
 * Find an agent by its ID. Since there is no standalone getAgent service function,
 * we fetch from the agents service by fetching the project's agents. This is only
 * possible if we have a projectId — which we don't from params alone.
 *
 * As a pragmatic approach: query agents by org and look up by id. If the agent
 * is not found in the response we show 404. The listAgentsByOrg call is paginated
 * but covers the common case.
 */
async function findAgent(agentId: string): Promise<Agent | null> {
  // Import here to avoid circular top-level resolution; both services are available.
  const { listAgentsByOrg } = await import('@/lib/services/agents')
  const agents = await listAgentsByOrg()
  return agents.find((a) => a.id === agentId) ?? null
}

function buildSdkSnippet(agentId: string, latestVersionId?: string): string {
  const versionLine = latestVersionId
    ? `  agentVersionId: '${latestVersionId}',`
    : `  // agentVersionId: 'YOUR_VERSION_ID',  // create a version below`
  return `import { FlightRecorder } from '@agent-flight-recorder/sdk'

const recorder = new FlightRecorder({
  endpoint: 'https://your-app.vercel.app',
  apiKey: process.env.AFR_API_KEY,
})

const run = await recorder.startRun({
  agentId: '${agentId}',
${versionLine}
})
try {
  // your agent logic
  await run.complete({ output: result })
} catch (err) {
  await run.fail({ error: err })
}`
}

export default async function AgentPage({ params }: Props) {
  let agent: Agent | null = null

  try {
    agent = await findAgent(params.agentId)
  } catch {
    notFound()
  }

  if (!agent) notFound()

  // Try to fetch the project name for the breadcrumb — non-fatal if it fails
  let projectName: string | null = null
  try {
    const project = await getProject(agent.projectId)
    projectName = project.name
  } catch {
    // Non-fatal: fall back to project ID in breadcrumb
  }

  // Fetch versions — non-fatal if it fails
  let versions: AgentVersion[] = []
  let versionsNextCursor: string | null = null
  try {
    const { listAgentVersionsPaginated } = await import('@/lib/services/agent_versions')
    const vResult = await listAgentVersionsPaginated(params.agentId)
    versions = vResult.versions
    versionsNextCursor = vResult.nextCursor
  } catch {
    // Non-fatal: show empty version list
  }

  const sdkSnippet = buildSdkSnippet(agent.id, versions[0]?.id)

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500 mb-5">
        <Link href="/projects" className="hover:text-neutral-300 transition-colors">
          Projects
        </Link>
        <span>/</span>
        <Link
          href={`/projects/${agent.projectId}`}
          className="hover:text-neutral-300 transition-colors"
        >
          {projectName ?? agent.projectId.slice(0, 12) + '\u2026'}
        </Link>
        <span>/</span>
        <span className="text-neutral-300">{agent.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">{agent.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-neutral-900 border border-neutral-800 text-neutral-400">
              {agent.slug}
            </span>
          </div>
          {agent.description && (
            <p className="mt-2 text-sm text-neutral-500">{agent.description}</p>
          )}
        </div>
        <Link
          href={`/runs?agentId=${agent.id}`}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 transition-colors"
        >
          View Runs
        </Link>
      </div>

      {/* Agent ID */}
      <div className="mb-6 p-3 rounded-md border border-neutral-800 bg-neutral-900">
        <p className="text-xs font-medium text-neutral-500 mb-1">Agent ID</p>
        <p className="text-xs font-mono text-neutral-300 break-all">{agent.id}</p>
      </div>

      {/* Versions section */}
      <section className="mb-8">
        <VersionSection agentId={agent.id} versions={versions} nextCursor={versionsNextCursor} />
      </section>

      {/* SDK Setup */}
      <Card>
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">SDK Setup</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Use this snippet to record runs for this agent.
          </p>
        </div>
        <div className="px-5 py-4">
          <CodeBlock content={sdkSnippet} language="typescript" maxHeight="300px" />
          <p className="mt-3 text-xs text-neutral-600">
            Need an API key?{' '}
            <Link
              href="/settings"
              className="text-neutral-400 hover:text-neutral-200 underline underline-offset-2 transition-colors"
            >
              Generate one in Settings
            </Link>
          </p>
        </div>
      </Card>
    </div>
  )
}
