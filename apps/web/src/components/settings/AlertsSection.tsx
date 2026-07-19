'use client'

import { useState } from 'react'

import type { AlertChannel, AlertEvent, AlertRule, AlertRuleKind } from '@agent-flight-recorder/contracts'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatRelativeTime } from '@/lib/utils'

const KIND_LABEL: Record<AlertRuleKind, string> = {
  run_failed: 'Run failed',
  failure_rate: 'Failure rate threshold',
  eval_failed: 'Eval failed',
}

interface AlertsSectionProps {
  initialRules: AlertRule[]
  initialEvents: AlertEvent[]
  isAdmin: boolean
  loadError: string | null
}

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

function RuleBuilder({ onCreated }: { onCreated: (rule: AlertRule) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AlertRuleKind>('run_failed')
  const [thresholdPct, setThresholdPct] = useState('50')
  const [windowMinutes, setWindowMinutes] = useState('60')
  const [channelType, setChannelType] = useState<'webhook' | 'email'>('webhook')
  const [channelTarget, setChannelTarget] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    setError(null)
    if (!name.trim()) return setError('Name is required')
    if (!channelTarget.trim()) return setError('Channel target is required')
    if (kind === 'failure_rate' && (!thresholdPct || !windowMinutes)) {
      return setError('Threshold and window are required for failure-rate rules')
    }

    setSubmitting(true)
    const channels: AlertChannel[] = [{ type: channelType, target: channelTarget.trim() }]
    const { data, error: err } = await apiCall('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        kind,
        channels,
        ...(kind === 'failure_rate' && {
          thresholdPct: Number(thresholdPct),
          windowMinutes: Number(windowMinutes),
        }),
      }),
    })
    setSubmitting(false)
    if (err) return setError(err)
    const body = data as { rule: AlertRule }
    onCreated(body.rule)
    setName('')
    setChannelTarget('')
  }

  return (
    <div className="flex flex-col gap-3 p-3 rounded-[4px] border border-graphite bg-graphite-deep">
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rule name"
          aria-label="Rule name"
          className="flex-1 min-w-[140px] h-8 px-2 rounded-[4px] bg-graphite border border-graphite-light text-sm text-whiteout placeholder-pewter outline-none focus:ring-1 focus:ring-neon-glow"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as AlertRuleKind)}
          aria-label="Alert rule kind"
          className="h-8 px-2 rounded-[4px] bg-graphite border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
        >
          {(Object.keys(KIND_LABEL) as AlertRuleKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>

      {kind === 'failure_rate' && (
        <div className="flex gap-2">
          <label className="flex items-center gap-1.5 text-xs text-pewter">
            threshold %
            <input
              type="number"
              min={0}
              max={100}
              value={thresholdPct}
              onChange={(e) => setThresholdPct(e.target.value)}
              className="w-16 h-8 px-2 rounded-[4px] bg-graphite border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-pewter">
            window (min)
            <input
              type="number"
              min={1}
              value={windowMinutes}
              onChange={(e) => setWindowMinutes(e.target.value)}
              className="w-20 h-8 px-2 rounded-[4px] bg-graphite border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
            />
          </label>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-pewter uppercase tracking-wider">Channel</span>
        <select
          value={channelType}
          onChange={(e) => setChannelType(e.target.value as 'webhook' | 'email')}
          aria-label="Channel type"
          className="h-8 px-2 rounded-[4px] bg-graphite border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
        >
          <option value="webhook">Webhook</option>
          <option value="email">Email</option>
        </select>
        <input
          type="text"
          value={channelTarget}
          onChange={(e) => setChannelTarget(e.target.value)}
          placeholder={channelType === 'webhook' ? 'https://…' : 'you@example.com'}
          aria-label="Channel target"
          className="flex-1 min-w-[160px] h-8 px-2 rounded-[4px] bg-graphite border border-graphite-light text-sm text-whiteout placeholder-pewter font-mono outline-none focus:ring-1 focus:ring-neon-glow"
        />
        <Button variant="primary" size="sm" onClick={() => { void handleCreate() }} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create rule'}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive-400">{error}</p>}
    </div>
  )
}

const MAX_CHANNELS = 5

interface EditFormState {
  name: string
  thresholdPct: string
  windowMinutes: string
  channels: AlertChannel[]
  newChannelType: 'webhook' | 'email'
  newChannelTarget: string
}

function toEditForm(rule: AlertRule): EditFormState {
  return {
    name: rule.name,
    thresholdPct: String(rule.thresholdPct ?? 50),
    windowMinutes: String(rule.windowMinutes ?? 60),
    channels: rule.channels,
    newChannelType: 'webhook',
    newChannelTarget: '',
  }
}

/** Client-side validation mirroring the backend (Team C's PUT /api/alerts/[id]):
 * thresholdPct 0-100 (failure_rate only), windowMinutes > 0 (failure_rate only),
 * 1-5 channels, each channel needs a non-empty type + target. */
function validateEditForm(form: EditFormState, kind: AlertRuleKind): string | null {
  if (!form.name.trim()) return 'Name is required'
  if (form.channels.length === 0) return 'At least one channel is required'
  if (form.channels.length > MAX_CHANNELS) return `At most ${String(MAX_CHANNELS)} channels are allowed`
  if (kind === 'failure_rate') {
    const pct = Number(form.thresholdPct)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 'Threshold must be between 0 and 100'
    const win = Number(form.windowMinutes)
    if (!Number.isFinite(win) || win <= 0) return 'Window minutes must be greater than 0'
  }
  return null
}

function RuleEditForm({
  rule,
  onSave,
  onCancel,
}: {
  rule: AlertRule
  onSave: (rule: AlertRule) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<EditFormState>(() => toEditForm(rule))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addChannel() {
    if (!form.newChannelTarget.trim()) return
    if (form.channels.length >= MAX_CHANNELS) {
      setError(`At most ${String(MAX_CHANNELS)} channels are allowed`)
      return
    }
    setError(null)
    setForm((f) => ({
      ...f,
      channels: [...f.channels, { type: f.newChannelType, target: f.newChannelTarget.trim() }],
      newChannelTarget: '',
    }))
  }

  function removeChannel(index: number) {
    setForm((f) => ({ ...f, channels: f.channels.filter((_, i) => i !== index) }))
  }

  async function handleSave() {
    const validationError = validateEditForm(form, rule.kind)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    setSubmitting(true)
    const { data, error: err } = await apiCall(`/api/alerts/${rule.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.trim(),
        channels: form.channels,
        ...(rule.kind === 'failure_rate' && {
          thresholdPct: Number(form.thresholdPct),
          windowMinutes: Number(form.windowMinutes),
        }),
      }),
    })
    setSubmitting(false)
    if (err) return setError(err)
    onSave((data as { rule: AlertRule }).rule)
  }

  return (
    <tr>
      <td colSpan={6} className="px-4 py-3 bg-graphite-deep">
        <div className="flex flex-col gap-3 p-3 rounded-[4px] border border-graphite-light bg-graphite">
          <div className="flex flex-wrap gap-2 items-center">
            <label className="flex items-center gap-1.5 text-xs text-pewter flex-1 min-w-[160px]">
              name
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="flex-1 h-8 px-2 rounded-[4px] bg-graphite-deep border border-graphite-light text-sm text-whiteout outline-none focus:ring-1 focus:ring-neon-glow"
              />
            </label>
            <span className="text-xs font-mono text-pewter shrink-0" title="Kind cannot be changed after creation — delete and recreate to change it.">
              kind: {KIND_LABEL[rule.kind]}
            </span>
          </div>

          {rule.kind === 'failure_rate' && (
            <div className="flex gap-2">
              <label className="flex items-center gap-1.5 text-xs text-pewter">
                threshold %
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={form.thresholdPct}
                  onChange={(e) => setForm((f) => ({ ...f, thresholdPct: e.target.value }))}
                  className="w-16 h-8 px-2 rounded-[4px] bg-graphite-deep border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-pewter">
                window (min)
                <input
                  type="number"
                  min={1}
                  value={form.windowMinutes}
                  onChange={(e) => setForm((f) => ({ ...f, windowMinutes: e.target.value }))}
                  className="w-20 h-8 px-2 rounded-[4px] bg-graphite-deep border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
                />
              </label>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-pewter uppercase tracking-wider">
              Channels ({form.channels.length}/{MAX_CHANNELS})
            </span>
            <div className="flex flex-wrap gap-1.5">
              {form.channels.map((c, i) => (
                <span
                  key={`${c.type}:${c.target}:${String(i)}`}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[4px] text-xs font-mono text-cloud bg-graphite-deep border border-graphite-light"
                >
                  {c.type}:{c.target}
                  <button
                    type="button"
                    onClick={() => removeChannel(i)}
                    aria-label={`Remove channel ${c.target}`}
                    className="text-pewter hover:text-destructive-400 transition-colors duration-100"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            {form.channels.length < MAX_CHANNELS && (
              <div className="flex flex-wrap gap-2 items-center">
                <select
                  value={form.newChannelType}
                  onChange={(e) => setForm((f) => ({ ...f, newChannelType: e.target.value as 'webhook' | 'email' }))}
                  className="h-8 px-2 rounded-[4px] bg-graphite-deep border border-graphite-light text-sm text-whiteout font-mono outline-none focus:ring-1 focus:ring-neon-glow"
                >
                  <option value="webhook">Webhook</option>
                  <option value="email">Email</option>
                </select>
                <input
                  type="text"
                  value={form.newChannelTarget}
                  onChange={(e) => setForm((f) => ({ ...f, newChannelTarget: e.target.value }))}
                  placeholder={form.newChannelType === 'webhook' ? 'https://…' : 'you@example.com'}
                  className="flex-1 min-w-[160px] h-8 px-2 rounded-[4px] bg-graphite-deep border border-graphite-light text-sm text-whiteout placeholder-pewter font-mono outline-none focus:ring-1 focus:ring-neon-glow"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addChannel()
                    }
                  }}
                />
                <Button variant="secondary" size="sm" onClick={addChannel}>
                  Add channel
                </Button>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-destructive-400">{error}</p>}

          <div className="flex items-center gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => { void handleSave() }} disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </td>
    </tr>
  )
}

function RuleRow({ rule, onChanged, onDeleted }: { rule: AlertRule; onChanged: (r: AlertRule) => void; onDeleted: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)

  async function toggleEnabled() {
    setBusy(true)
    const { data, error } = await apiCall(`/api/alerts/${rule.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !rule.enabled }),
    })
    setBusy(false)
    if (!error && data) onChanged((data as { rule: AlertRule }).rule)
  }

  async function handleDelete() {
    setBusy(true)
    const { error } = await apiCall(`/api/alerts/${rule.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!error) onDeleted(rule.id)
  }

  if (editing) {
    return (
      <RuleEditForm
        rule={rule}
        onSave={(r) => {
          onChanged(r)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <tr>
      <td className="px-4 py-2 text-sm text-neutral-200">{rule.name}</td>
      <td className="px-4 py-2 font-mono text-xs text-neutral-400">{KIND_LABEL[rule.kind]}</td>
      <td className="px-4 py-2 font-mono text-xs text-neutral-400">
        {rule.kind === 'failure_rate' ? `${String(rule.thresholdPct ?? '—')}% / ${String(rule.windowMinutes ?? '—')}m` : '—'}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-neutral-400">
        {rule.channels.map((c) => `${c.type}:${c.target}`).join(', ')}
      </td>
      <td className="px-4 py-2">
        <button
          type="button"
          onClick={() => { void toggleEnabled() }}
          disabled={busy}
          className={`text-xs font-mono ${rule.enabled ? 'text-neon-glow' : 'text-pewter'}`}
        >
          {rule.enabled ? 'enabled' : 'disabled'}
        </button>
      </td>
      <td className="px-4 py-2 text-right">
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className="text-xs text-neutral-400 hover:text-neutral-300 transition-colors"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => { void handleDelete() }}
            disabled={busy}
            className="text-xs text-destructive-400 hover:text-destructive-500 transition-colors"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  )
}

export function AlertsSection({ initialRules, initialEvents, isAdmin, loadError }: AlertsSectionProps) {
  const [rules, setRules] = useState<AlertRule[]>(initialRules)

  if (!isAdmin) {
    return (
      <Card>
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">Alerts</h2>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-neutral-500">
            Alert rule configuration is admin-only. Ask an org admin to make changes here.
          </p>
          {initialEvents.length > 0 && (
            <div className="mt-4">
              <FiringHistory events={initialEvents} />
            </div>
          )}
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">Alerts</h2>
        <p className="mt-0.5 text-xs text-neutral-400">
          Notify a webhook or email address when a run fails, the failure rate crosses a threshold, or an eval fails.
        </p>
      </div>

      <div className="px-5 py-4 flex flex-col gap-4">
        <RuleBuilder onCreated={(rule) => setRules((prev) => [rule, ...prev])} />

        {loadError ? (
          <p className="text-destructive-400 text-sm">{loadError}</p>
        ) : rules.length === 0 ? (
          <EmptyState title="No alert rules yet" description="Create one above to get notified about run failures, failure-rate spikes, or eval failures." />
        ) : (
          <div className="overflow-x-auto rounded-md border border-neutral-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-900">
                  <th className="px-4 py-2 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">Name</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">Kind</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">Threshold</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">Channels</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-neutral-400 uppercase tracking-wider">State</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                {rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    onChanged={(r) => setRules((prev) => prev.map((x) => (x.id === r.id ? r : x)))}
                    onDeleted={(id) => setRules((prev) => prev.filter((x) => x.id !== id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <FiringHistory events={initialEvents} />
      </div>
    </Card>
  )
}

function FiringHistory({ events }: { events: AlertEvent[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-pewter uppercase tracking-wider mb-2">Recent firing history</p>
      {events.length === 0 ? (
        <p className="text-sm text-neutral-500">No alerts have fired yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {events.map((e) => (
            <div key={e.id} className="flex items-center gap-2 px-3 py-2 rounded-[4px] border border-graphite bg-graphite-deep text-xs">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  e.deliveryStatus === 'delivered'
                    ? 'bg-neon-glow shadow-[var(--shadow-glow)]'
                    : e.deliveryStatus === 'failed'
                      ? 'bg-destructive-500 shadow-[var(--shadow-glow-warn)]'
                      : 'bg-pewter'
                }`}
                aria-hidden="true"
              />
              <span className="text-neutral-300 flex-1 truncate">{e.summary}</span>
              <span className="text-pewter font-mono">{e.deliveryStatus}</span>
              <span className="text-pewter font-mono shrink-0">{formatRelativeTime(e.firedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
