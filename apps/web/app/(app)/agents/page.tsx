import Link from 'next/link'

import type { Agent } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { listAgentsByOrg } from '@/lib/services/agents'

export const metadata: Metadata = { title: 'Agents' }

export default async function AgentsPage() {
  let agents: Agent[] = []
  let error: string | null = null

  try {
    agents = await listAgentsByOrg()
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load agents'
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        title="Agents"
        subtitle="All agents registered in your organization."
      />
      <div className="mt-6">
        {error ? (
          <ErrorState title="Failed to load agents" message={error} />
        ) : agents.length === 0 ? (
          <div>
            <EmptyState
              title="No agents yet"
              description="Agents are created within projects. Create a project first, then add agents to it."
            />
            <div className="mt-4 text-center">
              <Link
                href="/projects"
                className="text-sm text-primary-400 hover:text-primary-300 underline underline-offset-2 transition-colors"
              >
                Go to Projects to create an agent
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-neutral-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-900">
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider min-w-[160px]">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider min-w-[120px]">
                    Slug
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider min-w-[140px]">
                    Project
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider min-w-[120px]">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                {agents.map((a) => (
                  <tr key={a.id} className="hover:bg-neutral-900/60 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        href={`/agents/${a.id}`}
                        className="text-sm text-neutral-200 font-medium hover:text-white transition-colors"
                      >
                        {a.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">{a.slug}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${a.projectId}`}
                        className="text-xs text-neutral-500 hover:text-neutral-300 font-mono transition-colors"
                      >
                        {a.projectId.slice(0, 12)}…
                      </Link>
                    </td>
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
      </div>
    </div>
  )
}
