import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'

export const metadata: Metadata = { title: 'Agents' }

export default function AgentsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Agents"
        subtitle="Registered agents across your organization."
      />
      <div className="mt-6">
        <EmptyState
          title="No agents yet"
          description="Agents are registered automatically when your first run is recorded via the SDK."
        />
      </div>
    </div>
  )
}
