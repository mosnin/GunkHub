import type { Metadata } from 'next'

import type { Project } from '@agent-flight-recorder/contracts'

import { ProjectsList } from '@/components/projects/ProjectsList'
import { ErrorState } from '@/components/ui/ErrorState'
import { listProjects } from '@/lib/services/projects'

export const metadata: Metadata = { title: 'Projects' }

export default async function ProjectsPage() {
  let projects: Project[] = []
  let error: string | null = null

  try {
    projects = await listProjects()
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load projects'
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {error ? (
        <ErrorState title="Failed to load projects" message={error} />
      ) : (
        <ProjectsList projects={projects} />
      )}
    </div>
  )
}
