import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

export const metadata: Metadata = { title: 'Dashboard' }

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="px-4 py-4">
        <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</p>
        <p className="mt-1.5 text-2xl font-semibold text-neutral-100 font-mono">{value}</p>
      </div>
    </Card>
  )
}

export default function DashboardPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader title="Dashboard" />

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total Runs" value="--" />
        <StatCard label="Failed Runs" value="--" />
        <StatCard label="Active Runs" value="--" />
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-semibold text-neutral-300 mb-4">Recent Runs</h2>
        <EmptyState
          title="No runs yet"
          description="Runs will appear here once your agents start recording. Integrate the SDK to begin."
        />
      </div>
    </div>
  )
}
