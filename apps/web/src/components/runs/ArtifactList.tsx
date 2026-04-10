import type { Artifact } from '@agent-flight-recorder/contracts'

import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'

interface ArtifactListProps {
  artifacts: Artifact[]
  loading?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ArtifactList({ artifacts, loading }: ArtifactListProps) {
  if (loading) {
    return <LoadingState message="Loading artifacts..." />
  }

  if (artifacts.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No artifacts recorded for this run." />
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="overflow-x-auto rounded-md border border-neutral-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-900">
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Size</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Created</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Storage Key</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {artifacts.map((artifact) => (
              <tr key={artifact.id} className="hover:bg-neutral-900/40 transition-colors">
                <td className="px-4 py-3 font-mono text-neutral-200">{artifact.name}</td>
                <td className="px-4 py-3 text-neutral-400 font-mono text-xs">{artifact.mimeType}</td>
                <td className="px-4 py-3 text-neutral-400 tabular-nums">{formatBytes(artifact.size)}</td>
                <td className="px-4 py-3 text-neutral-500 tabular-nums">{formatDate(artifact.createdAt)}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-600 truncate max-w-xs" title={artifact.storageKey}>
                  {artifact.storageKey}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
