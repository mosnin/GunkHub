'use client'

import {
  BUDGET_METERS,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  type BudgetMeter,
  type BudgetPeriod,
  type BudgetScope,
} from '@agent-flight-recorder/contracts'
import { useState } from 'react'


import type { BudgetRecord } from '@/lib/services/budgets'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import {
  budgetEvaluability,
  METER_IS_MEASURED,
  METER_LABEL,
  PERIOD_LABEL,
  SCOPE_LABEL,
} from '@/lib/budgets/evaluability'
import { formatRelativeTime } from '@/lib/utils'

/**
 * BUDGET CONFIGURATION AND STATE — create, inspect, trip and reset.
 *
 * ---------------------------------------------------------------------------
 * THE PERMISSION SPLIT IS NOT UNIFORM AND THIS COMPONENT MUST NOT EVEN IT OUT
 * ---------------------------------------------------------------------------
 *
 *   create / edit / delete   ADMIN
 *   trip                     MEMBER  <- withholding costs delay
 *   reset                    ADMIN   <- resuming costs money, without a ceiling
 *   (viewers may do none of it)
 *
 * The asymmetry is the risk's own. Requiring an admin to be awake before anyone
 * can pull the cord was the wrong constraint at 3am, and gating the resume
 * behind the same role as the withhold would have been the wrong constraint in
 * the other direction. THE AFFORDANCES ARE ONLY AFFORDANCES: Convex enforces
 * every one of these, so a hidden button is a courtesy, not a control.
 *
 * ---------------------------------------------------------------------------
 * WHAT EVERY ROW STATES BEFORE IT STATES ANYTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * Whether the budget can ever be evaluated at all — see
 * `lib/budgets/evaluability.ts`. Two of the five meters are refused outright by
 * the backend, and the wide (non-run) scopes can reach a limit but can never
 * establish headroom. An operator who configures one of those and then watches
 * it sit quietly forever will conclude either that the feature is broken or
 * that the silence means everything is fine, and the second reading is
 * available only because nothing said otherwise at configuration time. So the
 * create form says it while they are choosing, and every row repeats it.
 *
 * NOTHING IN HERE CLAIMS AN AGENT WAS STOPPED. "Tripped" is a fact about the
 * breaker; the trip's own sentence is the server's composed prose, rendered
 * verbatim.
 */
interface BudgetsSectionProps {
  /**
   * The org's budgets, or `null` WHEN THE READ FAILED.
   *
   * `null` rather than an empty array, and the distinction is the whole reason
   * the prop is typed this way: an empty list means "no budgets are configured"
   * and a failed read means "we do not know what budgets are configured". Those
   * two produce the same quiet screen if they share a representation, and one
   * of them is an organization believing it has cost control that it does not
   * have.
   */
  budgets: BudgetRecord[] | null
  /** Present iff `budgets` is `null`. */
  loadError: string | null
  orgRole: 'admin' | 'member' | 'viewer'
  /** The Convex org id — the `scopeId` an org-scoped budget must carry. */
  orgId: string
}

async function apiCall(path: string, init?: RequestInit): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(path, init)
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: (body['message'] as string | undefined) ?? `Server error ${res.status}` }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Network error — could not reach the server' }
  }
}

/**
 * A trip or reset, which cannot be sent without a reason.
 *
 * The reason field is REQUIRED at the point of the act rather than optional
 * with a default, because a manual trip has no meter reading behind it and a
 * reset discards evidence from the accounting window — in both cases the audit
 * entry's only content is the sentence a human wrote. A prefilled "manual
 * trip" would produce a plausible-looking audit row that nobody chose.
 */
