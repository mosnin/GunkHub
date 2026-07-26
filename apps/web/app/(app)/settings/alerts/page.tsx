import type { AlertEvent, AlertRule } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { AlertsSection } from '@/components/settings/AlertsSection'
import { getCurrentAuth } from '@/lib/auth'
import { listAlertEvents, listAlertRules } from '@/lib/services/alerts'


export const metadata: Metadata = { title: 'Alerts — Settings' }

export default async function SettingsAlertsPage() {
  const isAdmin = getCurrentAuth().orgRole === 'admin'

  let rules: AlertRule[] = []
  let loadError: string | null = null
  if (isAdmin) {
    try {
      rules = await listAlertRules()
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load alert rules'
    }
  }

  // Firing history is readable by any member (convex/alerts.ts listAlertEvents
  // is not admin-gated) — fetched regardless of role.
  let events: AlertEvent[] = []
  try {
    events = await listAlertEvents(20)
  } catch {
    // Non-fatal: firing history section is hidden if this fails
  }

  return (
    <AlertsSection initialRules={rules} initialEvents={events} isAdmin={isAdmin} loadError={loadError} />
  )
}
