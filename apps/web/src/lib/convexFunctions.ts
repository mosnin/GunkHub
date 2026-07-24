// Typed Convex function references — used instead of generated api types.
// These paths match the file:function naming convention Convex uses.
// When convex/_generated/ is available (after `npx convex dev`), use api.* instead.

import { makeFunctionReference } from 'convex/server'

type Q = 'query'
type M = 'mutation'
type A = 'action'

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
} as const
