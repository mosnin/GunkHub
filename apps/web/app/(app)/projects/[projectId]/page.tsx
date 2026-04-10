import { notFound } from 'next/navigation'

import type { Agent, Project } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { ProjectDetail } from '@/components/projects/ProjectDetail'
import { listAgents } from '@/lib/services/agents'
import { getProject } from '@/lib/services/projects'

export const metadata: Metadata = { title: 'Project' }

interface Props {
  params: { projectId: string }
}

export default async function ProjectPage({ params }: Props) {
  let project: Project | undefined
  let agents: Agent[] = []

  try {
    project = await getProject(params.projectId)
  } catch {
    notFound()
  }

  if (!project) notFound()

  try {
    agents = await listAgents(params.projectId)
  } catch {
    // Non-fatal: show empty agents list if fetch fails
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <ProjectDetail project={project} agents={agents} />
    </div>
  )
}
