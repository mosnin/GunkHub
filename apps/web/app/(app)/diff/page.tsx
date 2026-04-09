import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { DiffViewer } from '@/components/runs/DiffViewer'

export const metadata: Metadata = { title: 'Compare Runs' }

export default function DiffPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Compare Runs"
        subtitle="Select two runs to compare their event sequences."
      />
      <div className="mt-6">
        <DiffViewer />
      </div>
    </div>
  )
}
