// Typed Convex function references — used instead of generated api types.
// These paths match the file:function naming convention Convex uses.
// When convex/_generated/ is available (after `npx convex dev`), use api.* instead.

import { makeFunctionReference } from 'convex/server'

import type { BudgetMeter, BudgetPeriod, BudgetScope } from '@agent-flight-recorder/contracts'

type Q = 'query'
type M = 'mutation'
type A = 'action'

/**
 * Args for both directional causal walks, mirroring
 * `convex/causality.ts`'s `{ runId: v.id("runs"), maxDepth: v.optional(v.number()) }`.
 *
 * Declared once so the two refs cannot drift apart from each other, which is
 * how one of them ends up called with a field the other renamed.
 *
 * A `type` and not an `interface`, and that is load-bearing rather than style:
 * Convex constrains args to `DefaultFunctionArgs` (`Record<string, unknown>`),
 * and TypeScript gives type aliases an implicit index signature while
 * interfaces get none. As an interface this does not compile.
 */
type CausalWalkArgs = {
  runId: string
  maxDepth?: number
}

/**
 * The narrowing ids a breaker evaluation accepts, mirroring
 * `convex/budgets.ts`'s `checkBudget` validator.
 *
 * Declared once and shared with {@link SdkBudgetSubjectArgs}'s body so the two
 * evaluation doors cannot drift into asking different questions — which, for a
 * breaker, means the web UI and the SDK disagreeing about which budgets govern
 * a subject.
 */
type BudgetNarrowingArgs = {
  projectId?: string
  agentId?: string
  agentVersionId?: string
  runId?: string
}

/** Clerk-authed evaluation: the org is NAMED, and Convex re-checks membership in it. */
type BudgetSubjectArgs = BudgetNarrowingArgs & { orgId: string }

/**
 * Key-authed evaluation: the org comes from the KEY and there is deliberately
 * no `orgId` field to supply one. See `convex/budget_gate.ts`.
 */
type SdkBudgetSubjectArgs = BudgetNarrowingArgs & { apiKeyHash: string }

/**
 * Mirrors `convex/budgets.ts`'s `createBudget` validator.
 *
 * The vocabularies are the CONTRACT'S (`BudgetScope` / `BudgetMeter` /
 * `BudgetPeriod`), imported rather than respelled — a locally retyped union is
 * exactly the second source of truth CLAUDE.md's Repo Conventions -> Types
 * forbids, and here a drifted spelling is an `ArgumentValidationError` at
 * runtime that nothing catches at build time.
 */
type CreateBudgetArgs = {
  orgId: string
  name: string
  scope: BudgetScope
  scopeId: string
  meter: BudgetMeter
  period: BudgetPeriod
  limitAmount: number
  currency?: string
  rearmOnPeriodRoll?: boolean
  enabled?: boolean
}

/**
 * Mirrors `convex/budgets.ts`'s `updateBudget` validator.
 *
 * NOTE WHAT IS NOT HERE: no way to clear a trip. `updateBudget` deliberately
 * cannot, because raising a limit is not a decision that the earlier, proven
 * breach did not happen — only `resetBudget` clears one, and it is behind a
 * different (admin) gate for that reason.
 */
type UpdateBudgetArgs = {
  budgetId: string
  name?: string
  enabled?: boolean
  limitAmount?: number
  rearmOnPeriodRoll?: boolean
}

