'use client'

import { useEffect, useState } from 'react'

import type { WebhookDelivery, WebhookEventType, WebhookTarget } from '@agent-flight-recorder/contracts'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { EmptyState } from '@/components/ui/EmptyState'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { formatRelativeTime } from '@/lib/utils'

const ALL_EVENTS: WebhookEventType[] = ['run.completed', 'run.failed', 'eval.failed', 'alert.fired']

async function apiCall(path: string, init?: RequestInit): Promise<{ data?: unknown; error?: string }> {
  try {
    const res = await fetch(path, init)
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { error: (body.message as string | undefined) ?? `Server error ${res.status}` }
    return { data: body }
  } catch {
    return { error: 'Network error — could not reach the server' }
  }
}

/** Secret-reveal modal — reuses the NewKeyModal "shown once" pattern from ApiKeysSection. */
function NewSecretModal({ webhook, onClose }: { webhook: WebhookTarget; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const dialogRef = useFocusTrap<HTMLDivElement>(true)

  function handleCopy() {
    if (!webhook.secret) return
    void navigator.clipboard.writeText(webhook.secret).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-secret-title"
        tabIndex={-1}
        className="bg-graphite-deep border border-graphite-light rounded-[4px] shadow-lg w-full max-w-md mx-4 outline-none"
      >
        <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between">
          <h3 id="new-secret-title" className="text-sm font-semibold text-neutral-100">
            Webhook Created
          </h3>
          <button onClick={onClose} aria-label="Close" className="text-pewter hover:text-cloud transition-colors duration-100">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-start gap-2 bg-destructive-900/40 border border-destructive-700/60 rounded-[4px] px-3 py-2.5">
            <p className="text-xs text-destructive-400 leading-relaxed">
              This signing secret is shown <strong>only once</strong>. Copy it now — you cannot retrieve it again.
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-neutral-400 mb-1.5 uppercase tracking-wider">Signing secret</p>
            <CodeBlock content={webhook.secret ?? ''} maxHeight="60px" />
          </div>
          <Button variant={copied ? 'ghost' : 'primary'} onClick={handleCopy} className="w-full">
            {copied ? 'Copied!' : 'Copy to clipboard'}
          </Button>
        </div>

        <div className="px-5 py-3 border-t border-neutral-800">
          <Button variant="secondary" onClick={onClose} className="w-full">
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

function DeliveryHistory({ webhookId }: { webhookId: string }) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const { data, error: err } = await apiCall(`/api/webhooks-config/${webhookId}/deliveries?limit=20`)
      if (err) setError(err)
      else setDeliveries((data as { deliveries: WebhookDelivery[] }).deliveries)
    })()
  }, [webhookId])

  if (error) return <p className="text-xs text-destructive-400 px-3 py-2">{error}</p>
  if (deliveries === null) return <p className="text-xs text-pewter px-3 py-2">Loading delivery history…</p>
  if (deliveries.length === 0) return <p className="text-xs text-neutral-500 px-3 py-2">No deliveries recorded yet.</p>

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      {deliveries.map((d) => (
        <div key={d.id} className="flex items-center gap-2 text-xs font-mono">
          <span
            className={[
              'px-1.5 py-0.5 rounded-[4px] border shrink-0',
              d.status === 'delivered'
                ? 'bg-success-900 text-success-400 border-success-700'
                : d.status === 'failed'
                  ? 'bg-destructive-900 text-destructive-400 border-destructive-700'
                  : 'bg-graphite text-cloud border-graphite-light',
            ].join(' ')}
          >
            {d.status}
          </span>
          <span className="text-neutral-400">{d.event}</span>
          <span className="text-pewter">
            {d.responseCode !== undefined ? `HTTP ${String(d.responseCode)}` : d.error ?? ''}
          </span>
          <span className="text-pewter ml-auto">attempts: {d.attempts}</span>
          {d.lastAttemptAt && <span className="text-pewter">{formatRelativeTime(d.lastAttemptAt)}</span>}
        </div>
      ))}
    </div>
  )
}

interface WebhooksSectionProps {
  initialWebhooks: WebhookTarget[]
  isAdmin: boolean
  loadError: string | null
}

