import type { Metadata } from 'next'

import { PolicyDefinitionList } from '@/components/policies/PolicyDefinitionList'
import { PolicyForm } from '@/components/policies/PolicyForm'
import { ErrorState } from '@/components/ui/ErrorState'
import { getCurrentAuth } from '@/lib/auth'
import { resolveConvexOrgId } from '@/lib/convexServer'
import { listPolicies, type PolicyListRead } from '@/lib/services/policies'

export const metadata: Metadata = { title: 'Policies — Settings' }

/**
 * /settings/policies — declarative policy definitions (ADR-009).
 *
 * ===========================================================================
 * THIS PAGE STATES WHAT THE FEATURE CAN AND CANNOT ESTABLISH, ABOVE THE LIST
 * ===========================================================================
 *
 * Not as a disclaimer nobody reads, and not because the feature is unfinished.
 * `satisfied` is UNCONSTRUCTIBLE in this product today — contracts requires a
 * `CompleteInstrumentationClaim` on the licence, and nothing declares one,
 * because `packages/sdk/src`'s `toolCall`, `httpRequest` and `llmRequest` are
 * manual builders with no interception anywhere. So every honest outcome is
 * `violated` or `not_evaluable`, and it will stay that way until agents declare.
 *
 * An operator who meets that state with no explanation concludes one of two
 * things, and both are expensive: that the product is broken (and files a bug
 * whose "fix" is to loosen the type), or that the quiet screen means everything
 * is fine (and forwards it to somebody who cannot check). The paragraph below
 * exists to make the third reading — "this is the honest answer and here is what
 * would change it" — the easiest one.
 *
 * ===========================================================================
 * THE READ FAILS AS A FAILURE, NEVER AS AN EMPTY LIST
 * ===========================================================================
 *
 * `getCurrentAuth()` throws when there is no session or no org, which the route
 * group's error boundary renders; there is no client-side guard here and must
 * not be one. The policy read is caught on its own and carried to the screen as
 * a FAILURE — a `?? []` would produce the quiet screen that means "you have no
 * controls configured" out of an outage, and on this screen that quiet reads as
 * reassurance.
 */
export default async function SettingsPoliciesPage() {
  const { orgId: clerkOrgId } = getCurrentAuth()

  let convexOrgId = ''
  let read: PolicyListRead | null = null
  let readError: string | null = null
  try {
    convexOrgId = await resolveConvexOrgId(clerkOrgId)
    read = await listPolicies()
  } catch (err) {
    read = null
    readError = err instanceof Error ? err.message : 'Failed to read policies'
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-sm font-semibold text-whiteout">Policies</h1>
        <p className="text-sm text-cloud leading-relaxed">
          A policy states what must not happen — &ldquo;this agent may not call that tool&rdquo;, &ldquo;no run in
          this environment may make an HTTP request to that host&rdquo;. Policies are evaluated over runs this
          system already recorded. Nothing here runs your agent, and nothing here can stop one: whatever an agent
          does, this product records it, and a recorded breach is the most valuable row in the log.
        </p>
      </header>

      <article className="rounded-[4px] border border-graphite-light bg-graphite-deep p-4">
        <h2 className="text-sm font-semibold text-whiteout">
          What this feature can establish today, and what it cannot
        </h2>
        <p className="mt-2 text-sm text-cloud leading-relaxed">
          A VIOLATION IS PROVABLE. If a run recorded the operation a policy forbids, that is a fact in an
          append-only log, it names the events that show it, and it stays true even when the rest of the scan was
          incomplete.
        </p>
        <p className="mt-2 text-sm text-cloud leading-relaxed">
          THE ABSENCE OF A VIOLATION IS NOT. The SDK records a tool call, an HTTP request or a model call only when
          your code invokes the builder for it — nothing proxies, wraps or intercepts anything. An act performed
          outside the recorded path leaves no row whose absence this system could detect, so an empty result is a
          statement about the log and not about what the agent did. Every policy will therefore report NOT
          EVALUABLE rather than a clean result, and that is the honest answer rather than a defect.
        </p>
        <p className="mt-2 text-sm text-whiteout leading-relaxed">
          What would change it: an agent version declaring that it performs no act of the relevant kind outside the
          recorded path. That declaration is falsifiable — a later recorded act through an unrecorded route
          contradicts it — which is what would make an all-clear mean something. Until then, do not quote a policy
          result as evidence that nothing happened.
        </p>
      </article>

      {readError !== null || read === null ? (
        <ErrorState
          title="The policy list could not be read"
          message={
            (readError ?? 'Unknown error') +
            ' — this is shown as a failure rather than as an empty list, because an organization with no controls ' +
            'and an organization whose controls could not be read must never produce the same screen.'
          }
        />
      ) : read.kind === 'unreadable' ? (
        <ErrorState title="The policy list could not be read" message={read.because} />
      ) : (
        <PolicyDefinitionList policies={read.policies} unreadableRows={read.unreadableRows} />
      )}

      {convexOrgId === '' ? null : <PolicyForm orgConvexId={convexOrgId} />}
    </div>
  )
}
