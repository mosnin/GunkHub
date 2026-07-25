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
  })
    .index("by_agent", ["agentId"])
    // ADR-007: exact get-or-create key for convex/otel_ingest.ts, which must
    // resolve `(agentId, version)` to at most one immutable AgentVersion when
    // it materializes a run for a new trace. Same OCC argument as
    // runs.by_org_trace: two concurrent first batches naming the same version
    // read the same empty range, so the second is retried and reuses the
    // version the first created instead of inserting a duplicate.
    .index("by_agent_version", ["agentId", "version"]),

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
    // ADR-007 (OTel span ingestion). The W3C trace id this run was derived
    // from, set ONLY by convex/otel_ingest.ts and never by the SDK path.
    //
    // THE TRACE->RUN RULING LIVES HERE, because this field IS the ruling: one
    // trace is exactly one run, keyed `(orgId, otelTraceId)` via the
    // by_org_trace index below. See convex/otel_ingest.ts for the full
    // argument and for why that index (not a lock, not a counter) is what
    // makes concurrent batches of the same trace safe.
    //
    // Additive + optional: every existing run predates OTel ingestion and
    // correctly has none. Absent means "not derived from a trace".
    otelTraceId: v.optional(v.string()),
    // ADR-007: the trace's TRUE ROOT span, recorded the first time one is seen
    // CLOSED. Its presence is what makes the run eligible to be settled (i.e.
    // closed with a terminal event); its absence means the outcome is genuinely
    // unknown and the run correctly stays in-progress per Event Log Rule 5.
    //
    // NOT a denormalization of event data: none of this is derived from stored
    // events, and nothing recomputes it. It is ingest-path state about a trace
    // that has no home in the event log, recorded once and never revised.
    otelRoot: v.optional(
      v.object({
        spanId: v.string(),
        spanName: v.string(),
        /** Root span status. Decides run.completed vs run.failed. */
        status: v.union(v.literal("unset"), v.literal("ok"), v.literal("error")),
        /** Root's end instant, epoch NANOSECONDS as a decimal string. */
        endUnixNano: v.string(),
      }),
    ),
    // The chosen root's START instant, epoch nanoseconds as a decimal string.
    // Stored alongside otelRoot because root selection is `min(start, spanId)`
    // over the whole TRACE, and comparing a later batch's candidate against the
    // recorded one requires the recorded one's start. Without it the choice
    // would depend on arrival order, and a trace with two true roots would
    // settle to completed or failed based on which batch flushed first.
    otelRootStartNano: v.optional(v.string()),
    // The LATEST temporal instant of any event appended to this run, epoch
    // nanoseconds as a decimal string. Monotonic max, add-only, never
    // recomputed — the same justification as tokensIn/tokensOut under ADR-002,
    // and it is ingest-path state rather than a cached aggregate of the log.
    //
    // It exists because the settle terminal must sort AFTER every event it
    // terminates, and the only alternative is scanning the run's events, which
    // is not affordable at the MAX_EVENTS_PER_RUN ceiling. Deriving it from the
    // LAST-APPENDED event instead is what broke: the event set is
    // partition-independent, but which event was appended last is not.
    otelMaxInstantNano: v.optional(v.string()),
    // ADR-007 / ADR-002: the O(1) ordering verdict for this run.
    //   derivedEventCount === 0        -> "sequence-native"
    //   otelUnkeyedDerivedCount === 0  -> "temporal"
    //   otherwise                      -> "ingest-unverified"
    // Add-only sums over appended events, taken by tallyDerivedOrdering at
    // every write site. Observability-grade: the event log remains the source
    // of truth for the ordering itself. They exist because the verdict is
    // otherwise an O(run) scan — which the MCP tier-4 budget refuses outright,
    // and which the web UI pays on every render — while being free at write
    // time, when the events are already in hand.
    derivedEventCount: v.optional(v.number()),
    otelUnkeyedDerivedCount: v.optional(v.number()),
    // Wall clock of the most recent derived append. The settle sweep waits for
    // this to go quiet for OTEL_TRACE_SETTLE_MS before closing the run, which
    // is what makes "the trace has finished arriving" a decision with evidence
    // behind it rather than a per-batch guess.
    otelLastAppendAt: v.optional(v.number()),
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
    // ADR-007: the trace->run resolution key for convex/otel_ingest.ts, and
    // the ONLY way that mutation looks a run up. Two properties, both
    // load-bearing and both lost if this were a filter() scan instead:
    //   TENANCY — `orgId` is the FIRST component, so a lookup physically
    //     cannot range over another org's runs. A trace id belonging to org A
    //     is not "denied" for org B, it is simply absent from B's range, which
    //     is what makes it indistinguishable from a trace that never existed.
    //   CONCURRENCY — Convex OCC records the INDEX RANGE a query read. Two
    //     concurrent first batches of the same trace both read the empty range
    //     `(orgId, traceId)`; whichever commits second has had that exact
    //     range written into, so its read set is invalidated and it is retried
    //     against the run the first one created. A `.filter()` over by_org
    //     would also conflict, but by ranging over EVERY run in the org — it
    //     would serialize all ingest for the tenant.
    .index("by_org_trace", ["orgId", "otelTraceId"])
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
    // How this event came to exist: recorded first-party by the SDK, or
    // DERIVED by the backend from an ingested OpenTelemetry span. Mirrors
    // `EventProvenance` in packages/contracts/src/provenance.ts.
    //
    // OPTIONAL, and absent means "sdk". That reading is sound rather than a
    // guess: every row written before OTel ingestion existed came from the
    // first-party path, there being no other writer. Making it required would
    // mean rewriting history in an append-only table.
    //
    // EXPLICIT UNION, NOT `v.any()`. The type is fully known and expressible.
    // `events.payload` is the ONE justified `v.any()` in this schema (Convex's
    // validator DSL cannot express a discriminated union of arbitrarily
    // nested payloads); this is not a second one.
    //
    // `lossReasons` is `v.array(v.string())` and NOT a closed union on
    // purpose: Convex cannot express the union, so `OtelMappingLossReason` in
    // contracts is the enforcement point. Do not "tighten" this — it breaks
    // scripts/check-schema-drift.ts, which compares against the contract.
    provenance: v.optional(
      v.union(
        v.object({
          source: v.literal("sdk"),
          sdkVersion: v.optional(v.string()),
        }),
        v.object({
          source: v.literal("otel"),
          traceId: v.string(),
          spanId: v.string(),
          parentSpanId: v.optional(v.string()),
          spanName: v.string(),
          scopeName: v.optional(v.string()),
          semconvVersion: v.string(),
          mapperVersion: v.string(),
          lossy: v.boolean(),
          lossReasons: v.optional(v.array(v.string())),
          receivedAt: v.number(),
        }),
      ),
    ),
    // ADR-007: the TEMPORAL truth for a derived event, carried separately from
    // `sequenceNumber`. Mirrors `TemporalOrderKey` in
    // packages/contracts/src/temporal.ts.
    //
    // WHY THIS COLUMN HAS TO EXIST. On the OTel path `sequenceNumber` is the
    // order we LEARNED about an event, not the order it happened: a span
    // arriving in batch 2 that occurred before spans already appended in batch
    // 1 can only be APPENDED, because inserting it would require renumbering,
    // and renumbering an append-only log is permanent corruption. The mapper
    // computes this key precisely so the temporal order survives that append.
    // If the ingest path does not PERSIST it, the ruling is decorative and
    // every OTel-ingested run is permanently unorderable — with no backfill
    // available that is not a rewrite of history.
    //
    // OPTIONAL, and absent by construction on every SDK-recorded event: a
    // native event has no span and no clamp, and its `sequenceNumber` IS its
    // temporal order. Absent on a DERIVED event means the ordering is
    // unverifiable, which consumers must LABEL (`ingest-unverified`) rather
    // than silently render as a timeline.
    //
    // NANOSECONDS AS DECIMAL STRINGS, not numbers. `v.number()` is a float64;
    // ULP at a 2026 epoch-nanosecond value (~1.75e18) is 256 ns, so storing
    // these as numbers would collapse instants under ~128 ns apart into the
    // same value and manufacture ties out of genuinely ordered input. `v.int64`
    // is not used because BigInt is not JSON-serializable across the read API.
    temporalOrder: v.optional(
      v.object({
        instantUnixNano: v.string(),
        rawInstantUnixNano: v.string(),
        phase: v.union(v.literal("open"), v.literal("close")),
        depth: v.number(),
        spanId: v.string(),
      }),
    ),
  })
    .index("by_run", ["runId", "sequenceNumber"])
    // ADR-007 C1/C2: SPAN-LEVEL idempotency for convex/otel_ingest.ts.
    //
    // ADR-0007's key is `(runId, sequenceNumber)`, which cannot dedupe a span:
    // a redelivered span is assigned a DIFFERENT derived ordinal if other
    // spans landed in between, so it does not collide and is inserted twice.
    // Under an append-only log that is permanent doubling, not a glitch.
    //
    // A SCAN of the run's events is not an acceptable substitute at the
    // MAX_EVENTS_PER_RUN ceiling (50k) — convex/artifact_gc.ts already pages
    // rather than .collect()ing a run's events for exactly that reason. This
    // index makes "have I already recorded this span?" O(1) per span, bounded
    // by MAX_OTEL_SPANS_PER_BATCH probes.
    //
    // Nested field path: `provenance.spanId` is undefined for every SDK-path
    // row, which is correct — those rows have no span and must never match.
    .index("by_run_span", ["runId", "provenance.spanId"]),

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
  })
    .index("by_org", ["orgId", "timestamp"])
    // ADR-006 Cycle 2 (resolution evidence): reconstruct ONE target's
    // lifecycle transition history from the append-only audit log, rather
    // than adding a mutable per-entity history table. Used immediately by
    // convex/failure_patterns.ts's getPatternResolutionEvidence, which needs
    // every `failure_pattern.*` row for a single fingerprintHash in
    // timestamp order. Without this index that read is either an unindexed
    // scan or a `by_org` scan filtered in memory across every audit row the
    // org has ever written — this index makes it bounded by the number of
    // rows for THAT target. Not speculative: it has exactly one caller today.
    .index("by_org_target", ["orgId", "targetType", "targetId", "timestamp"]),

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
      // Failure Patterns cycle 2 (docs/adr/005-failure-patterns.md): fires
      // when a `failure_patterns` rollup transitions from not-spiking to
      // spiking (see convex/failure_patterns.ts's assessPatternSpikesCron and
      // convex/alerts.ts's firePatternSpikeAlert). `projectId` is not
      // meaningful for this kind (a failure-pattern rollup is org-scoped, not
      // project-scoped) — a rule of this kind with `projectId` set is treated
      // as org-wide, same documented behavior as `failure_rate` rules without
      // a windowMinutes/thresholdPct set.
      v.literal("pattern_spike"),
      // ADR-006 — failure pattern resolution lifecycle: fires the moment a
      // RESOLVED `failure_patterns` rollup receives a new occurrence dated
      // after its `resolvedAt` (the regression guard, convex/failure_patterns.ts's
      // recordFailurePatternOccurrence) and auto-reopens. Same org-wide
      // (not project-scoped) treatment as `pattern_spike` — see
      // convex/alerts.ts's firePatternRegressionAlert.
      v.literal("pattern_regressed"),
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
    // Failure Patterns cycle 2: present only on alert_events fired by a
    // `pattern_spike` rule — the fingerprint whose rollup transitioned into
    // spiking. Optional/additive; every other kind leaves this unset. Not
    // itself a foreign key into failure_patterns (a rollup can in principle
    // be deleted/regenerated per ADR-005 — this is a point-in-time label, not
    // a live reference), so a plain string, mirroring
    // failure_pattern_occurrences.fingerprintHash's own type.
    patternFingerprintHash: v.optional(v.string()),
    // Freeform, kind-specific structured payload for UI/webhook consumers
    // that want more than the human-readable `summary` string — same
    // justified v.any() exception as audit_log.metadata (display-only,
    // shape varies per alert-rule kind). For `pattern_spike`, carries
    // { fingerprintHash, class, label, recentCount, deepLink } so a
    // consumer can render/link to /patterns/[fingerprint] without
    // re-parsing `summary`.
    metadata: v.optional(v.any()),
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
    // Present only when kind === "llm" — wall-clock ms spent in the provider
    // call (convex/helpers/llm_provider.ts's HttpExplanationLLM.explain), a
    // lightweight cost/latency note for observability/debugging. Never set
    // for kind === "heuristic" (no external call was made).
    generationMs: v.optional(v.number()),
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

  // ---------------------------------------------------------------------------
  // Failure Patterns (PREVENTION, cycle 1) — a durable, org-scoped memory of
  // recurring failure fingerprints derived from failed runs. OBSERVABILITY-
  // GRADE DERIVED DATA, never source of truth (mirrors ADR-002's constraint
  // language for daily_rollups/usage_counters): the event log + run_explanations
  // remain the only facts about what happened on any single run. See
  // docs/adr/005-failure-patterns.md.
  // ---------------------------------------------------------------------------

  // APPEND-ONLY, like events/evals/audit_log: one row per (runId) recording
  // that a fingerprinted failure was observed on that run. Never patched or
  // deleted. Idempotency (at most one occurrence per runId) is enforced at
  // write time (recordFailurePatternOccurrence, convex/failure_patterns.ts)
  // via the by_run index below, the same "write-time discipline, not a
  // unique constraint" pattern run_explanations.by_run and
  // verification_results.by_run already use.
  failure_pattern_occurrences: defineTable({
    orgId: v.id("organizations"),
    fingerprintHash: v.string(),
    runId: v.id("runs"),
    agentId: v.id("agents"),
    agentVersionId: v.optional(v.id("agent_versions")),
    occurredAt: v.number(),
    // Free-form classifier label (mirrors run_explanations.failureClass) —
    // not a closed enum here since the classifier vocabulary can grow
    // without a schema change.
    heuristicClass: v.string(),
    // The salient discriminator that fed the fingerprint hash (a tool name,
    // terminal event type, or normalized error signature) — stored
    // alongside the hash for display/debugging without recomputation.
    salientKey: v.string(),
  })
    // Every occurrence for a given fingerprint, org-scoped — the source rows
    // getFailurePattern's recent-occurrences + trend-bucket views read from.
    .index("by_org_fingerprint", ["orgId", "fingerprintHash"])
    // Idempotency: recordFailurePatternOccurrence checks this index first and
    // skips (no-op) if a row for this runId already exists — "unique-ish" by
    // write-time discipline, same as run_explanations.by_run.
    .index("by_run", ["runId"])
    .index("by_org_occurredAt", ["orgId", "occurredAt"]),

  // Rollup: exactly one row per (orgId, fingerprintHash), upserted by
  // recordFailurePatternOccurrence. NOT append-only — a generated/derived
  // aggregate over the occurrences above (same category as daily_rollups /
  // run_explanations), regeneratable in principle, never a fact about any
  // single run on its own.
  failure_patterns: defineTable({
    orgId: v.id("organizations"),
    fingerprintHash: v.string(),
    class: v.string(),
    label: v.string(),
    salientKey: v.string(),
    count: v.number(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    // Bounded, deduped, most-recent-first sample of runIds that produced
    // this fingerprint — cap 5 (MAX_REPRESENTATIVE_RUN_IDS).
    representativeRunIds: v.array(v.id("runs")),
    // Bounded, deduped set of agent versions this fingerprint has been seen
    // on — cap 20 (MAX_AFFECTED_AGENT_VERSION_IDS).
    affectedAgentVersionIds: v.array(v.id("agent_versions")),
    // ADR-006 Cycle 2: bounded (cap 20, MAX_AFFECTED_AGENT_IDS), deduped,
    // most-recent-first set of AGENTS this fingerprint has been observed on.
    // `affectedAgentVersionIds` above cannot stand in for this — a run's
    // `agentVersionId` is optional, so a fingerprint can have occurrences and
    // no versions at all. Maintained by recordFailurePatternOccurrence's
    // upsert. OPTIONAL/ADDITIVE: absent on every pre-this-cycle row, which is
    // why every reader falls back to deriving the agent set from a bounded
    // `failure_pattern_occurrences` read instead of requiring a backfill.
    // Two immediate readers: resolvePattern's cross-agent `versionId`
    // validation, and getPatternResolutionEvidence's post-resolution run
    // exposure count.
    affectedAgentIds: v.optional(v.array(v.id("agents"))),
    // Written by the periodic spike-rollup cron (convex/failure_patterns.ts /
    // convex/crons.ts) — the most recent spike assessment over this
    // pattern's daily trend, itself computed from the ACCURATE
    // failure_pattern_daily_counts table below (cycle 2), not a bounded
    // occurrence sample. Absent until the cron has run at least once
    // since this pattern was created.
    lastSpikeAssessment: v.optional(
      v.object({
        assessedAt: v.number(),
        isSpiking: v.boolean(),
        recentCount: v.number(),
        baselineMean: v.number(),
        z: v.number(),
      }),
    ),
    // Cycle 2 (pattern-spike alerting): epoch ms of the last time a
    // `pattern_spike` alert was fired for THIS pattern (across every
    // `pattern_spike` alert_rule in the org — this is a per-pattern cooldown,
    // not per-rule). Written only by assessPatternSpikesCron, immediately
    // after a spike-transition alert is fired. Absent = never fired. Used as
    // the anti-flap cooldown input to assessPatternSpikeTransition (or its
    // local fallback) so a pattern hovering at the spike threshold cannot
    // fire on every 15-minute cron tick.
    lastPatternSpikeAlertFiredAt: v.optional(v.number()),
    // Cycle 3 (docs/adr/005-failure-patterns.md "Cycle 3"): admin-gated,
    // org-wide suppression of alert-firing for this fingerprint. Muting does
    // NOT stop occurrence recording, rollup upkeep, or spike ASSESSMENT — it
    // only suppresses the one action assessPatternSpikesCron takes on a
    // rising-edge transition (calling alerts.ts's firePatternSpikeAlert).
    // See assessPatternSpikesCron's doc comment for the exact suppression
    // point. Written only by mutePattern/unmutePattern (both admin-gated,
    // audited). Absent/false = not muted (the default for every pre-cycle-3
    // row and every newly-created rollup).
    muted: v.optional(v.boolean()),
    // Epoch ms of the most recent mutePattern call. Not cleared on unmute —
    // it is a "last muted at" historical marker, not a "currently muted
    // since" field (muted itself is the live suppression flag).
    mutedAt: v.optional(v.number()),
    // ---------------------------------------------------------------------
    // Resolution cycle (docs/adr/006-failure-resolution.md): a human
    // lifecycle layered on top of the rollup, exactly like `comments` are a
    // human annotation hung off runs/events — NOT a new source of truth.
    // Absent `status` means "open" (every pre-this-cycle row and every
    // freshly-created rollup defaults to open by omission, not by an
    // explicit write). Written only by acknowledgePattern/resolvePattern/
    // reopenPattern (member-gated, audited) and by
    // recordFailurePatternOccurrence's own regression-guard auto-reopen path.
    // ---------------------------------------------------------------------
    status: v.optional(
      v.union(v.literal("open"), v.literal("acknowledged"), v.literal("resolved")),
    ),
    acknowledgedAt: v.optional(v.number()),
    acknowledgedByUserId: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    resolvedByUserId: v.optional(v.string()),
    // Bounded free text (<= MAX_RESOLUTION_NOTE_LENGTH) describing how/why
    // this fingerprint was resolved.
    resolutionNote: v.optional(v.string()),
    // Bounded free-form reference (<= MAX_RESOLUTION_REF_LENGTH) — e.g. an
    // agentVersionId or an external URL. Deliberately a plain string, never
    // auto-fetched/validated as a real URL server-side: if it renders as a
    // link client-side, that is a UI-layer decision, not this layer's.
    resolutionRef: v.optional(v.string()),
    // Set by the regression guard (recordFailurePatternOccurrence) the
    // moment a RESOLVED pattern receives a new occurrence dated after
    // resolvedAt — "your fix didn't hold." Cleared on reopenPattern (a human
    // manually reopening is not a regression) but NOT cleared merely by a
    // later resolvePattern (see that mutation's doc comment for why it keeps
    // this as history until the next reopen/regression).
    regressedAt: v.optional(v.number()),
    // ---------------------------------------------------------------------
    // Resolution EVIDENCE (ADR-006 Cycle 2, "prove the fix held"). A
    // resolution on its own is an unearned human assertion; these three
    // fields are the point-in-time snapshot that lets a later reader say how
    // much the claimed fix has actually been exercised since. All three are
    // written ONLY by resolvePattern, all optional/additive, and all
    // OBSERVABILITY-GRADE (CLAUDE.md "Not in v1" / ADR-002): they are
    // snapshots of derived counters, never facts about any single run, and
    // discarding them would only mean "we forget how well-tested the fix
    // was," never that anything about what happened changed.
    //
    // Everything else a "did it hold?" view needs — exposure SINCE
    // resolution, recurrences since resolution, the lifecycle transition
    // history — is derived at query time (getPatternResolutionEvidence)
    // from `runs`, this rollup's own `count`, and the append-only
    // `audit_log`. Nothing about the lifecycle is stored twice.
    // ---------------------------------------------------------------------
    // The agent version the operator believes contains the fix. Validated at
    // resolve time to exist, to belong to the caller's org, AND to belong to
    // an agent this pattern has actually been observed on — a cross-org or
    // cross-agent id is rejected with INVALID_ARGUMENT, never silently
    // dropped. Deliberately distinct from `resolutionRef` (unvalidated free
    // text): this one is a real typed foreign key.
    resolvedInVersionId: v.optional(v.id("agent_versions")),
    // BASELINE EXPOSURE: the number of runs started for this pattern's
    // affected agents in the RESOLUTION_BASELINE_WINDOW_DAYS immediately
    // BEFORE resolvedAt. It is the denominator a reader compares live
    // post-resolution exposure against ("this agent did N runs in the two
    // weeks before we called it fixed; it has done M since"). Bounded and
    // therefore approximate for very high-volume agents — see
    // RESOLUTION_RUN_SCAN_CAP in convex/failure_patterns.ts.
    resolvedAtRunCount: v.optional(v.number()),
    // The rollup's own `count` at the instant of resolution. EXACT and O(1).
    // Post-resolution recurrences are exactly `count - resolvedAtOccurrenceCount`,
    // with no extra scan — this is why the recurrence half of the evidence
    // is derivable rather than stored.
    resolvedAtOccurrenceCount: v.optional(v.number()),
    // ---------------------------------------------------------------------
    // FIX-CONFIDENCE SNAPSHOT (ADR-006 cycle 3, "make the honest answer
    // cheap"). The LIVE fix-confidence verdict
    // (convex/failure_patterns.ts's computePatternFixConfidence, backed by
    // convex/insights.ts §12) needs a bounded-but-real post-resolution run
    // exposure scan — up to RESOLUTION_RUN_SCAN_CAP rows across
    // MAX_AFFECTED_AGENT_IDS agents, PER PATTERN. That is affordable once
    // (a detail page) and impossible across a 50-pattern list page, which
    // is exactly why `read_api.apiListFailurePatterns`'s `--state` filter
    // could previously only answer the one exposure-INDEPENDENT value.
    //
    // These two fields are the periodically-refreshed SNAPSHOT of that
    // verdict, so the list filter can be served from stored values instead
    // of a six-figure row read. OBSERVABILITY-GRADE, exactly like
    // lastSpikeAssessment above and every other field on this rollup: the
    // LIVE computation remains the source of truth (and both evidence
    // endpoints still compute it live), the event log remains the only fact
    // about what happened, and discarding every snapshot here would only
    // mean "the list filter goes quiet until the cron refills it", never
    // that anything about what happened changed.
    //
    // AGREEMENT WITH THE LIVE COMPUTATION is a hard invariant, not a hope:
    // the snapshot is produced by the SAME `computePatternFixConfidence`
    // helper both evidence endpoints call, never by a parallel
    // reimplementation, and it carries `basisResolvedAt` so a snapshot
    // describing a SUPERSEDED resolution episode is detected and discarded
    // by readers rather than served as current. See
    // convex/failure_patterns.test.ts's live-vs-snapshot equality test.
    //
    // DELIBERATE SUBSET of `FixConfidenceResult`: the time-derived
    // presentation fields (`elapsedMs`, `soakCredit`, `exposureCredit`) and
    // the trivially-derivable flags (`hasResolution`, `exposureMeasured`)
    // are NOT stored — they are exactly recomputable from what IS stored,
    // and two of them are "as of now" quantities that would be definitionally
    // wrong the moment the snapshot aged. What is stored is precisely the
    // MEASUREMENT that cannot be recovered without redoing the expensive
    // scan, so the snapshot stays auditable ("0.42 because 21 matched-version
    // runs, no recurrence") rather than being a bare number to trust.
    lastFixConfidence: v.optional(
      v.object({
        /** Server clock at the moment this snapshot was computed. The input to the staleness bound. */
        computedAt: v.number(),
        /**
         * The `resolvedAt` this verdict was computed against. A reader MUST
         * compare it to the rollup's current `resolvedAt` and discard the
         * snapshot when they differ: a reopen+re-resolve starts a brand new
         * evidence episode, and grading the new one with the old one's
         * verdict is precisely the list-says-confirmed/detail-says-regressed
         * disagreement this design exists to make impossible.
         */
        basisResolvedAt: v.number(),
        state: v.union(
          v.literal("unproven"),
          v.literal("proving"),
          v.literal("confirmed"),
          v.literal("regressed"),
        ),
        score: v.number(),
        /** Runs credited as exposure (zeroed on version mismatch), as measured at `computedAt`. */
        exposureRuns: v.number(),
        /** Runs measured BEFORE version attribution was applied. */
        observedRuns: v.number(),
        /** True when the exposure scan hit RESOLUTION_RUN_SCAN_CAP — the counts above are floors. */
        exposureTruncated: v.boolean(),
        versionAttribution: v.union(v.literal("matched"), v.literal("mismatched"), v.literal("unknown")),
        recurred: v.boolean(),
        limitingFactor: v.union(
          v.literal("recurrence"),
          v.literal("no-resolution"),
          v.literal("version-mismatch"),
          v.literal("no-exposure"),
          v.literal("accumulating"),
          v.literal("none"),
        ),
      }),
    ),
    // SCHEDULING STATE for the snapshot cron: the epoch ms at or after which
    // this pattern's snapshot should be recomputed. Present ONLY on patterns
    // that currently have something to grade (a live `resolvedAt`); ABSENT on
    // every never-resolved pattern and cleared by `reopenPattern`. That
    // absence is the whole point — the cron's index range is lower-bounded at
    // 0, so a pattern whose confidence cannot change is not merely skipped,
    // it is never READ, on any tick, forever.
    fixConfidenceRefreshAt: v.optional(v.number()),
  })
    // One row per (orgId, fingerprintHash): recordFailurePatternOccurrence
    // always resolves the existing rollup (if any) via this index before
    // deciding insert-vs-patch — "unique" by write-time discipline, not a
    // Convex constraint, mirroring run_explanations.by_run.
    .index("by_org_fingerprint", ["orgId", "fingerprintHash"])
    // listFailurePatterns' ranked-by-recency read, and the spike-rollup
    // cron's "active patterns" scan.
    .index("by_org_lastSeenAt", ["orgId", "lastSeenAt"])
    // ADR-006 cycle 3 — the fix-confidence snapshot cron's ONLY access
    // pattern, and the reason it is bounded rather than a sweep:
    // `snapshotFixConfidenceCron` reads
    // `gte("fixConfidenceRefreshAt", 0).lte("fixConfidenceRefreshAt", now)`
    // ascending and takes at most
    // FIX_CONFIDENCE_SNAPSHOT_MAX_PATTERNS_PER_RUN rows. Two properties fall
    // out of that range, and both are load-bearing:
    //   - The `gte(0)` lower bound EXCLUDES documents where the field is
    //     absent (Convex sorts a missing field before every number), so
    //     never-resolved patterns — the overwhelming majority — are never
    //     read by this cron at all.
    //   - Ascending order is oldest-due-first, which makes the cron
    //     naturally resumable and starvation-free without a cursor: whatever
    //     a bounded tick could not reach stays the oldest-due work and is
    //     the first thing the next tick sees.
    // NOT a speculative index: it has exactly one query, written in the same
    // commit, and no other read pattern in this codebase can use it.
    .index("by_fix_confidence_refresh", ["fixConfidenceRefreshAt"]),

  // Cycle 2 (docs/adr/005-failure-patterns.md addendum): ACCURATE per-day
  // occurrence counters, replacing the cycle-1 trend (which bucketed a
  // BOUNDED, most-recent-first occurrence sample — see
  // MAX_TREND_OCCURRENCE_SAMPLE's removal — and silently undercounted any day
  // past that sample's horizon for a high-volume fingerprint). Exactly one
  // row per (orgId, fingerprintHash, day), upserted (incremented in place) by
  // recordFailurePatternOccurrence every time a new occurrence lands for that
  // day — additive, observability-grade, same category as daily_rollups /
  // usage_counters: NEVER itself a fact about a single run (the occurrence
  // row above remains that), just a running tally derived from it. A day's
  // count here can never retroactively change except by a NEW occurrence
  // landing on that (already-past) day, which cannot happen (occurrences are
  // always recorded for "now", never backdated) — so once a day is in the
  // past, its count here is final and exact, unlike the old bounded-sample
  // approach which could "forget" older days entirely once the sample was
  // full of more recent ones.
  failure_pattern_daily_counts: defineTable({
    orgId: v.id("organizations"),
    fingerprintHash: v.string(),
    day: v.string(), // "YYYY-MM-DD", UTC
    count: v.number(),
  })
    // recordFailurePatternOccurrence's upsert-or-increment lookup, and the
    // trend read (getFailurePattern / assessPatternSpikesCron): a `day` range
    // query scoped to one (orgId, fingerprintHash) pair reads at most
    // TREND_WINDOW_DAYS (14) rows, regardless of how many occurrences the
    // fingerprint has ever recorded — the read cost of an accurate trend is
    // now bounded by the WINDOW, not by occurrence VOLUME.
    .index("by_org_fingerprint_day", ["orgId", "fingerprintHash", "day"]),

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
