// GET /api/agents/[agentId]/versions/compare?a=<versionIdA>&b=<versionIdB>&explain=1
//
// Clerk-authenticated. Wraps Team B's `convex/insights.ts` `compareVersions`
// query (the flagship "did version B regress vs version A" cohort
// comparison) and, when `explain=1` is present, additionally produces a
// grounded plain-English narrative via the pure `versionNarrative.ts`
// helper (Team C, Explainability Layer cycle 2) — see that file's header for
// the grounding guarantee.
//
// Query params: accepts BOTH `a`/`b` (this cycle's brief) AND `versionA`/
// `versionB` (the param names apps/web/src/lib/services/agent_versions.ts's
// `getVersionCompareNarrative` already guessed and shipped against, ahead of
// this route existing) — whichever pair is present wins, `a`/`b` take
// precedence if somehow both are given. This is a deliberate compatibility
// shim, not the "real" contract going forward; see this cycle's report for
// the recommendation to standardize on one pair once Team E's guess can be
// updated in the same PR as this route.
//
// Response shape:
//   {
//     agentId, versionA, versionB, comparison,   // passthrough of compareVersions
//     verdict?: 'regression' | 'improvement' | 'inconclusive' | 'insufficient_data',
//       // present only if explain=1 — simplified 4-value label (matches
//       // Team E's VersionCompareNarrativeVerdict guess exactly)
//     narrative?: string,
//       // present only if explain=1 — the plain-English narrative sentence(s)
//     narrativeDetail?: {
//       // present only if explain=1 — full structured result for consumers
//       // that want more than the flat verdict+narrative pair
//       significance: 'likely_regression' | 'likely_improvement' | 'inconclusive' | 'insufficient_data',
//       usedFailureClassBreakdown: boolean,
//       citedFailureClass?: string,
//     },
//   }
//
// `explain` is opt-in (rather than always-on) so existing/future callers of
// this endpoint that only want the raw cohort numbers (e.g. a lighter-weight
// UI table) are not forced to pay for narrative construction — though today
// that construction is pure/cheap, this keeps the contract explicit for
// whenever narrative generation grows a real LLM assist (see
// docs/design/explanations.md's provider-config section; this route does
// NOT call an LLM today, `versionNarrative.ts` is 100% deterministic).
//
// Error mapping: `fetchVersionComparisonRaw` throws Convex's afrError
// `CODE: message` strings verbatim (NOT_FOUND for an unknown/cross-org
// version, INVALID_ARGUMENT if the two versions don't share an agent,
// FORBIDDEN/UNAUTHORIZED from `requireOrgMembership`) — `mapApiError` turns
// each into the matching HTTP status. An unrecognized error is rethrown so
// `withApiHandler` logs it and returns a generic 500 (never silently a 200
// with an empty body).
import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import {
  fetchVersionComparisonRaw,
  narrateVersionComparison,
  resolveConvexOrgId,
} from '@/lib/services/versionCompareNarrative'
import { toSimpleVerdict } from '@/lib/versionNarrative'

interface RouteParams {
  params: { agentId: string }
}

export const GET = withApiHandler(
  '/api/agents/[agentId]/versions/compare',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    // Uses the same shared `hasOrgAuthContext` predicate as every sibling
    // Clerk-authed route (explanation GET/POST, alerts/webhooks-config) —
    // audited this cycle for consistency (this route previously duplicated
    // the userId/orgId check inline).
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    const clerkOrgId = authResult.orgId
    ctx.setOrgId(clerkOrgId)

    const searchParams = req.nextUrl.searchParams
    const versionIdA = searchParams.get('a') ?? searchParams.get('versionA')
    const versionIdB = searchParams.get('b') ?? searchParams.get('versionB')
    const explain = searchParams.get('explain') === '1'

    if (!versionIdA || !versionIdB) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'Both `a` and `b` version IDs are required' },
        { status: 422 },
      )
    }

    try {
      const convexOrgId = await resolveConvexOrgId(clerkOrgId)
      const raw = await fetchVersionComparisonRaw(convexOrgId, versionIdA, versionIdB)

      // Defense-in-depth: compareVersions only guarantees versionA/versionB
      // share an agent with EACH OTHER, not that either matches this route's
      // `[agentId]` path segment. A caller passing version IDs from a
      // different agent (even one they're a member of) should get a clean
      // 404, not cross-agent data leaking through this URL shape.
      if (raw.agentId !== params.agentId) {
        return NextResponse.json<ApiError>(
          { code: 'NOT_FOUND', message: 'Agent version not found for this agent' },
          { status: 404 },
        )
      }

      const narrativeResult = explain ? narrateVersionComparison(raw) : undefined

      return NextResponse.json({
        agentId: raw.agentId,
        versionA: raw.versionA,
        versionB: raw.versionB,
        comparison: raw.comparison,
        ...(narrativeResult && {
          verdict: toSimpleVerdict(narrativeResult.significance),
          narrative: narrativeResult.narrative,
          narrativeDetail: {
            significance: narrativeResult.significance,
            usedFailureClassBreakdown: narrativeResult.usedFailureClassBreakdown,
            ...(narrativeResult.citedFailureClass !== undefined && {
              citedFailureClass: narrativeResult.citedFailureClass,
            }),
          },
        }),
      })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Read traffic, same class as the sibling GET /api/agents/[agentId]/versions.
  { rateLimit: { key: 'org', limitPerMin: 180 } },
)
