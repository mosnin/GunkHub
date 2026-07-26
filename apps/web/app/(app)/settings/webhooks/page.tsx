import type { WebhookTarget } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { WebhooksSection } from '@/components/settings/WebhooksSection'
import { getCurrentAuth } from '@/lib/auth'
import { listWebhooks } from '@/lib/services/webhooks_config'


export const metadata: Metadata = { title: 'Webhooks — Settings' }

export default async function SettingsWebhooksPage() {
  const isAdmin = getCurrentAuth().orgRole === 'admin'

  let webhooks: WebhookTarget[] = []
  let loadError: string | null = null
  if (isAdmin) {
    try {
      webhooks = await listWebhooks()
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load webhooks'
    }
  }

  return <WebhooksSection initialWebhooks={webhooks} isAdmin={isAdmin} loadError={loadError} />
}