export const convex = {
  agents: {
    listAgents: makeFunctionReference<Q>('agents:listAgents'),
    getAgent: makeFunctionReference<Q>('agents:getAgent'),
    listAgentsByOrg: makeFunctionReference<Q>('agents:listAgentsByOrg'),
    createAgent: makeFunctionReference<M>('agents:createAgent'),
  },
  agent_versions: {
    createAgentVersion: makeFunctionReference<M>('agent_versions:createAgentVersion'),
    listAgentVersions: makeFunctionReference<Q>('agent_versions:listAgentVersions'),
    getAgentVersion: makeFunctionReference<Q>('agent_versions:getAgentVersion'),
    paginateAgentVersions: makeFunctionReference<Q>('agent_versions:paginateAgentVersions'),
  },
  projects: {
    listProjects: makeFunctionReference<Q>('projects:listProjects'),
    getProject: makeFunctionReference<Q>('projects:getProject'),
    createProject: makeFunctionReference<M>('projects:createProject'),
  },
  organizations: {
    getOrganization: makeFunctionReference<Q>('organizations:getOrganization'),
    getOrganizationSettings: makeFunctionReference<Q>('organizations:getOrganizationSettings'),
    listMemberships: makeFunctionReference<Q>('organizations:listMemberships'),
    upsertOrganization: makeFunctionReference<M>('organizations:upsertOrganization'),
    upsertMembership: makeFunctionReference<M>('organizations:upsertMembership'),
    updateRetentionPolicy: makeFunctionReference<M>('organizations:updateRetentionPolicy'),
  },
  api_keys: {
    createApiKey: makeFunctionReference<M>('api_keys:createApiKey'),
    listApiKeys: makeFunctionReference<Q>('api_keys:listApiKeys'),
    revokeApiKey: makeFunctionReference<M>('api_keys:revokeApiKey'),
  },
  runs: {
    listRuns: makeFunctionReference<Q>('runs:listRuns'),
    listRunsByVerification: makeFunctionReference<Q>('runs:listRunsByVerification'),
    getRun: makeFunctionReference<Q>('runs:getRun'),
    createRun: makeFunctionReference<M>('runs:createRun'),
    updateRunTags: makeFunctionReference<M>('runs:updateRunTags'),
    // ADR-002 — run hierarchy / sessions / environment / triage / search
    // (Team A, convex/runs.ts, landed this cycle — see adr002.test.ts).
    setRunLabels: makeFunctionReference<M>('runs:setRunLabels'),
    setRunTriage: makeFunctionReference<M>('runs:setRunTriage'),
    searchRuns: makeFunctionReference<Q>('runs:searchRuns'),
    listSessionRuns: makeFunctionReference<Q>('runs:listSessionRuns'),
    listChildRuns: makeFunctionReference<Q>('runs:listChildRuns'),
  },
  // Cross-run causal graph (Team A, convex/causality.ts). Read-only here: the
  // web app never records an edge from a page, because an edge must be written
  // at the moment of the handoff by whatever performed it — a UI that could
  // add one after the fact would be a UI that can manufacture evidence.
  //
  // ---------------------------------------------------------------------
  // THE ONLY REFS IN THIS FILE THAT DECLARE THEIR ARGS AND RETURN
  // ---------------------------------------------------------------------
  //
  // `makeFunctionReference<type, args = any, ret = any>` — BOTH DEFAULT TO
  // `any`. Every bare ref above therefore hands `any` to its caller, and
  // `client.query(...)` returns `any` with nothing objecting. That is the seam
  // scripts/check-convex-refs.ts exists to police precisely because there is no
  // structural typecheck across it.
  //
  // ARGS ARE DECLARED, and that part is a real check: a call whose shape drifts
  // from `convex/causality.ts`'s validator is now a compile error here rather
  // than an ArgumentValidationError at runtime.
  //
  // THE RETURN IS `unknown`, DELIBERATELY, AND NOT `CausalTraversal`.
  //
  // Declaring the contract type here would be an ASSERTION, not a check —
  // nothing verifies a string-named reference against the function it names, so
  // the type parameter would promise a guarantee the value never had. That is
  // exactly the phantom-type-parameter shape that made
  // `getCausalTrace<'upstream'>({ direction: 'component' })` typecheck and
  // return a traversal containing a `RecordedOrigin`: a type parameter that
  // looked like a barrier and constrained nothing.
  //
  // `unknown` is the true statement. It removes the `any` — which silently
  // switches off every rule downstream — while forcing the response through
  // `auditTraversal`, whose whole job is to establish what actually arrived.
  causality: {
    traceRunOrigin: makeFunctionReference<Q, CausalWalkArgs, unknown>(
      'causality:traceRunOrigin',
    ),
    traceRunImpact: makeFunctionReference<Q, CausalWalkArgs, unknown>(
      'causality:traceRunImpact',
    ),
    // Kept so an existing caller gets the engine's explanation rather than a
    // missing-function error. It THROWS `INVALID_ARGUMENT`: a component
    // traversal cannot be represented under the causal contract, because
    // `ComponentTerminus` has no origin arm and a fully-closed component then
    // has no valid terminus for a non-empty tuple. Nothing in apps/web calls it.
    getIncidentGraph: makeFunctionReference<Q, CausalWalkArgs, never>(
      'causality:getIncidentGraph',
    ),
  },
  events: {
    listEvents: makeFunctionReference<Q>('events:listEvents'),
    getEvent: makeFunctionReference<Q>('events:getEvent'),
    createEvent: makeFunctionReference<M>('events:createEvent'),
  },
  artifacts: {
    listArtifacts: makeFunctionReference<Q>('artifacts:listArtifacts'),
    getArtifact: makeFunctionReference<Q>('artifacts:getArtifact'),
  },
  comments: {
    listComments: makeFunctionReference<Q>('comments:listComments'),
    createComment: makeFunctionReference<M>('comments:createComment'),
    resolveComment: makeFunctionReference<M>('comments:resolveComment'),
  },
  // ADR-007 OTLP/HTTP trace ingest. Consumed by
  // apps/web/src/lib/services/otel_ingest.ts, behind POST /api/v1/traces.
  otel_ingest: {
    otelIngestSpans: makeFunctionReference<M>('otel_ingest:otelIngestSpans'),
  },
  sdk_ingest: {
    checkIngestAuth: makeFunctionReference<Q>('sdk_ingest:checkIngestAuth'),
    sdkCreateRun: makeFunctionReference<M>('sdk_ingest:sdkCreateRun'),
    sdkCreateEvents: makeFunctionReference<M>('sdk_ingest:sdkCreateEvents'),
    sdkUpdateRunStatus: makeFunctionReference<M>('sdk_ingest:sdkUpdateRunStatus'),
    sdkCreateArtifact: makeFunctionReference<M>('sdk_ingest:sdkCreateArtifact'),
  },
  audit: {
    listAuditLog: makeFunctionReference<Q>('audit:listAuditLog'),
  },
  projection_verify: {
    getVerificationResult: makeFunctionReference<Q>('projection_verify:getVerificationResult'),
    batchGetVerificationResults: makeFunctionReference<Q>('projection_verify:batchGetVerificationResults'),
    listRecentFailedVerifications: makeFunctionReference<Q>('projection_verify:listRecentFailedVerifications'),
    reverifyRun: makeFunctionReference<A>('projection_verify:reverifyRun'),
  },
  // --- Team C (action layer), Cycle 2 ---------------------------------------
  // convex/read_api.ts (Team A) landed as `mutation`s, not `query`s — the
  // per-key rate-limit/lastUsedAt bookkeeping they share with sdk_ingest.ts
  // requires write access to the api_keys document (see that file's header
  // comment). Refs stay string-based (makeFunctionReference) rather than
  // imports from convex/_generated/api per this repo's convention.
  read_api: {
    apiListRuns: makeFunctionReference<M>('read_api:apiListRuns'),
    apiGetRun: makeFunctionReference<M>('read_api:apiGetRun'),
    apiGetRunEvents: makeFunctionReference<M>('read_api:apiGetRunEvents'),
    apiGetReplay: makeFunctionReference<M>('read_api:apiGetReplay'),
    apiGetExplanation: makeFunctionReference<M>('read_api:apiGetExplanation'),
    apiListFailurePatterns: makeFunctionReference<M>('read_api:apiListFailurePatterns'),
    // ADR-008 replay divergence, key-authed public read surface. MUTATIONS
    // like every other read_api function (they all do per-key rate-limit /
    // lastUsedAt bookkeeping) even though they are reads to the caller.
    //
    // These are what let anything OUTSIDE the web app reach the engine: `afr
    // compat` in CI, and the MCP tools an agent uses to ask whether its own
    // next version is safe to ship. The Clerk-authed `convex.divergence.*`
    // refs above cannot serve them — they resolve a Clerk org from the
    // session, and an API key has none.
    apiCompareVersionConfigs: makeFunctionReference<M>('read_api:apiCompareVersionConfigs'),
    apiGetRunDivergence: makeFunctionReference<M>('read_api:apiGetRunDivergence'),
    apiGetFleetDivergence: makeFunctionReference<M>('read_api:apiGetFleetDivergence'),
    // ADR-006 cycle 2 — the v1 public read API's per-pattern resolution
    // evidence (Team D's services/api_v1.ts + app/api/v1 route, backing
    // `afr patterns evidence`). A MUTATION like every other read_api
    // function (they all do per-key rate-limit/lastUsedAt bookkeeping).
    //   apiGetFailurePatternEvidence({ apiKeyHash, fingerprintHash })
    //     => { pattern, resolution, exposure, transitions, confidence } | null
    // NOTE this v1 shape carries Team B's graded `confidence`, which the
    // Clerk-authed `failure_patterns:getPatternResolutionEvidence` does NOT —
    // see that ref's note below.
    apiGetFailurePatternEvidence: makeFunctionReference<M>('read_api:apiGetFailurePatternEvidence'),
  },
  // convex/alerts.ts already exists (data agent, ADR-002/003) — the management
  // API routes wrap these directly.
  alerts: {
    listAlertRules: makeFunctionReference<Q>('alerts:listAlertRules'),
    createAlertRule: makeFunctionReference<M>('alerts:createAlertRule'),
    updateAlertRule: makeFunctionReference<M>('alerts:updateAlertRule'),
    deleteAlertRule: makeFunctionReference<M>('alerts:deleteAlertRule'),
    listAlertEvents: makeFunctionReference<Q>('alerts:listAlertEvents'),
    listAlertEventsForRule: makeFunctionReference<Q>('alerts:listAlertEventsForRule'),
  },
  // convex/webhooks.ts already exists (data agent, ADR-002/003) — the
  // management API routes wrap these directly. Named to match the convex
  // file (`webhooks:*`); the HTTP surface lives under /api/webhooks-config to
  // avoid colliding with the existing /api/webhooks/clerk receiver route.
  webhooks: {
    listWebhooks: makeFunctionReference<Q>('webhooks:listWebhooks'),
    createWebhook: makeFunctionReference<M>('webhooks:createWebhook'),
    deleteWebhook: makeFunctionReference<M>('webhooks:deleteWebhook'),
    listWebhookDeliveries: makeFunctionReference<Q>('webhooks:listWebhookDeliveries'),
  },
  // convex/evals.ts already exists (data agent, ADR-002) — append-only eval
  // records + rollups.
  evals: {
    recordEval: makeFunctionReference<M>('evals:recordEval'),
    listEvalsForRun: makeFunctionReference<Q>('evals:listEvalsForRun'),
    listEvalsByName: makeFunctionReference<Q>('evals:listEvalsByName'),
    listEvalsByAgentVersion: makeFunctionReference<Q>('evals:listEvalsByAgentVersion'),
  },
  // convex/usage.ts already exists (data agent, ADR-002) — approximate usage
  // counters (usage_counters table).
  usage: {
    getUsageForDay: makeFunctionReference<Q>('usage:getUsageForDay'),
    listRecentUsage: makeFunctionReference<Q>('usage:listRecentUsage'),
  },
  // ADR-004 — run explanations ("Why did this fail?"). Landed this cycle as
  // convex/run_explanations.ts (Team A) — file name corrected here from an
  // earlier `explanations:*` guess (Team E) made before that file landed.
  // getRunExplanation(runId) -> RunExplanation | null (member-gated,
  // org-scoped; null both when the run hasn't failed/timed_out/cancelled
  // AND when generation hasn't completed yet — see services/explanations.ts
  // for the "coarse null" caveat this implies for the GET route).
  explanations: {
    getRunExplanation: makeFunctionReference<Q>('run_explanations:getRunExplanation'),
    // Batched, org-scoped summaries for the failed-runs-list "why" preview
    // (Team A, this cycle) — one round-trip instead of N single-run fetches.
    getRunExplanationSummaries: makeFunctionReference<Q>('run_explanations:getRunExplanationSummaries'),
    // Team C (action layer) — admin-gated regeneration, backing
    // POST /api/runs/[id]/explanation/regenerate. This is an ACTION (not a
    // mutation) in convex/run_explanations.ts — it runs the full
    // generate-and-validate pipeline synchronously, including the optional
    // LLM call, so it must be invoked via `client.action(...)`, not
    // `client.mutation(...)`. It enforces `admin` role itself
    // (_requireAdminForRegenerate) and returns a `GenerateRunExplanationResult`
    // status object, NOT the explanation doc — services/explanations.ts
    // re-fetches getRunExplanation after a successful regenerate to return
    // the fresh explanation to the route.
    regenerateRunExplanation: makeFunctionReference<A>('run_explanations:regenerateRunExplanation'),
  },
  // Team B's analytics/insights surface (convex/insights.ts) — dashboard
  // stats, per-agent cost estimates, version-comparison cohorts, and the
  // per-version eval pass-rate rollup. Landed this cycle.
  // ADR-008 replay divergence (convex/divergence.ts, Team A). READ-ONLY: every
  // member is a `query`, because a divergence report is a DERIVED PROJECTION
  // over the event log (CLAUDE.md Event Log Rule 2) and is never stored back.
  //
  // The three refs are a progressive-disclosure ladder, cheapest first:
  //   compareVersionConfigs  zero run reads, zero event reads — answers every
  //                          SPECULATIVE question for the whole fleet at once.
  //   analyzeRun             one run, paged over its events.
  //   analyzeFleet           one bounded batch of runs, grouped by reason.
  // Consumed by services/divergence.ts; see lib/divergence/adapt.ts for the
  // mapping onto the contracts types.
  divergence: {
    compareVersionConfigs: makeFunctionReference<Q>('divergence:compareVersionConfigs'),
    analyzeRun: makeFunctionReference<Q>('divergence:analyzeRun'),
    analyzeFleet: makeFunctionReference<Q>('divergence:analyzeFleet'),
  },
  insights: {
    getDashboardStats: makeFunctionReference<Q>('insights:getDashboardStats'),
    getAgentCostStats: makeFunctionReference<Q>('insights:getAgentCostStats'),
    compareVersions: makeFunctionReference<Q>('insights:compareVersions'),
    listEvalsForVersion: makeFunctionReference<Q>('insights:listEvalsForVersion'),
    // Added this cycle by Team B — a single org-wide per-agent rollup,
    // replacing the N-calls-per-agent approach in services/dashboard.ts.
    // Bound by path (not yet in convex/_generated/api at the time this UI
    // cycle was written); services/dashboard.ts falls back to the old
    // per-agent-call approach if this query is unavailable/undeployed.
    getPerAgentDashboardStats: makeFunctionReference<Q>('insights:getPerAgentDashboardStats'),
    // Added this cycle by Team B — pass/fail/score summary for one run's
    // evals, used by the run-detail Evals panel header.
    getRunEvalSummary: makeFunctionReference<Q>('insights:getRunEvalSummary'),
  },
  // "Failure Patterns" (PREVENTION) feature — convex/failure_patterns.ts
  // (Team A: durable org-scoped failure-fingerprint rollups; fingerprinting +
  // spike math lives in convex/insights.ts per Team B). Queries are
  // member-gated and org-scoped like the rest of this file's Clerk-authed
  // surface — services/failurePatterns.ts (Team C) resolves the Clerk org to
  // a Convex orgId and passes it explicitly, same convention as convex.alerts.
  // listFailurePatterns/getFailurePattern shipped cycles 1-2 and are live.
  //
  // mutePattern/unmutePattern (cycle 3): admin-gated, audited mutations Team A
  // is landing this cycle, taking `{ orgId, fingerprintHash }` and returning
  // the updated rollup doc (mirrors the mute/unmute contract). As of this
  // Team C pass they have not yet landed on this branch — these two refs are
  // string-based (this file's existing convention for not-yet-generated
  // api.* bindings, same as the note that used to sit on this whole block
  // before cycle 1 shipped) and will 404/throw at runtime until Team A's
  // mutations ship. Do not rename without checking with Team A first.
  failure_patterns: {
    listFailurePatterns: makeFunctionReference<Q>('failure_patterns:listFailurePatterns'),
    getFailurePattern: makeFunctionReference<Q>('failure_patterns:getFailurePattern'),
    mutePattern: makeFunctionReference<M>('failure_patterns:mutePattern'),
    unmutePattern: makeFunctionReference<M>('failure_patterns:unmutePattern'),
    // Resolution lifecycle (docs/adr/006-failure-resolution.md, cycle 1):
    // MEMBER-gated (not admin — this is normal triage, like commenting),
    // audited mutations. Confirmed contract from Team A's landed
    // convex/failure_patterns.ts:
    //   acknowledgePattern({ orgId, fingerprintHash }) => Doc | null
    //   resolvePattern({ orgId, fingerprintHash, note?, ref? }) => Doc | null
    //   reopenPattern({ orgId, fingerprintHash }) => Doc | null
    // All three collapse "never existed" / "different org" into the same
    // `null`, exactly like mutePattern/unmutePattern above.
    acknowledgePattern: makeFunctionReference<M>('failure_patterns:acknowledgePattern'),
    resolvePattern: makeFunctionReference<M>('failure_patterns:resolvePattern'),
    reopenPattern: makeFunctionReference<M>('failure_patterns:reopenPattern'),
    // Resolution EVIDENCE (cycle 2 — "prove the fix held"). Verified against
    // the landed convex/failure_patterns.ts (commit 0abff21), not relayed:
    //   getPatternResolutionEvidence({ orgId, fingerprintHash })
    //     => { pattern, resolution | null, exposure | null, transitions[] } | null
    // A QUERY (not a mutation — it only reads), member-gated and org-scoped,
    // returning `null` for a fingerprint absent from THIS org, same tenancy
    // collapse as getFailurePattern above.
    //
    // Cycle 2 also widened `resolvePattern` with a FLAT fourth optional arg,
    // `versionId: Id<"agent_versions">`, landing on the rollup's
    // `resolvedInVersionId`. No new ref is needed for that (the existing
    // resolvePattern ref is unchanged) — but note that an added arg crossing
    // this string-ref seam is exactly the invisible-drop failure mode this
    // file keeps causing, which is why the forwarding spread in
    // services/failurePatterns.ts is covered by a table-driven args test
    // (tests/unit/failure_patterns_resolve_args.test.ts).
    getPatternResolutionEvidence: makeFunctionReference<Q>(
      'failure_patterns:getPatternResolutionEvidence',
    ),
  },

  // --- BUDGET CIRCUIT BREAKERS ---------------------------------------------
  //
  // EVERY REF BELOW DECLARES ITS ARGS, and none of them is bare. This is the
  // seam whose BOTH type parameters default to `any` (see the causality block
  // above), and it is the seam a budget call crosses — where a dropped or
  // misspelled arg is not a rendering defect but an enforcement one. A `runId`
  // that silently fails to narrow returns a WELL-FORMED snapshot about a
  // DIFFERENT SUBJECT, which is "some other agent has headroom" rendered as
  // though it were about this one.
  //
  // THE RETURNS ARE `unknown`, DELIBERATELY, AND NOT `BreakerSnapshot`.
  // Declaring the contract type here would be an ASSERTION, not a check —
  // nothing verifies a string-named reference against the function it names, so
  // the parameter would promise a guarantee the value never had. `unknown`
  // forces every consumer through contracts' own `breakerSnapshotRefusals` /
  // `snapshotUnusableFields`, which is the only thing that actually establishes
  // what arrived. A `BreakerSnapshot` annotation here would let a malformed
  // body reach a renderer with TypeScript vouching for it.
  budgets: {
    listBudgets: makeFunctionReference<Q, { orgId: string }, unknown>('budgets:listBudgets'),
    getBudget: makeFunctionReference<Q, { budgetId: string }, unknown>('budgets:getBudget'),
    /** Clerk-authed breaker evaluation. The SDK-facing twin is `budget_gate:sdkCheckBudget`. */
    checkBudget: makeFunctionReference<Q, BudgetSubjectArgs, unknown>('budgets:checkBudget'),
    /**
     * ADMIN-gated. How close this org is to the sweep's GLOBAL ceiling.
     *
     * Surfaced so the ceiling is observable before it bites rather than
     * inferable afterwards — and rendered with its own caveat intact, because
     * `sweepBatchSize` is global across every org: being well under it is not
     * proof of safety, only evidence that this org is not a large contributor.
     *
     * NOTE WHAT A LAGGING SWEEP DOES NOT COST. Breaker state is computed fresh
     * on every check and never reads the sweep's output, so a lagging sweep
     * cannot make an answer stale or permissive. What it delays is the AUDIT of
     * a breach nobody happened to query. Rendering it as a staleness warning
     * would be a false alarm in the halt-a-business direction.
     */
    getBudgetSweepPressure: makeFunctionReference<Q, { orgId: string }, unknown>(
      'budgets:getBudgetSweepPressure',
    ),
    createBudget: makeFunctionReference<M, CreateBudgetArgs, unknown>('budgets:createBudget'),
    updateBudget: makeFunctionReference<M, UpdateBudgetArgs, unknown>('budgets:updateBudget'),
    deleteBudget: makeFunctionReference<M, { budgetId: string }, unknown>('budgets:deleteBudget'),
    /**
     * MEMBER-gated, audited. Tripping WITHHOLDS — its cost is delay — so it is
     * not behind the admin gate that `resetBudget` is behind. See
     * `convex/budgets.ts`'s header on the asymmetry.
     */
    tripBudget: makeFunctionReference<M, { budgetId: string; reason: string }, unknown>(
      'budgets:tripBudget',
    ),
    /** ADMIN-gated, audited. Resetting RESUMES unbounded spend; the gate is the risk's own. */
    resetBudget: makeFunctionReference<M, { budgetId: string; reason: string }, unknown>(
      'budgets:resetBudget',
    ),
  },
  // The API-key-authed gate (convex/budget_gate.ts). Separate module because it
  // authenticates by pre-hashed key and must never reach for Clerk — the same
  // split, for the same reason, as sdk_ingest.ts versus runs.ts.
  //
  // NOTE THE ABSENT `orgId`: the caller cannot name an organization, so it
  // cannot name someone else's. The optional ids only NARROW within the key's
  // own org.
  budget_gate: {
    sdkCheckBudget: makeFunctionReference<Q, SdkBudgetSubjectArgs, unknown>(
      'budget_gate:sdkCheckBudget',
    ),
  },
} as const
