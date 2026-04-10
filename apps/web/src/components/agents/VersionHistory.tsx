import type { AgentVersion } from '@agent-flight-recorder/contracts'

interface VersionHistoryProps {
  versions: AgentVersion[]
}

export function VersionHistory({ versions }: VersionHistoryProps) {
  if (versions.length === 0) {
    return (
      <p className="text-sm text-neutral-500 py-4">
        No versions yet. Create the first version to start attributing runs.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border border-neutral-800">
      <table className="w-full text-sm">
        <thead className="bg-neutral-900 border-b border-neutral-800">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Version
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Created
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Changelog
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800 bg-neutral-950">
          {versions.map((v) => {
            const changelogText = v.changelog
              ? v.changelog.length > 80
                ? v.changelog.slice(0, 80) + '\u2026'
                : v.changelog
              : null
            const createdFormatted = new Date(v.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
            return (
              <tr key={v.id}>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-neutral-200">{v.version}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-neutral-400">{createdFormatted}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-neutral-500">{changelogText ?? '\u2014'}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
