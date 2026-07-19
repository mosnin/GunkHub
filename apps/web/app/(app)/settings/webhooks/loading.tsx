import { Card } from '@/components/ui/Card'
import { LoadingState } from '@/components/ui/LoadingState'

export default function SettingsWebhooksLoading() {
  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">Webhooks</h2>
      </div>
      <LoadingState message="Loading webhooks…" />
    </Card>
  )
}
