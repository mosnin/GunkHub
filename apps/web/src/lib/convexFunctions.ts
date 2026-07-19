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
  // Team B's analytics/insights surface (convex/insights.ts) — dashboard
  // stats, per-agent cost estimates, version-comparison cohorts, and the
  // per-version eval pass-rate rollup. Landed this cycle.
  insights: {
    getDashboardStats: makeFunctionReference<Q>('insights:getDashboardStats'),
    getAgentCostStats: makeFunctionReference<Q>('insights:getAgentCostStats'),
    compareVersions: makeFunctionReference<Q>('insights:compareVersions'),
    listEvalsForVersion: makeFunctionReference<Q>('insights:listEvalsForVersion'),
  },
} as const
