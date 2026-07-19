import type { Metadata } from 'next'

import { ApiKeysSection } from '@/components/settings/ApiKeysSection'
import { RetentionSection } from '@/components/settings/RetentionSection'
import { SdkSetupSnippet } from '@/components/settings/SdkSetupSnippet'
import { SystemHealthPanel } from '@/components/settings/SystemHealthPanel'
import { Card } from '@/components/ui/Card'
import { getCurrentAuth } from '@/lib/auth'
import { listApiKeys, type ApiKeySummary } from '@/lib/services/api_keys'
import { getOrganizationSettings } from '@/lib/services/organizations'

export const metadata: Metadata = { title: 'Settings' }

function formatDeletionDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default async function SettingsPage() {
  // Server-render the initial API key list so the client component does not
  // fetch via useEffect.
  let initialKeys: ApiKeySummary[] = []
  let keysError: string | null = null
  try {
    initialKeys = await listApiKeys()
  } catch (err) {
    keysError = err instanceof Error ? err.message : 'Failed to load keys'
  }

  const isAdmin = getCurrentAuth().orgRole === 'admin'

  let initialRetentionDays: number | null = null
  let pendingDeletionAt: number | null = null
  let retentionError: string | null = null
  try {
    const settings = await getOrganizationSettings()
    initialRetentionDays = settings.retentionDays
    pendingDeletionAt = settings.pendingDeletionAt
  } catch (err) {
    retentionError = err instanceof Error ? err.message : 'Failed to load retention policy'
  }

  return (
    <>
      {pendingDeletionAt !== null && (
        <div
          role="alert"
          className="flex items-start gap-2 bg-destructive-900/40 border border-destructive-700/60 rounded-[4px] px-4 py-3 mb-6"
        >
          <span
            className="w-1.5 h-1.5 rounded-full bg-destructive-500 shrink-0 mt-1 shadow-[var(--shadow-glow-warn)]"
            aria-hidden="true"
          />
          <p className="text-sm text-destructive-400 leading-relaxed">
            This organization was deleted in Clerk on{' '}
            <span className="font-mono">{formatDeletionDate(pendingDeletionAt)}</span>. Data
            erasure is pending operator action — see ADR 001 (Data Retention and Erasure).
          </p>
        </div>
      )}

      <div className="flex flex-col gap-6">
        {/* Organization */}
        <Card>
          <div className="px-5 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">Organization</h2>
          </div>
          <div className="px-5 py-4">
            <label className="block text-xs font-medium text-neutral-500 mb-1.5" htmlFor="org-name">
              Name
            </label>
            <input
              id="org-name"
              type="text"
              readOnly
              placeholder="Your organization name"
              className="w-full max-w-sm h-9 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-sm text-neutral-400 placeholder-neutral-500 cursor-not-allowed outline-none"
            />
          </div>
        </Card>

        {/* SDK Setup — install instructions and basic usage */}
        <SdkSetupSnippet />

        {/* System Health — operator-facing storage and projection status */}
        <SystemHealthPanel />

        {/* API Keys — functional UI (route handled by Team A at /api/api-keys) */}
        <ApiKeysSection initialKeys={initialKeys} loadError={keysError} />

        {/* Retention — ADR 001, admin-gated */}
        <RetentionSection
          initialRetentionDays={initialRetentionDays}
          isAdmin={isAdmin}
          loadError={retentionError}
        />
      </div>
    </>
  )
}
