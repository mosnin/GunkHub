import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/PageHeader'
import { RunList } from '@/components/runs/RunList'

export const metadata: Metadata = { title: 'Runs' }

export default function RunsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Runs"
        subtitle="All agent runs across your organization."
      />
      <div className="mt-6">
        <RunList />
      </div>
    </div>
  )
}
