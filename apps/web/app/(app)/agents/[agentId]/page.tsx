import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/PageHeader'
import { Tabs } from '@/components/ui/Tabs'
import { LoadingState } from '@/components/ui/LoadingState'

export const metadata: Metadata = { title: 'Agent' }

interface AgentPageProps {
  params: { agentId: string }
}

export default function AgentPage({ params }: AgentPageProps) {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'versions', label: 'Versions' },
    { id: 'runs', label: 'Runs' },
  ]

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Agent"
        subtitle={`Agent ID: ${params.agentId}`}
      />
      <div className="mt-6">
        <Tabs tabs={tabs} active="overview" onChange={() => {}} />
        <div className="mt-6">
          <LoadingState message="Loading agent data..." />
        </div>
      </div>
    </div>
  )
}
