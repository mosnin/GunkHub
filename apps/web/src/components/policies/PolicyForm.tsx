'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/Button'

/**
 * DEFINE A POLICY — "agent X may not call tool Y", "no run in env Z may egress
 * to host H".
 *
 * ===========================================================================
 * WHAT THIS FORM CANNOT OFFER, AND WHY THAT IS THE DESIGN
 * ===========================================================================
 *
 * There is no "action on violation" field. No block, no alert-and-halt, no
 * severity that gates recording. A policy says what must not happen; it has no
 * say over the event that shows it happened, because the answer there is always
 * the same — record it. The breach is the most valuable row in the log and the
 * exact run a regulator will ask for. Adding a control here would reopen
 * ADR-009's invariant 0, which is not a form field's decision.
 *
 * ===========================================================================
 * THE RATIONALE IS REQUIRED, AND THE FORM SAYS WHY WHILE YOU ARE WRITING IT
 * ===========================================================================
 *
 * It travels into EVERY outcome this policy produces. A violation on a screen at
 * 3am states its own justification rather than a policy id somebody has to go
 * and look up, and six months later it is the only record of what the rule was
 * for. That is why it is not optional and not defaulted.
 *
 * ===========================================================================
 * WHAT THE FORM TELLS YOU BEFORE YOU CHOOSE
 * ===========================================================================
 *
 * `egress_denied` matches the host AND ITS SUBDOMAINS, at the label boundary —
 * so `evil.example` covers `api.evil.example` and does NOT cover
 * `myevil.example`. `tool_denied` matches the tool name exactly. An operator who
 * does not know which they are getting will write the wrong rule and it will
 * grade quietly for months, so the form states it at the point of choosing
 * rather than in documentation.
 */
interface PolicyFormProps {
  /** Resolved server-side. An org-scoped policy's scopeId must be this org's own id. */
  orgConvexId: string
}

type RuleKind = 'tool_denied' | 'egress_denied'
type SubjectKind = 'org' | 'project' | 'agent' | 'environment'

