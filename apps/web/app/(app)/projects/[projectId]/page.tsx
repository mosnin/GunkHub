import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/PageHeader'
import { Tabs } from '@/components/ui/Tabs'
import { LoadingState } from '@/components/ui/LoadingState'

export const metadata: Metadata = { title: 'Project' }

interface ProjectPageProps {
  params: { projectId: string }
}

export default function ProjectPage({ params }: ProjectPageProps) {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'agents', label: 'Agents' },
    { id: 'runs', label: 'Runs' },
  ]

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Project"
        subtitle={`Project ID: ${params.projectId}`}
      />
      <div className="mt-6">
        <Tabs tabs={tabs} active="overview" onChange={() => {}} />
        <div className="mt-6">
          <LoadingState message="Loading project data..." />
        </div>
      </div>
    </div>
  )
}
