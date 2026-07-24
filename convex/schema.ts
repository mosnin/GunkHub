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
    // Set when Clerk reports organization.deleted. The purge itself stays
    // operator-invoked (ADR 001) — this timestamp makes the pending erasure
    // obligation visible so an operator can act on it. Cleared never; the org
    // record is deleted wholesale by the purge.
    pendingDeletionAt: v.optional(v.number()),
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
    // Cycle 2 (docs/design/action_layer.md, ADR-002 follow-up): optional
    // eval-auto-run rule set for this version, evaluated against every
    // terminal run created against it. Stored as `v.array(v.any())` — same
    // justified exception as `events.payload` — because the `EvalRule`
    // discriminated union (convex/helpers/evals.ts) cannot be expressed in
    // the validator DSL. Runtime shape validation happens in
    // createAgentVersion (helpers/agent_version_fields.ts), not here. Bounded
    // to <= 20 rules at write time.
    evalRules: v.optional(v.array(v.any())),
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
    // ADR-002 — run hierarchy / sessions / environment / triage / search.
    // All additive+optional: existing rows remain valid with no migration.
    //
    // Links a sub-run to its parent (e.g. a sub-agent invocation). Validated
    // at write time only (same org AND same project as the child); arbitrary
    // depth is allowed. Cycles are structurally impossible: a parent must
    // already exist when the child references it, and parentRunId is never
    // mutated after creation — see ADR-002 for why no traversal check is
    // needed.
    parentRunId: v.optional(v.id("runs")),
    // Free-form correlation key an SDK caller sets to group multiple runs
    // (e.g. a multi-turn conversation). Opaque to the backend beyond a
    // length bound.
    sessionId: v.optional(v.string()),
    // Well-known values (production/staging/development/preview) or any
    // custom string up to 32 chars. Stamped from the API key's own
    // `environment` field when the caller doesn't supply one explicitly.
    environment: v.optional(v.string()),
    // Triage labels, distinct from `tags` — up to 10, each up to 40 chars.
    labels: v.optional(v.array(v.string())),
    // Settable only on failed/timed_out runs via setRunTriage, which
    // enforces open -> investigating -> resolved (+ any -> open).
    triageState: v.optional(
      v.union(
        v.literal("open"),
        v.literal("investigating"),
        v.literal("resolved"),
      ),
    ),
    // Denormalized running counters, incremented at event-insert time from
    // llm.response payloads. The one narrow, documented exception to "do not
    // denormalize event data into runs" — see ADR-002: monotonic add-only
    // counters, never a recomputed aggregate, so they cannot silently
    // disagree with the log the way a cached "last error" could.
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    // Feeds the search_runs search index below. Populated at create (agent
    // name + tags + triggeredBy) and appended to on a terminal run.failed
    // event (extracted error message). Bounded to 2 KB. Not itself a
    // canonical fact about the run — purely a search-index source field.
    searchText: v.optional(v.string()),
    // Cycle 3 — cost accuracy (docs/adr/002, docs/adr/003 follow-up):
    // denormalized, bounded (<= MAX_MODELS_SEEN_PER_RUN), deduped list of
    // model strings tolerantly extracted from this run's `llm.request` /
    // `llm.response` event payloads at insert time. Lets getAgentCostStats
    // (Team B, convex/insights.ts) attribute tokens to models without
    // scanning every event. Same monotonic-add-only justification as
    // tokensIn/tokensOut above: it is never recomputed from a full replay,
    // so it cannot drift out of sync in a way a reader could mistake for
    // authoritative — the event log remains the source of truth for the
    // underlying payloads themselves.
    modelsSeen: v.optional(v.array(v.string())),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_agent_started", ["agentId", "startedAt"])
    .index("by_project_started", ["projectId", "startedAt"])
    .index("by_org_started", ["orgId", "startedAt"])
    .index("by_org_status_started", ["orgId", "status", "startedAt"])
    // Cross-org index for the stale-run sweep: find "running" runs older than a
    // cutoff without scanning the whole (unbounded) runs table.
    .index("by_status_started", ["status", "startedAt"])
    // ADR-002: session correlation, run hierarchy, environment filtering.
    .index("by_org_session", ["orgId", "sessionId"])
    .index("by_parent", ["parentRunId"])
    .index("by_org_environment_started", ["orgId", "environment", "startedAt"])
    // Cycle 3 (for Team B's convex/insights.ts compareVersions): exact,
    // O(matches) lookup of a version's runs instead of the bounded
    // most-recent-N overfetch-and-filter over by_agent_started. Justified:
    // compareVersions ships and is being updated to use this index this
    // same cycle.
    .index("by_agent_version_started", ["agentVersionId", "startedAt"])
    // ADR-002: full-text search over runs, scoped to the caller's org via
    // filterFields. searchField must be a stored field (searchText).
    .searchIndex("search_runs", {
      searchField: "searchText",
      filterFields: ["orgId"],
    }),

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
    // GC bookkeeping (sticky reference): once ANY event's `_externalized`
    // payload is known to point at this artifact, the referencing event id is
    // stamped here so the artifact permanently leaves the orphan-candidate set
    // (events are immutable, so a reference can never be un-made). Artifacts are
    // metadata pointers, NOT events — patching this field does not violate
    // event-log immutability. Backfilled at write time by sdkCreateEvents and,
    // as a fallback, by the GC's pointer scan.
    referencedByEventId: v.optional(v.id("events")),
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
    // ADR-002: when set, stamped onto every run this key creates (unless the
    // caller explicitly supplies its own `environment`).
    environment: v.optional(v.string()),
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
    .index("by_org_verified", ["orgId", "verifiedAt"])
    // Powers the runs page's server-side integrity filter (`/runs?verify=failed`,
    // convex/runs.ts `listRunsByVerification`). Each run has at most one row here
    // (upsertVerificationResult deletes-then-inserts, so a row IS the run's latest
    // result — no "most recent per run" aggregation needed). Without this index,
    // finding "runs whose verification failed" requires either a full org scan of
    // verification_results or filtering client-side over a single page of runs
    // (the previous, misleading behavior this prompt replaces). Justified now,
    // not speculative: the query that needs it (`listRunsByVerification`) ships
    // in this same change.
    .index("by_org_isvalid", ["orgId", "isValid"]),

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

  // ---------------------------------------------------------------------------
  // ADR-002 — data model expansion (docs/adr/002-data-model-expansion.md).
  // ---------------------------------------------------------------------------

  // APPEND-ONLY, like events/audit_log — an eval is a recorded observation
  // about a run and must not be quietly edited after the fact. Written via
  // recordEval (member) or sdkRecordEval (API key, ingest:write scope).
  evals: defineTable({
    orgId: v.id("organizations"),
    runId: v.id("runs"),
    agentVersionId: v.optional(v.id("agent_versions")),
    name: v.string(),
    kind: v.union(v.literal("rule"), v.literal("llm_judge"), v.literal("manual")),
    passed: v.boolean(),
    score: v.optional(v.number()),
    details: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.string(), // Clerk user ID, or "system" for the API-key path
  })
    .index("by_run", ["runId"])
    .index("by_org_name", ["orgId", "name", "createdAt"])
    .index("by_org_version", ["orgId", "agentVersionId"]),

  // Ordinary admin-gated config, audited like api_keys/projects.
  alert_rules: defineTable({
    orgId: v.id("organizations"),
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    kind: v.union(
      v.literal("run_failed"),
      v.literal("failure_rate"),
      v.literal("eval_failed"),
    ),
    thresholdPct: v.optional(v.number()),
    windowMinutes: v.optional(v.number()),
    channels: v.array(
      v.object({
        type: v.union(v.literal("webhook"), v.literal("email")),
        target: v.string(),
      }),
    ),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org", ["orgId"]),

  // APPEND-ONLY record of a rule firing. deliveryStatus/deliveredAt are the
  // ONE sanctioned patch — delivery bookkeeping about an already-immutable
  // fact (ruleId/runId/firedAt/summary), never touched after insert. See
  // ADR-002 for why this is not a violation of append-only semantics.
  alert_events: defineTable({
    orgId: v.id("organizations"),
    ruleId: v.id("alert_rules"),
    runId: v.optional(v.id("runs")),
    firedAt: v.number(),
    summary: v.string(),
    deliveryStatus: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_org_fired", ["orgId", "firedAt"])
    .index("by_rule", ["ruleId"])
    // AUDIT FIX (cycle 5, H4): retention.ts's per-run deletion (enforceRetention)
    // needs to find alert_events tied to ONE specific run so it can scrub
    // them (and their dependent email_deliveries) the same way the org purge
    // already does org-wide. Without this index the only options were an
    // unindexed table scan or piggybacking on by_org_fired and filtering in
    // memory across the whole org's fired alerts — this is a real, narrow
    // query pattern (used immediately in convex/retention.ts), not
    // speculative.
    .index("by_run", ["runId"]),

  // Signing secret is generated server-side and returned exactly once (in the
  // createWebhook response) — listWebhooks always strips it. Stored in
  // plaintext (not hashed) because HMAC-signing outbound deliveries requires
  // the original value at delivery time; see ADR-002 for the tradeoff vs.
  // API-key hashing.
  webhook_targets: defineTable({
    orgId: v.id("organizations"),
    url: v.string(), // https:// only, validated at write time
    secret: v.string(),
    events: v.array(v.string()), // subset of run.completed/run.failed/eval.failed/alert.fired
    enabled: v.boolean(),
    createdAt: v.number(),
  }).index("by_org", ["orgId"]),

  // APPEND-ONLY, status-patchable exactly like alert_events (same rationale).
  webhook_deliveries: defineTable({
    orgId: v.id("organizations"),
    webhookId: v.id("webhook_targets"),
    event: v.string(),
    runId: v.optional(v.id("runs")),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    lastAttemptAt: v.optional(v.number()),
    responseCode: v.optional(v.number()),
    // ADR-003 constraint 3 ("payload hash ... or error"): a hash of the
    // delivered payload (for audit/dedup, without storing the payload body
    // itself again) and a human-readable error when the attempt failed
    // before/without receiving an HTTP status.
    payloadHash: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    // Cycle 2 (docs/design/action_layer.md): when this delivery was enqueued
    // by the alert engine (as opposed to the standalone outbound-webhooks
    // feature), links back to the alert_events row it is delivering, so
    // webhook_engine.deliverPendingWebhooks can roll the delivery outcome up
    // into alert_events.deliveryStatus once every sibling delivery resolves.
    // Optional/additive — deliveries created by the plain webhook_targets
    // CRUD path (not alert-triggered) leave this unset.
    alertEventId: v.optional(v.id("alert_events")),
    // Retry scheduling: the next attempt is not due before this timestamp.
    // Set on enqueue (now) and advanced on each retryable failure via
    // computeBackoff. Optional/additive; absent = due immediately (legacy
    // rows inserted before this field existed, or rows from the Cycle-1
    // internal-only recordWebhookDelivery entry point).
    nextAttemptAt: v.optional(v.number()),
  })
    .index("by_webhook", ["webhookId", "createdAt"])
    .index("by_org", ["orgId", "createdAt"])
    // Cycle 2: cross-org bounded batch scan for the delivery cron — same
    // shape as runs.by_status_started (stale-run sweep). Needed because
    // deliverPendingWebhooks must find pending rows across ALL orgs without
    // an unindexed table scan.
    .index("by_status_created", ["status", "createdAt"])
    // AUDIT FIX (cycle 5, perf M1): getPendingDeliveries used to scan
    // by_status_created (all "pending" rows across every org, oldest first)
    // and post-filter in memory for nextAttemptAt <= now — under a large
    // pending backlog with staggered backoff retry times, most of that scan
    // is wasted reading rows that are not yet due. This index lets the query
    // range directly on (status, nextAttemptAt) so only due (or never-set)
    // rows are read off the index, not scanned-then-discarded.
    .index("by_status_nextAttempt", ["status", "nextAttemptAt"])
    // Cycle 2: find every delivery belonging to one fired alert, to decide
    // when alert_events.deliveryStatus can be rolled up to delivered/failed.
    .index("by_alert_event", ["alertEventId"])
    // AUDIT FIX (cycle 5, H4): retention.ts's per-run deletion needs to find
    // webhook_deliveries tied to ONE run (both the alert-triggered path,
    // convex/alert_engine.ts, and the standalone webhook_targets CRUD path,
    // convex/webhooks.ts, stamp `runId` directly on creation), the same way
    // the org purge already deletes them org-wide via by_org. Real query
    // pattern, used immediately in convex/retention.ts.
    .index("by_run", ["runId"]),

  // Approximate usage metering, incremented from every ingest path using the
  // same stride-counting contention mitigation as the per-key rate limiter in
  // sdk_ingest.ts. Observability/billing groundwork, not an exact audit trail
  // (events/audit_log remain authoritative for anything exact).
  usage_counters: defineTable({
    orgId: v.id("organizations"),
    day: v.string(), // "YYYY-MM-DD", UTC
    runsStarted: v.number(),
    eventsIngested: v.number(),
    bytesIngested: v.number(),
    artifactBytes: v.number(),
  }).index("by_org_day", ["orgId", "day"]),

  // Written ONLY by the internal daily cron computeDailyRollups — never by a
  // public mutation. A derived projection over yesterday's terminal runs,
  // computed from a bounded sample (<= 5,000 runs/agent/day); percentiles are
  // therefore approximate for any agent/day exceeding the sample size.
  // Cycle 3 — completes the deferred alert-email delivery path (ADR-002 /
  // ADR-003; docs/design/action_layer.md "explicitly deferred to Cycle 2:
  // the actual email provider integration"). One row per (alertEventId,
  // channel.target) email channel on a fired alert rule. APPEND-ONLY except
  // for status/attempt bookkeeping fields — identical rationale to
  // webhook_deliveries/alert_events: the fact of the alert firing and the
  // rendered envelope (to/subject/body) are never touched after insert;
  // only delivery bookkeeping about that already-immutable fact is patched.
  email_deliveries: defineTable({
    orgId: v.id("organizations"),
    alertEventId: v.id("alert_events"),
    to: v.string(),
    subject: v.string(),
    body: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    lastAttemptAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    // Retry scheduling, same pattern as webhook_deliveries.nextAttemptAt.
    // Optional/additive; absent = due immediately.
    nextAttemptAt: v.optional(v.number()),
  })
    .index("by_status_created", ["status", "createdAt"])
    .index("by_alert_event", ["alertEventId"])
    // AUDIT FIX (cycle 4): ADR 001's org purge (convex/retention.ts) must be
    // able to enumerate and delete every row belonging to a purged org — see
    // that file's purgeOrganizationBatch. email_deliveries had no org-scoped
    // index (only by_status_created / by_alert_event), which made it
    // impossible to find this table's rows for an org without an unbounded,
    // cross-org table scan. Mirrors webhook_deliveries.by_org.
    .index("by_org", ["orgId", "createdAt"]),

  // ADR-004 — run explanations ("Why did this fail?"). Cached, regeneratable
  // (delete + insert) per run: at most ONE row per runId. NOT append-only —
  // this is a generated/derived artifact (grounded in the immutable event
  // log, but itself never asserted to be a fact about what happened), unlike
  // events/evals/audit_log. Regeneration is itself audited via
  // `run_explanation.regenerated` (convex/audit.ts) so "who asked for a
  // fresh explanation, and when" stays visible.
  run_explanations: defineTable({
    orgId: v.id("organizations"),
    runId: v.id("runs"),
    kind: v.union(v.literal("heuristic"), v.literal("llm")),
    summary: v.string(), // <= MAX_EXPLANATION_SUMMARY_BYTES (2 KB)
    rootCause: v.string(), // <= MAX_EXPLANATION_ROOT_CAUSE_BYTES (1 KB)
    suggestedFix: v.optional(v.string()), // <= MAX_EXPLANATION_SUGGESTED_FIX_BYTES (1 KB)
    // The events (by sequenceNumber) this explanation cites. Every entry is
    // validated at write time to correspond to a real event on this run — see
    // convex/run_explanations.ts. <= MAX_CITED_SEQUENCE_NUMBERS (20).
    citedSequenceNumbers: v.array(v.number()),
    // Free-form classifier label from Team B's heuristic engine (e.g.
    // "llm_error", "tool_error", "timeout", "unknown") — NOT a closed enum
    // here, since Team B's classifier vocabulary can grow without a schema
    // change.
    failureClass: v.string(),
    generatedAt: v.number(),
    // Present only when kind === "llm" — the model identifier used, for audit/debugging.
    model: v.optional(v.string()),
    // Schema version of the explanation shape itself (RUN_EXPLANATION_SCHEMA_VERSION),
    // so a future shape change can be detected/migrated without guessing from field presence.
    version: v.number(),
  })
    // One row per run: getRunExplanation/regenerate always resolve via this
    // index (query, take the single (at most one) match). Regenerate deletes
    // the existing row before inserting the new one, so "at most one per
    // runId" is maintained by write-time discipline, not a unique constraint
    // (Convex has none) — see upsertRunExplanation.
    .index("by_run", ["runId"]),

  daily_rollups: defineTable({
    orgId: v.id("organizations"),
    agentId: v.id("agents"),
    date: v.string(), // "YYYY-MM-DD", UTC
    runsTotal: v.number(),
    runsFailed: v.number(),
    runsCompleted: v.number(),
    runsCancelled: v.number(),
    runsTimedOut: v.number(),
    durationMsP50: v.optional(v.number()),
    durationMsP95: v.optional(v.number()),
    tokensIn: v.number(),
    tokensOut: v.number(),
  })
    .index("by_org_date", ["orgId", "date"])
    .index("by_agent_date", ["agentId", "date"]),
});
