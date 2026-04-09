import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'

export const metadata: Metadata = { title: 'Projects' }

export default function ProjectsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Projects"
        subtitle="Organize your agents and runs into projects."
      />
      <div className="mt-6">
        <EmptyState
          title="No projects yet"
          description="Create your first project to start recording agent runs."
          action={{ label: 'New Project', onClick: undefined }}
        />
      </div>
    </div>
  )
}
