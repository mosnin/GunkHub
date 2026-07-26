import Link from 'next/link'

import type { PolicyRecord } from '@/lib/services/policies'

import { PolicyEnableToggle } from '@/components/policies/PolicyEnableToggle'
import { ACT_KIND_LABEL } from '@/lib/policies/vocabulary'

/**
 * THE POLICIES AN ORGANIZATION HAS DEFINED.
 *
 * ===========================================================================
 * `interpretable: false` IS THE LOUDEST THING ON THIS SCREEN
 * ===========================================================================
 *
 * `convex/policies.ts` computes it per row: whether the engine can read the rule
 * at all. A row where it is `false` is a CONTROL AN OPERATOR BELIEVES IS IN
 * FORCE AND WHICH GRADES NOTHING — it appears in the list, it has a rationale,
 * it looks configured, and every run it governs comes back not-evaluable or
 * worse. The policy list is exactly where somebody looks to believe a control
 * exists, so this is stated on the row rather than discovered in a finding.
 *
 * It also FAILS CLOSED upstream: `readPolicyList` defaults a missing
 * `interpretable` to `false`, so a backend that stopped sending the field
 * reports every rule as uninterpretable rather than every rule as fine.
 *
 * ===========================================================================
 * A DISABLED POLICY IS SHOWN, AND IT IS NOT SHOWN AS SATISFIED
 * ===========================================================================
 *
 * A disabled policy governs nothing. It is NOT a policy that was evaluated and
 * found clean, and no evaluation may list it among the ones it checked. It stays
 * on this screen because switching a control off is a state somebody needs to
 * see, and because there is deliberately no delete — a policy that governed
 * recorded runs is part of how those runs were judged.
 */
interface PolicyDefinitionListProps {
  policies: readonly PolicyRecord[]
  /** Rows the read could not parse. Counted, never silently dropped. */
  unreadableRows: number
}

export function PolicyDefinitionList({ policies, unreadableRows }: PolicyDefinitionListProps) {
  if (policies.length === 0 && unreadableRows === 0) {
    return (
      <article className="rounded-[4px] border border-graphite-light bg-graphite-deep p-4">
        <h3 className="text-sm font-semibold text-whiteout">NO POLICY IS DEFINED</h3>
        <p className="mt-2 text-sm text-cloud leading-relaxed">
          Nothing governs this organization, so nothing is being checked. This is not a clean result — it is the
          absence of any control at all, and it is also what a deleted or badly migrated policy set looks like.
          Define a policy below to state what must not happen.
        </p>
      </article>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {unreadableRows > 0 ? (
        <article className="rounded-[4px] border border-system-warning bg-graphite-deep p-3">
          <h3 className="text-sm font-semibold text-whiteout">
            {unreadableRows} POLICY ROW(S) COULD NOT BE READ
          </h3>
          <p className="mt-1 text-sm text-cloud leading-relaxed">
            They are counted rather than hidden. An unreadable row is exactly as likely to be a control you depend
            on as any other, and this list is not a complete account of your policies while this number is
            non-zero.
          </p>
        </article>
      ) : null}

      <ul className="flex flex-col gap-2">
        {policies.map((policy) => (
          <li
            key={policy.policyId}
            className="rounded-[4px] border border-graphite-light bg-graphite-deep p-3"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-sm font-semibold text-whiteout">
                {ACT_KIND_LABEL[policy.prohibits] ?? policy.prohibits} forbidden
              </h3>
              <code className="text-xs font-mono text-neon-glow break-all">
                {policy.matcher.match === 'domain_suffix'
                  ? `${policy.matcher.value} and its subdomains`
                  : policy.matcher.value}
              </code>
              <span className="text-xs font-mono text-pewter">
                scope {policy.scope}:{policy.scopeId}
              </span>
              <code className="text-xs font-mono text-pewter">{policy.policyId}</code>
              <span className="text-xs font-mono text-pewter tabular-nums">
                {policy.revision === undefined
                  ? 'revision not returned by this deployment'
                  : `revision ${policy.revision}`}
              </span>
            </div>

            <p className="mt-2 text-sm text-cloud leading-relaxed">{policy.rationale}</p>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-xs font-mono text-whiteout">
                {policy.enabled ? 'IN FORCE' : 'SWITCHED OFF — governs nothing'}
              </span>
              {/* ENABLEMENT IS READ BEFORE THE RULE, mirroring the evaluator's
                  own precedence (a disabled policy reports `policy_disabled`
                  rather than a rule complaint). The ordering is not cosmetic: on
                  a policy nobody switched on, "your rule is broken" sends an
                  operator to fix something that is not the reason nothing is
                  being graded, and they fix the rule and still see no coverage.
                  A switched-off policy says only that it is switched off. */}
              {policy.enabled && !policy.interpretable ? (
                <span className="text-xs text-whiteout leading-relaxed">
                  THIS RULE CANNOT BE INTERPRETED BY THE ENGINE. It is in force, it appears configured, and it
                  grades nothing. Every run it governs will come back not evaluable until the rule is fixed.
                </span>
              ) : null}
              <Link
                href={`/settings/policies/${policy.policyId}`}
                className="text-xs font-mono text-cloud underline underline-offset-2"
              >
                evaluate against recorded runs
              </Link>
              <PolicyEnableToggle policyId={policy.policyId} enabled={policy.enabled} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
