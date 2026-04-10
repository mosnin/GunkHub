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
  })
    .index("by_clerk_org_id", ["clerkOrgId"])
    .index("by_slug", ["slug"]),

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
    .index("by_project", ["projectId"])
    .index("by_agent", ["agentId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_agent_started", ["agentId", "startedAt"])
    .index("by_project_started", ["projectId", "startedAt"])
    .index("by_org_started", ["orgId", "startedAt"]),

  // IMMUTABILITY: Events must never be updated or deleted. This table is append-only.
  events: defineTable({
    runId: v.id("runs"),
    orgId: v.id("organizations"),
    type: v.string(),
    sequenceNumber: v.number(),
    timestamp: v.number(),
    payload: v.any(),
    parentEventId: v.optional(v.id("events")),
  })
    .index("by_run", ["runId", "sequenceNumber"])
    .index("by_run_type", ["runId", "type"]),

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
    .index("by_run_checksum", ["runId", "checksum"]),

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
  })
    .index("by_org", ["orgId"])
    .index("by_key_hash", ["keyHash"]),
});
