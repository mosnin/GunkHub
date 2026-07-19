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
} as const