export function WebhooksSection({ initialWebhooks, isAdmin, loadError }: WebhooksSectionProps) {
  const [webhooks, setWebhooks] = useState<WebhookTarget[]>(initialWebhooks)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<Set<WebhookEventType>>(new Set(['run.failed']))
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [newSecretWebhook, setNewSecretWebhook] = useState<WebhookTarget | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (!isAdmin) {
    return (
      <Card>
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">Webhooks</h2>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-neutral-500">
            Outbound webhook configuration is admin-only. Ask an org admin to make changes here.
          </p>
        </div>
      </Card>
    )
  }

  function toggleEvent(evt: WebhookEventType) {
    setEvents((prev) => {
      const next = new Set(prev)
      if (next.has(evt)) next.delete(evt)
      else next.add(evt)
      return next
    })
  }

  async function handleCreate() {
    setCreateError(null)
    if (!url.trim().startsWith('https://')) return setCreateError('URL must be an https:// URL')
    if (events.size === 0) return setCreateError('Select at least one event')

    setCreating(true)
    const { data, error } = await apiCall('/api/webhooks-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim(), events: [...events] }),
    })
    setCreating(false)
    if (error) return setCreateError(error)
    const webhook = (data as { webhook: WebhookTarget }).webhook
    setWebhooks((prev) => [webhook, ...prev])
    setNewSecretWebhook(webhook)
    setUrl('')
  }

  async function handleDelete(id: string) {
    const { error } = await apiCall(`/api/webhooks-config/${id}`, { method: 'DELETE' })
    if (!error) setWebhooks((prev) => prev.filter((w) => w.id !== id))
  }

  return (
    <>
      {newSecretWebhook && (
        <NewSecretModal webhook={newSecretWebhook} onClose={() => setNewSecretWebhook(null)} />
      )}

      <Card>
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">Webhooks</h2>
          <p className="mt-0.5 text-xs text-neutral-400">
            Deliver run/eval/alert events to an HTTPS endpoint you control, HMAC-signed.
          </p>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2 p-3 rounded-[4px] border border-graphite bg-graphite-deep">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-endpoint.example.com/webhook"
              className="h-8 px-2 rounded-[4px] bg-graphite border border-graphite-light text-sm text-whiteout placeholder-pewter font-mono outline-none focus:ring-1 focus:ring-neon-glow"
            />
            <div className="flex flex-wrap gap-3">
              {ALL_EVENTS.map((evt) => (
                <label key={evt} className="flex items-center gap-1.5 text-xs font-mono text-cloud">
                  <input
                    type="checkbox"
                    checked={events.has(evt)}
                    onChange={() => toggleEvent(evt)}
                    className="accent-primary-500"
                  />
                  {evt}
                </label>
              ))}
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { void handleCreate() }}
              disabled={creating}
              className="self-start"
            >
              {creating ? 'Creating…' : 'Add webhook'}
            </Button>
            {createError && <p className="text-xs text-destructive-400">{createError}</p>}
          </div>

          {loadError ? (
            <p className="text-destructive-400 text-sm">{loadError}</p>
          ) : webhooks.length === 0 ? (
            <EmptyState title="No webhooks configured" description="Add one above to start receiving run/eval/alert events at your endpoint." />
          ) : (
            <div className="flex flex-col gap-1.5">
              {webhooks.map((w) => (
                <div key={w.id} className="rounded-[4px] border border-graphite bg-graphite-deep">
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${w.enabled ? 'bg-neon-glow shadow-[var(--shadow-glow)]' : 'bg-pewter'}`} aria-hidden="true" />
                    <span className="font-mono text-xs text-neutral-300 truncate flex-1">{w.url}</span>
                    <span className="font-mono text-xs text-pewter shrink-0">{w.events.join(', ')}</span>
                    <button
                      type="button"
                      onClick={() => setExpandedId((id) => (id === w.id ? null : w.id))}
                      className="text-xs text-pewter hover:text-cloud transition-colors shrink-0"
                    >
                      {expandedId === w.id ? 'hide history' : 'history'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { void handleDelete(w.id) }}
                      className="text-xs text-destructive-400 hover:text-destructive-500 transition-colors shrink-0"
                    >
                      Delete
                    </button>
                  </div>
                  {expandedId === w.id && (
                    <div className="border-t border-graphite">
                      <DeliveryHistory webhookId={w.id} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </>
  )
}
