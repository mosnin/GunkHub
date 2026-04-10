'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { Agent, Project } from '@agent-flight-recorder/contracts'

import { CreateAgentModal } from '@/components/projects/CreateAgentModal'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { EmptyState } from '@/components/ui/EmptyState'

interface ProjectDetailProps {
  project: Project
  agents: Agent[]
}

function buildSdkSnippet(agentId: string): string {
  return `import { FlightRecorder } from '@agent-flight-recorder/sdk'

const recorder = new FlightRecorder({
  endpoint: 'https://your-app.vercel.app',
  apiKey: process.env.AFR_API_KEY,
})

const run = await recorder.startRun({
  agentId: '${agentId}',
  // agentVersionId: 'YOUR_VERSION_ID',  // create a version on the agent page
})
try {
  // your agent logic
  await run.complete({ output: result })
} catch (err) {
  await run.fail({ error: err })
}`
}

export function ProjectDetail({ project, agents }: ProjectDetailProps) {
  const [showModal, setShowModal] = useState(false)
  const router = useRouter()

  function handleAgentCreated(a: { id: string; name: string }) {
    setShowModal(false)
    router.push(`/agents/${a.id}`)
  }

  const firstAgent = agents[0]
  const firstAgentId = firstAgent != null ? firstAgent.id : '<create-an-agent-above>'
  const sdkSnippet = buildSdkSnippet(firstAgentId)

  return (
    <>
      <CreateAgentModal
        isOpen={showModal}
        projectId={project.id}
        onClose={() => setShowModal(false)}
        onCreated={handleAgentCreated}
      />

      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-neutral-500 mb-5">
        <Link href="/projects" className="hover:text-neutral-300 transition-colors">
          Projects
        </Link>
        <span>/</span>
        <span className="text-neutral-300">{project.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-neutral-100">{project.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-neutral-900 border border-neutral-800 text-neutral-400">
              {project.slug}
            </span>
          </div>
          {project.description && (
            <p className="mt-2 text-sm text-neutral-500">{project.description}</p>
          )}
        </div>
      </div>

      {/* Agents section */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-neutral-300">Agents</h2>
          <Button variant="secondary" size="sm" onClick={() => setShowModal(true)}>
            New Agent
          </Button>
        </div>

        {agents.length === 0 ? (
          <EmptyState
            title="No agents yet"
            description="Create your first agent to start recording runs."
            action={{ label: 'New Agent', onClick: () => setShowModal(true) }}
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-neutral-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-900">
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                    Slug
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                {agents.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => router.push(`/agents/${a.id}`)}
                    className="cursor-pointer hover:bg-neutral-900/60 transition-colors"
                  >
                    <td className="px-4 py-3 text-sm text-neutral-200 font-medium">
                      {a.name}
                      {a.description && (
                        <span className="ml-2 text-xs text-neutral-600 font-normal">
                          {a.description}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">{a.slug}</td>
                    <td className="px-4 py-3 text-xs text-neutral-500">
                      {new Date(a.createdAt).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* SDK Setup section */}
      <section>
        <h2 className="text-sm font-semibold text-neutral-300 mb-3">SDK Setup</h2>
        <Card>
          <div className="px-5 py-4 border-b border-neutral-800">
            <p className="text-sm font-medium text-neutral-200">Record runs for this project</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              {firstAgent != null
                ? `Using agent: ${firstAgent.name}`
                : 'Create an agent above to get the agent ID for this snippet.'}
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
      </section>
    </>
  )
}
