import { PageHeader } from '@/components/layout/PageHeader'
import { SettingsNav } from '@/components/settings/SettingsNav'

/**
 * Shared settings shell: one PageHeader + a sub-nav (General / Members /
 * Usage) wrapping every /settings/* route. Split into a tabbed IA this cycle
 * because the single settings page was accumulating six independent Cards
 * (Organization, Members, SDK Setup, System Health, API Keys, Retention) —
 * Members and Usage move to their own routes with stable, shareable URLs;
 * General keeps the org-identity-adjacent cards (Organization, SDK Setup,
 * System Health, API Keys, Retention) since those are one coherent "how is
 * this org configured" story.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <PageHeader title="Settings" />
      <SettingsNav />
      <div className="p-6 max-w-3xl mx-auto">{children}</div>
    </div>
  )
}
