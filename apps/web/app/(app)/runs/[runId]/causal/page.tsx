/**
 * /runs/[runId]/causal — where did this run come from, and what ran on it.
 *
 * ===========================================================================
 * THE QUESTION THIS PAGE ANSWERS
 * ===========================================================================
 *
 * An operator is holding a failed run. Runs are isolated islands everywhere
 * else in this product, so "is this the cause or a symptom" has had no surface
 * at all. This page walks UP to whatever produced the run and DOWN to whatever
 * ran on its output, over RECORDED edges only.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THE WHOLE PAGE SERVES
 * ---------------------------------------------------------------------------
 *
 * A chain that ENDS and a chain whose TRAIL IS LOST are opposite claims. The
 * first closes an investigation; the second says it is unfinished — and the
 * second is the COMMON case, because recording is opt-in and best-effort. An
 * operator who reads a lost trail as an origin blames the wrong agent while
 * the real cause keeps firing.
 *
 * They are separate contract types sharing no field but the discriminant,
 * separate components, different DOM positions (an origin is a rung inside the
 * ladder's `<ol>`; a lost trail is an `<aside>` after it closes), words sharing
 * no substring, and different geometry. See `@/components/causal/Terminus`.
 *
 * ---------------------------------------------------------------------------
 * STATES
 * ---------------------------------------------------------------------------
 *
 * Loading is `loading.tsx`. The rest are explicit, distinct, and none shares
 * copy with another — and which one appears is decided by the CONTRACT's
 * verdict rule, never by an empty list:
 *
 *   chain_recorded   at least one recorded edge. The ladders.
 *   isolated         the walk FINISHED, read edge sets in full, and found no
 *                    edges. An earned answer, bounded in the same breath.
 *   indeterminate    no edges, and the walk did not finish. Not a result, and
 *                    the likeliest outcome during a real incident.
 *   error            the query failed. We know nothing and claim nothing.
 *
 * Auth: `(app)/layout.tsx` redirects unauthenticated users to /sign-in, and
 * the Convex query resolves the caller's org and membership BEFORE it observes
 * any run (CLAUDE.md Tenancy Rules). This page adds no client-side guard.
 */


import {
  DEFAULT_CAUSAL_MAX_DEPTH,
  lostTrails,
} from '@agent-flight-recorder/contracts'

import type { CausalTraversal, CausalVerdict } from '@agent-flight-recorder/contracts'
import type { Metadata } from 'next'

import { CausalChainView } from '@/components/causal/CausalChainView'
import {
  CausalWalkFailed,
  IncoherentTraversalNotice,
  NothingRecordedResult,
  WalkDidNotFinishResult,
} from '@/components/causal/CausalStates'
import { PageHeader } from '@/components/layout/PageHeader'
import { getCausalTraversal, type CausalFinding } from '@/lib/services/causal'

export const metadata: Metadata = { title: 'Causal chain' }

// Read from the URL on every request, so a walk can never be cached into a
// stale answer about an incident.
export const dynamic = 'force-dynamic'

/** Hard ceiling, mirroring the engine's own. A larger value is clamped there. */
const MAX_DEPTH = 16

interface CausalPageProps {
  params: { runId: string }
  searchParams: { depth?: string }
}

/**
 * Stable, shareable URLs: the depth lives in the query string, so a resumed
 * walk can be pasted into an incident channel and reopened identically.
 */
function resolveDepth(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CAUSAL_MAX_DEPTH
  return Math.min(n, MAX_DEPTH)
}

export default async function CausalPage({ params, searchParams }: CausalPageProps) {
  const runId = params.runId
  const base = `/runs/${encodeURIComponent(runId)}/causal`
  const depth = resolveDepth(searchParams.depth)
  const deeper = Math.min(depth * 2, MAX_DEPTH)

  const result = await getCausalTraversal(runId, depth)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Causal chain"
        subtitle="What produced this run, and what ran on its output. Every link on this page was recorded at the moment of the handoff — nothing here is inferred from timing, sessions or proximity."
      />

      <div className="mt-4 flex flex-col gap-4">
        {result.status === 'error' ? (
          <CausalWalkFailed message={result.message} retryHref={`${base}?depth=${depth}`} />
        ) : (
          <Outcome
            verdict={result.verdict}
            upstream={result.upstream}
            downstream={result.downstream}
            findings={result.findings}
            deeperHref={`${base}?depth=${deeper}`}
          />
        )}
      </div>
    </div>
  )
}

function Outcome({
  verdict,
  upstream,
  downstream,
  findings,
  deeperHref,
}: {
  verdict: CausalVerdict
  upstream: CausalTraversal
  downstream: CausalTraversal
  findings: readonly CausalFinding[]
  deeperHref: string
}) {
  // The verdict was computed by the contract's own rule in the service layer,
  // over both halves. This component switches on it and does not re-derive it
  // — a locally invented `isolated` is a locally invented all-clear.
  switch (verdict) {
    case 'chain_recorded':
      return <CausalChainView upstream={upstream} downstream={downstream} incoherences={findings} />

    case 'isolated':
      return (
        <>
          <IncoherentTraversalNotice findings={findings} />
          <NothingRecordedResult
            subjectRunId={upstream.subjectRunId}
            docsHref="/docs/sdk#causal-edges"
          />
        </>
      )

    case 'indeterminate':
    default:
      return (
        <>
          <IncoherentTraversalNotice findings={findings} />
          <WalkDidNotFinishResult
            scan={upstream.scan}
            reasons={[
              // The specific obstacles, in the contract's own words, from BOTH
              // halves. A generic shrug here is what teaches operators to click
              // past the only honest thing on the screen.
              ...[
                ...lostTrails(upstream).map((t) => ['upstream', t] as const),
                ...lostTrails(downstream).map((t) => ['downstream', t] as const),
              ].map(([dir, t]) => `${dir} ${t.kind}: ${t.lostBecause} — ${t.wouldBeRecoveredBy}`),
              ...[
                ...(Array.isArray(upstream.unanswered) ? upstream.unanswered : []),
                ...(Array.isArray(downstream.unanswered) ? downstream.unanswered : []),
              ].map((q) => `${q.kind}: ${q.unknownBecause}`),
            ]}
            continueHref={deeperHref}
          />
        </>
      )
  }
}