export function PolicyForm({ orgConvexId }: PolicyFormProps) {
  const router = useRouter()
  const [ruleKind, setRuleKind] = useState<RuleKind>('tool_denied')
  const [value, setValue] = useState('')
  const [subjectKind, setSubjectKind] = useState<SubjectKind>('org')
  const [subjectValue, setSubjectValue] = useState('')
  const [name, setName] = useState('')
  const [rationale, setRationale] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(): Promise<void> {
    setError(null)
    setPending(true)
    try {
      const subject =
        subjectKind === 'org'
          ? { appliesTo: 'org' as const }
          : subjectKind === 'project'
            ? { appliesTo: 'project' as const, projectId: subjectValue }
            : subjectKind === 'agent'
              ? { appliesTo: 'agent' as const, agentId: subjectValue }
              : { appliesTo: 'environment' as const, environment: subjectValue }

      const rule =
        ruleKind === 'tool_denied'
          ? { kind: 'tool_denied' as const, deniedTools: [value] }
          : { kind: 'egress_denied' as const, deniedHosts: [value] }

      const res = await fetch('/api/policies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, rule, subject, rationale, enabled: true }),
      })
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null)
        const message =
          body !== null && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
            ? (body as { message: string }).message
            : `The request failed with status ${res.status}.`
        // SURFACED VERBATIM. The server's refusals here name exactly what this
        // backend cannot store and why — a rule that denies a whole operation, an
        // empty list, more than one value — and paraphrasing them would turn a
        // usable message into "invalid input".
        setError(message)
        return
      }
      setValue('')
      setName('')
      setRationale('')
      setSubjectValue('')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The request could not be sent.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-[4px] border border-graphite-light bg-graphite-deep p-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <h2 className="text-sm font-semibold text-whiteout">Define a policy</h2>
      <p className="text-sm text-cloud leading-relaxed">
        A policy states what must not happen. It is evaluated over runs this system already recorded — it does not
        run your agent and it cannot stop one. Whatever an agent does, this product records it.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-mono uppercase tracking-wider text-pewter">Forbids</span>
          <select
            value={ruleKind}
            onChange={(event) => setRuleKind(event.target.value as RuleKind)}
            className="rounded-[4px] border border-graphite-light bg-graphite px-2 py-1 text-sm font-mono text-whiteout"
          >
            <option value="tool_denied">calling a tool (exact name)</option>
            <option value="egress_denied">HTTP request to a host (and its subdomains)</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-mono uppercase tracking-wider text-pewter">
            {ruleKind === 'tool_denied' ? 'Tool name' : 'Host'}
          </span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="rounded-[4px] border border-graphite-light bg-graphite px-2 py-1 text-sm font-mono text-whiteout"
            placeholder={ruleKind === 'tool_denied' ? 'shell.exec' : 'paste.example.com'}
          />
        </label>
      </div>

      <p className="text-xs text-cloud leading-relaxed">
        {ruleKind === 'tool_denied'
          ? 'Matched EXACTLY against the recorded tool name. A tool called under a different name is a different rule.'
          : 'Matched at the label boundary, so this covers the host AND its subdomains — evil.example covers api.evil.example and does NOT cover myevil.example.'}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-mono uppercase tracking-wider text-pewter">Applies to</span>
          <select
            value={subjectKind}
            onChange={(event) => setSubjectKind(event.target.value as SubjectKind)}
            className="rounded-[4px] border border-graphite-light bg-graphite px-2 py-1 text-sm font-mono text-whiteout"
          >
            <option value="org">the whole organization</option>
            <option value="project">one project</option>
            <option value="agent">one agent</option>
            <option value="environment">runs labelled with an environment</option>
          </select>
        </label>

        {subjectKind === 'org' ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-mono uppercase tracking-wider text-pewter">Organization</span>
            <code className="rounded-[4px] border border-graphite-light bg-graphite px-2 py-1 text-sm font-mono text-pewter break-all">
              {orgConvexId}
            </code>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-mono uppercase tracking-wider text-pewter">
              {subjectKind === 'environment' ? 'Environment label' : `${subjectKind} id`}
            </span>
            <input
              value={subjectValue}
              onChange={(event) => setSubjectValue(event.target.value)}
              className="rounded-[4px] border border-graphite-light bg-graphite px-2 py-1 text-sm font-mono text-whiteout"
            />
          </label>
        )}
      </div>

      {subjectKind === 'environment' ? (
        // ADR-009 §7.3, stated at the point of choosing rather than discovered
        // in a finding. This is the one subject that is not a node of the entity
        // hierarchy and not a trust boundary.
        <p className="text-xs text-whiteout leading-relaxed">
          `environment` is a LABEL THE CLIENT CHOSE, not a trust boundary. An agent that mislabels its environment
          is outside every rule scoped this way and nothing detects it. A result over this subject covers runs that
          SAID they were in that environment.
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-xs font-mono uppercase tracking-wider text-pewter">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-[4px] border border-graphite-light bg-graphite px-2 py-1 text-sm text-whiteout"
          placeholder="No shell execution from customer-facing agents"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-mono uppercase tracking-wider text-pewter">
          Why this act is forbidden (required)
        </span>
        <textarea
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          rows={3}
          className="rounded-[4px] border border-graphite-light bg-graphite px-2 py-1 text-sm text-whiteout"
          placeholder="SOC2 CC6.1 — no shell execution from customer-facing agents."
        />
        <span className="text-xs text-cloud leading-relaxed">
          This sentence travels into every outcome this policy produces, so a finding states its own justification
          rather than a policy id somebody has to go and look up.
        </span>
      </label>

      {error === null ? null : <p className="text-sm text-ember leading-relaxed">{error}</p>}

      <div>
        <Button
          type="submit"
          disabled={pending || value.length === 0 || rationale.length === 0 || name.length === 0}
        >
          {pending ? 'Recording…' : 'Define policy'}
        </Button>
      </div>
    </form>
  )
}