function ReasonPrompt({
  action,
  budget,
  onDone,
  onCancel,
}: {
  action: 'trip' | 'reset'
  budget: BudgetRecord
  onDone: () => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    if (reason.trim().length === 0) {
      setError('A reason is required — it is written to the append-only audit log and is the only account of why.')
      return
    }
    setSubmitting(true)
    const { ok, error: err } = await apiCall(`/api/budgets/${budget.budgetId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() }),
    })
    setSubmitting(false)
    if (!ok) {
      setError(err ?? 'The request failed')
      return
    }
    onDone()
  }

  return (
    <div className="mt-3 rounded-[4px] border border-graphite-light bg-graphite p-3">
      <p className="text-sm text-whiteout">
        {action === 'trip'
          ? 'Trip this breaker by hand. It will withhold until an administrator resets it.'
          : 'Clear this trip and begin a new accounting period now. Spend already recorded in the current window ' +
            'leaves it, so this is the last place that fact is retained outside the audit log.'}
      </p>
      <label className="mt-2 block text-xs font-mono uppercase tracking-wider text-pewter" htmlFor={`reason-${budget.budgetId}`}>
        Reason (required, written to the audit log)
      </label>
      <textarea
        id={`reason-${budget.budgetId}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        className="mt-1 w-full rounded-[4px] border border-graphite-light bg-graphite-deep px-2 py-1.5 text-sm text-whiteout placeholder-pewter outline-none focus:ring-1 focus:ring-neon-glow"
        placeholder="Why are you doing this by hand?"
      />
      {error !== null && <p className="mt-2 text-sm text-ember leading-relaxed">{error}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant={action === 'reset' ? 'destructive' : 'primary'} onClick={() => void submit()} disabled={submitting}>
          {submitting ? 'Working…' : action === 'trip' ? 'Trip breaker' : 'Reset breaker'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function BudgetRow({
  budget,
  orgRole,
  onChanged,
}: {
  budget: BudgetRecord
  orgRole: 'admin' | 'member' | 'viewer'
  onChanged: () => void
}) {
  const [prompt, setPrompt] = useState<'trip' | 'reset' | null>(null)
  const evaluability = budgetEvaluability(budget.scope, budget.meter)
  const isTripped = budget.trippedAt !== undefined

  return (
    <li className="rounded-[4px] border border-graphite bg-graphite-deep p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-whiteout">{budget.name}</h3>
          <p className="mt-0.5 font-mono text-xs text-pewter">
            {SCOPE_LABEL[budget.scope]} · {METER_LABEL[budget.meter]} · {PERIOD_LABEL[budget.period]}
          </p>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-pewter">limit</span>
          <span className="font-mono text-sm text-whiteout tabular-nums">
            {budget.limitAmount.toLocaleString('en-US')}
          </span>
          <span className="font-mono text-xs text-pewter">
            {budget.currency ?? ''}
          </span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs text-pewter">{budget.budgetId}</code>
        <CopyToClipboardButton value={budget.budgetId} label="Copy budget id" />
        {!budget.enabled && (
          <span className="rounded-[4px] border border-graphite-light bg-graphite px-2 py-0.5 font-mono text-xs text-pewter">
            disabled — governs nothing
          </span>
        )}
      </div>

      {/* WHAT THIS BUDGET CAN ESTABLISH, on every row and not only on the form.
          A configuration whose breaker can never arm looks identical, at rest,
          to one that simply has room. */}
      <p
        className={
          evaluability.kind === 'meter_refused'
            ? 'mt-3 text-sm text-ember leading-relaxed'
            : 'mt-3 text-sm text-cloud leading-relaxed'
        }
      >
        <span className="font-mono text-xs uppercase tracking-wider">{evaluability.headline}</span>
        <br />
        {evaluability.explanation}
      </p>
      <p className="mt-1.5 text-sm text-pewter leading-relaxed">{evaluability.wouldBeImprovedBy}</p>

      {isTripped && (
        <div className="mt-3 rounded-[4px] border border-system-warning bg-graphite p-3">
          <p className="font-mono text-xs uppercase tracking-wider text-ember">
            Breaker tripped {budget.trippedAt !== undefined ? formatRelativeTime(budget.trippedAt) : ''}
            {budget.trippedBy === 'manual_trip' ? ' by an operator' : ''}
          </p>
          {budget.trippedBecause !== undefined && (
            <p className="mt-1 text-sm text-whiteout leading-relaxed">{budget.trippedBecause}</p>
          )}
          {budget.operatorNote !== undefined && (
            // Namespaced as a human's words. This product's execution-claim
            // guard applies to its own voice, not to an operator's account of
            // what they did — but a reader must never mistake one for the other.
            <p className="mt-1.5 text-sm text-cloud leading-relaxed">
              <span className="font-mono text-xs text-pewter">operator note: </span>
              {budget.operatorNote}
            </p>
          )}
        </div>
      )}

      {prompt !== null ? (
        <ReasonPrompt
          action={prompt}
          budget={budget}
          onDone={() => {
            setPrompt(null)
            onChanged()
          }}
          onCancel={() => setPrompt(null)}
        />
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Trip is MEMBER-permitted: withholding costs delay, and needing an
              admin awake to pull the cord is the wrong constraint at 3am. */}
          {!isTripped && orgRole !== 'viewer' && (
            <Button size="sm" variant="secondary" onClick={() => setPrompt('trip')}>
              Trip breaker
            </Button>
          )}
          {/* Reset is ADMIN-only: it resumes spend with no ceiling in front of it. */}
          {isTripped && orgRole === 'admin' && (
            <Button size="sm" variant="destructive" onClick={() => setPrompt('reset')}>
              Reset breaker
            </Button>
          )}
          {isTripped && orgRole !== 'admin' && (
            <p className="text-xs text-pewter">
              Clearing a trip resumes spend and is restricted to administrators.
            </p>
          )}
          {orgRole === 'viewer' && !isTripped && (
            <p className="text-xs text-pewter">Viewers can read breaker state but cannot change it.</p>
          )}
        </div>
      )}
    </li>
  )
}

function CreateBudgetForm({ orgId, onCreated }: { orgId: string; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<BudgetScope>('org')
  const [scopeId, setScopeId] = useState(orgId)
  const [meter, setMeter] = useState<BudgetMeter>('tokens_out')
  const [period, setPeriod] = useState<BudgetPeriod>('day')
  const [limitAmount, setLimitAmount] = useState('1000000')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Shown WHILE CHOOSING, not after saving. The whole point is that an operator
  // learns a cost budget can never be evaluated before they rely on one.
  const evaluability = budgetEvaluability(scope, meter)

  async function submit() {
    setError(null)
    const parsedLimit = Number(limitAmount)
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      setError("Limit must be a positive whole number in the meter's own unit.")
      return
    }
    setSubmitting(true)
    const { ok, error: err } = await apiCall('/api/budgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), scope, scopeId: scopeId.trim(), meter, period, limitAmount: parsedLimit }),
    })
    setSubmitting(false)
    if (!ok) {
      setError(err ?? 'The request failed')
      return
    }
    setName('')
    onCreated()
  }

  return (
    <div className="flex flex-col gap-3 rounded-[4px] border border-graphite bg-graphite-deep p-3">
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Budget name"
          aria-label="Budget name"
          className="h-8 min-w-[160px] flex-1 rounded-[4px] border border-graphite-light bg-graphite px-2 text-sm text-whiteout placeholder-pewter outline-none focus:ring-1 focus:ring-neon-glow"
        />
        <select
          value={scope}
          onChange={(e) => {
            const next = e.target.value as BudgetScope
            setScope(next)
            if (next === 'org') setScopeId(orgId)
          }}
          aria-label="Budget scope"
          className="h-8 rounded-[4px] border border-graphite-light bg-graphite px-2 font-mono text-sm text-whiteout outline-none focus:ring-1 focus:ring-neon-glow"
        >
          {BUDGET_SCOPES.map((s) => (
            <option key={s} value={s}>
              {SCOPE_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          value={meter}
          onChange={(e) => setMeter(e.target.value as BudgetMeter)}
          aria-label="Budget meter"
          className="h-8 rounded-[4px] border border-graphite-light bg-graphite px-2 font-mono text-sm text-whiteout outline-none focus:ring-1 focus:ring-neon-glow"
        >
          {BUDGET_METERS.map((m) => (
            <option key={m} value={m}>
              {/* The refusal is in the option itself, so it is legible in a
                  collapsed <select> and not only after choosing. */}
              {METER_LABEL[m]}
              {METER_IS_MEASURED[m] ? '' : ' — not measured'}
            </option>
          ))}
        </select>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
          aria-label="Budget period"
          className="h-8 rounded-[4px] border border-graphite-light bg-graphite px-2 font-mono text-sm text-whiteout outline-none focus:ring-1 focus:ring-neon-glow"
        >
          {BUDGET_PERIODS.map((p) => (
            <option key={p} value={p}>
              {PERIOD_LABEL[p]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="flex items-center gap-1.5 text-xs text-pewter">
          scopeId
          <input
            type="text"
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            className="h-8 w-[260px] rounded-[4px] border border-graphite-light bg-graphite px-2 font-mono text-sm text-whiteout outline-none focus:ring-1 focus:ring-neon-glow"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-pewter">
          limit
          <input
            type="number"
            min={1}
            step={1}
            value={limitAmount}
            onChange={(e) => setLimitAmount(e.target.value)}
            className="h-8 w-[140px] rounded-[4px] border border-graphite-light bg-graphite px-2 font-mono text-sm text-whiteout tabular-nums outline-none focus:ring-1 focus:ring-neon-glow"
          />
        </label>
      </div>

      <div
        className={
          evaluability.kind === 'meter_refused'
            ? 'rounded-[4px] border border-system-warning bg-graphite p-3'
            : 'rounded-[4px] border border-graphite-light bg-graphite p-3'
        }
      >
        <p
          className={
            evaluability.kind === 'meter_refused'
              ? 'font-mono text-xs uppercase tracking-wider text-ember'
              : 'font-mono text-xs uppercase tracking-wider text-neon-glow'
          }
        >
          {evaluability.headline}
        </p>
        <p className="mt-1 text-sm text-whiteout leading-relaxed">{evaluability.explanation}</p>
        <p className="mt-1.5 text-sm text-pewter leading-relaxed">{evaluability.wouldBeImprovedBy}</p>
      </div>

      {error !== null && <p className="text-sm text-ember leading-relaxed">{error}</p>}

      <div>
        <Button size="sm" variant="primary" onClick={() => void submit()} disabled={submitting || name.trim().length === 0}>
          {submitting ? 'Creating…' : 'Create budget'}
        </Button>
      </div>
    </div>
  )
}

export function BudgetsSection({ budgets, loadError, orgRole, orgId }: BudgetsSectionProps) {
  // A cheap way to re-pull server data after a mutation without holding a
  // second copy of it here: the page is a server component, so a reload is the
  // canonical read.
  const refresh = () => window.location.reload()

  // ERROR — never an empty list. See the prop's own doc.
  if (budgets === null) {
    return (
      <Card>
        <h2 className="text-sm font-semibold text-whiteout">Budgets</h2>
        <ErrorState
          title="Your budgets could not be read"
          message={
            (loadError ?? 'The request failed.') +
            ' Nothing is being concluded from this — in particular, this is NOT a report that you have no budgets ' +
            'configured.'
          }
          retry={refresh}
        />
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold text-whiteout">Budgets</h2>
        <span className="font-mono text-xs text-pewter tabular-nums">{budgets.length} configured</span>
      </div>

      {orgRole === 'admin' && (
        <div className="mt-3">
          <CreateBudgetForm orgId={orgId} onCreated={refresh} />
        </div>
      )}

      {budgets.length === 0 ? (
        <EmptyState
          title="No budgets are configured"
          description={
            'This is a confirmed read, not a failed one: nothing governs spend in this organization, so no breaker ' +
            'can withhold. Create a budget denominated in input or output tokens to give one something to measure.'
          }
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {budgets.map((budget) => (
            <BudgetRow key={budget.budgetId} budget={budget} orgRole={orgRole} onChanged={refresh} />
          ))}
        </ul>
      )}
    </Card>
  )
}
