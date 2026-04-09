import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'

interface ArtifactListProps {
  runId: string
  loading?: boolean
}

export function ArtifactList({ runId: _runId, loading }: ArtifactListProps) {
  if (loading) {
    return <LoadingState message="Loading artifacts..." />
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-neutral-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900">
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Size</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Created</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Download</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={5} className="px-0 py-0">
                <EmptyState title="No artifacts recorded for this run." />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
