import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    clerkOrgId: v.string(),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerk_org_id", ["clerkOrgId"])
    .index("by_slug", ["slug"]),

  users: defineTable({
    orgId: v.id("organizations"),
    clerkUserId: v.string(),
    email: v.string(),
    name: v.string(),
    avatarUrl: v.optional(v.string()),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    createdAt: v.number(),
  })
    .index("by_clerk_user_id", ["clerkUserId"])
    .index("by_org", ["orgId"]),

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
    projectId: v.id("projects"),
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_org", ["orgId"]),

  agentVersions: defineTable({
    agentId: v.id("agents"),
    orgId: v.id("organizations"),
    version: v.string(),
    metadata: v.any(),
    createdAt: v.number(),
  })
    .index("by_agent", ["agentId"])
    .index("by_agent_version", ["agentId", "version"]),

  runs: defineTable({
    agentId: v.id("agents"),
    agentVersionId: v.optional(v.id("agentVersions")),
    projectId: v.id("projects"),
    orgId: v.id("organizations"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    metadata: v.any(),
    tags: v.array(v.string()),
    errorMessage: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    eventCount: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_project", ["projectId"])
    .index("by_agent", ["agentId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_started", ["orgId", "startedAt"]),

  // IMMUTABLE: Events must never be updated or deleted after insertion
  events: defineTable({
    runId: v.id("runs"),
    orgId: v.id("organizations"),
    type: v.string(),
    category: v.string(),
    sequence: v.number(),
    timestamp: v.number(),
    payload: v.optional(v.any()),
    payloadExternalized: v.boolean(),
    artifactId: v.optional(v.id("artifacts")),
    parentEventId: v.optional(v.id("events")),
    metadata: v.any(),
  })
    .index("by_run", ["runId"])
    .index("by_run_seq", ["runId", "sequence"])
    .index("by_org", ["orgId"]),

  artifacts: defineTable({
    orgId: v.id("organizations"),
    runId: v.id("runs"),
    eventId: v.optional(v.id("events")),
    storageKey: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    checksum: v.string(),
    createdAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_event", ["eventId"])
    .index("by_org", ["orgId"]),

  comments: defineTable({
    orgId: v.id("organizations"),
    runId: v.id("runs"),
    eventId: v.optional(v.id("events")),
    authorId: v.id("users"),
    content: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run", ["runId"])
    .index("by_event", ["eventId"]),
});
