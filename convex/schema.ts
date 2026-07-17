import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  organizations: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    plan: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("enterprise"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    // Optional retention window (ADR 001 — data retention and erasure). When set,
    // the daily enforceRetention cron deletes TERMINAL runs (and their events,
    // artifacts, comments, verification results) started more than retentionDays
    // days ago. Unset = retain forever (default).
    retentionDays: v.optional(v.number()),
  }).index("by_clerk_org_id", ["clerkOrgId"]),

  projects: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_slug", ["orgId", "slug"]),

  agents: defineTable({
    orgId: v.id("organizations"),
    projectId: v.id("projects"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_project", ["projectId"]),

  agent_versions: defineTable({
    agentId: v.id("agents"),
    orgId: v.id("organizations"),
    version: v.string(),
    changelog: v.optional(v.string()),
    createdAt: v.number(),
    configSnapshot: v.optional(v.any()),
  }).index("by_agent", ["agentId"]),

  runs: defineTable({
    orgId: v.id("organizations"),
    projectId: v.id("projects"),
    agentId: v.id("agents"),
    agentVersionId: v.optional(v.id("agent_versions")),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("timed_out"),
    ),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    metadata: v.any(),
    tags: v.array(v.string()),
    triggeredBy: v.optional(v.string()),
    sdkVersion: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_agent_started", ["agentId", "startedAt"])
    .index("by_project_started", ["projectId", "startedAt"])
    .index("by_org_started", ["orgId", "startedAt"])
    .index("by_org_status_started", ["orgId", "status", "startedAt"])
    // Cross-org index for the stale-run sweep: find "running" runs older than a
    // cutoff without scanning the whole (unbounded) runs table.
    .index("by_status_started", ["status", "startedAt"]),

  // IMMUTABILITY: Events must never be updated or deleted. This table is append-only.
  events: defineTable({
    runId: v.id("runs"),
    orgId: v.id("organizations"),
    type: v.string(),
    sequenceNumber: v.number(),
    timestamp: v.number(),
    payload: v.any(),
    parentEventId: v.optional(v.id("events")),
  }).index("by_run", ["runId", "sequenceNumber"]),

  artifacts: defineTable({
    runId: v.id("runs"),
    orgId: v.id("organizations"),
    eventId: v.optional(v.id("events")),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    storageKey: v.string(),
    storageBucket: v.string(),
    checksum: v.string(),
    createdAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_run_checksum", ["runId", "checksum"])
    .index("by_created_at", ["createdAt"]),

  comments: defineTable({
    orgId: v.id("organizations"),
    targetId: v.string(),
    targetType: v.union(v.literal("run"), v.literal("event")),
    authorId: v.string(),
    content: v.string(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_target", ["targetId", "targetType"]),

  user_memberships: defineTable({
    clerkUserId: v.string(),
    orgId: v.id("organizations"),
    role: v.union(
      v.literal("admin"),
      v.literal("member"),
      v.literal("viewer"),
    ),
    joinedAt: v.number(),
  })
    .index("by_clerk_user", ["clerkUserId"])
    .index("by_org", ["orgId"]),

  api_keys: defineTable({
    orgId: v.id("organizations"),
    keyHash: v.string(),      // SHA-256 hex hash of the raw API key
    name: v.string(),         // human-readable label (e.g. "CI key", "dev key")
    createdBy: v.string(),    // Clerk user ID who created it
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    // Enterprise key lifecycle. Both optional for back-compat: a key with no
    // expiresAt never expires; a key with no scopes has full ingest access.
    expiresAt: v.optional(v.number()),          // epoch ms; key is rejected once past
    scopes: v.optional(v.array(v.string())),    // e.g. ["ingest:write"]
    // Fixed-window ingest rate limit. rateLimitPerMin = max events accepted per
    // minute (undefined = unlimited). The window state is stored inline on the key
    // (a minute bucket + running count) so no separate table or GC is needed.
    rateLimitPerMin: v.optional(v.number()),
    rateWindowStart: v.optional(v.number()),    // minute bucket = floor(now/60000)
    rateWindowCount: v.optional(v.number()),    // events counted in the current bucket
  })
    .index("by_org", ["orgId"])
    .index("by_key_hash", ["keyHash"]),

  verification_results: defineTable({
    runId: v.id("runs"),
    orgId: v.id("organizations"),
    verifiedAt: v.number(),          // epoch ms
    isValid: v.boolean(),
    summary: v.string(),             // human-readable: "OK: 42 events, no gaps" or "INVALID: ..."
    sequenceGaps: v.array(v.number()),
    duplicateSeqNums: v.array(v.number()),
    failureReason: v.optional(v.string()),  // if isValid=false, the primary reason
    // Extended derivation check fields — absent on sequence-only records (pre-Prompt 21)
    checksRan: v.optional(v.array(v.string())),         // e.g. ["sequence"] or ["sequence","replay","failureSummary"]
    replayPassed: v.optional(v.boolean()),              // true = buildReplayProjection succeeded; absent = not checked
    failureSummaryPassed: v.optional(v.boolean()),      // true = buildFailureSummary succeeded; absent = not checked
  })
    .index("by_run", ["runId"])
    .index("by_org_verified", ["orgId", "verifiedAt"]),

  // APPEND-ONLY admin audit trail. Like the events table, rows are never updated
  // or deleted (sole exception: ADR 001 org purge, which erases the whole org's
  // partition). Every privileged mutation writes one row via recordAuditEvent.
  audit_log: defineTable({
    orgId: v.id("organizations"),
    // Clerk user ID of the actor, or the literal "clerk-webhook" for changes
    // applied by the Clerk webhook (e.g. membership role changes).
    actorClerkUserId: v.string(),
    // Closed set of action names — see AUDIT_ACTIONS in convex/audit.ts.
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    timestamp: v.number(),
    // Freeform action-specific context (e.g. old/new role, status transition).
    // v.any() is justified: the shape varies per action and is display-only.
    metadata: v.optional(v.any()),
  }).index("by_org", ["orgId", "timestamp"]),
});
