import type { Metadata } from 'next'

import { PageHeader } from '@/components/layout/PageHeader'
import { ApiKeysSection } from '@/components/settings/ApiKeysSection'
import { Card } from '@/components/ui/Card'

export const metadata: Metadata = { title: 'Settings' }

export default function SettingsPage() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader title="Settings" />

      <div className="mt-6 flex flex-col gap-6">
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
              className="w-full max-w-sm h-9 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-sm text-neutral-400 placeholder-neutral-600 cursor-not-allowed outline-none"
            />
          </div>
        </Card>

        {/* Members */}
        <Card>
          <div className="px-5 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">Members</h2>
          </div>
          <div className="px-5 py-4">
            <div className="overflow-x-auto rounded-md border border-neutral-800 mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-800 bg-neutral-900">
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Email
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Role
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-sm text-neutral-600">
                      No members to display.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-neutral-600">
              Manage members through your{' '}
              <span className="text-neutral-500">Clerk dashboard</span>.
            </p>
          </div>
        </Card>

        {/* API Keys — functional UI (route handled by Team A at /api/api-keys) */}
        <ApiKeysSection />
      </div>
    </div>
  )
}
