// Cycle 2 (docs/design/action_layer.md) — the key-authed READ counterpart to
// sdk_ingest.ts's writes. These are the Convex functions the CLI and other
// external, API-key-authenticated consumers call directly (no Clerk JWT —
// same API-key-hash authentication model as sdk_ingest.ts). Do NOT call
// getAuthContext or requireOrgMembership here, for the same reason
// sdk_ingest.ts doesn't: those require a Clerk JWT this caller does not have.
//
// Every function here requires the "read" scope specifically (see ADR-002 —
// api_keys.scopes gained "read" alongside "ingest:write"/"ingest:read"). A
// write-only key (scopes: ["ingest:write"], no "read") must NOT be able to
// read through these functions — resolveApiKey's scope check (shared with
// sdk_ingest.ts) enforces this: a key with a non-empty scopes array lacking
// the required scope is rejected. A key with NO scopes array at all keeps
// its pre-ADR-002 full-access back-compat behavior, exactly as it does for
// ingest.
//
// Implemented as `mutation`s (not `query`s) even though they only read
// business data: enforcing the per-key rate limit and stamping lastUsedAt —
// both REQUIRED by this cycle's scope — need write access to the api_keys
// document, which a Convex `query` cannot have. This mirrors how
// sdk_ingest.ts's write endpoints already couple business logic to that same
// bookkeeping.

import { v } from "convex/values";

import { mutation } from "./_generated/server.js";
// Constants ONLY — deliberately not this module's mutations/queries. Those are
// Clerk-authed and cannot be called from this key-authed surface (see header).
// Cycle 1 avoided importing convex/failure_patterns.ts at all because it was
// another team's in-flight deliverable; it has since landed, and the exposure
// bounds below MUST be the same numbers on both surfaces — a `read_api` that
// scanned to a different ceiling than `getPatternResolutionEvidence` would
// report a different exposure count for the same pattern depending on which
// door you came in, which is a silent correctness bug of exactly the kind
// this cycle exists to eliminate. Importing the constants makes that drift
// impossible; duplicating them would only make it invisible.
//
// ADR-006 CYCLE 3 goes further and imports the COMPUTATION, not just its
// bounds. Cycle 2 mirrored the two exposure helpers here because they were
// module-private over there; matching bounds kept the row COUNTS aligned but
// not the VERDICT, and the two doors had in fact drifted — this surface
// omitted `exposureVersionId` (so a pattern could read `mismatched`/0-exposure
// on one door and `unknown`/real-exposure on the other) while the Clerk-authed
// query lacked this surface's `recurredAt` fallback. Both mirrors are gone:
// `computePatternFixConfidence` is now the single canonical implementation
// that this endpoint, `getPatternResolutionEvidence`, and the snapshot writer
// all call.
import {
  computePatternFixConfidence,
  FIX_CONFIDENCE_SNAPSHOT_STALE_AFTER_MS,
  isFixConfidenceSnapshotStale,
  isFixConfidenceSnapshotUsable,
  MAX_PATTERN_LIFECYCLE_TRANSITIONS,
} from "./failure_patterns.js";
import { DEFAULT_PAGE_SIZE, MAX_EVENTS_PER_REPLAY, MAX_PAGE_SIZE } from "./helpers/pagination.js";
import { buildReplayProjectionMirror } from "./helpers/replay_projection.js";
import { fixConfidence } from "./insights.js";
// The SCHEMA ITSELF is the valid-field set for projection (see
// §FIELD PROJECTION below). Imported for its table validators only — a
// hand-maintained list of field names would drift the first time anyone added
// a column, and a projection that rejects a field the table actually has is
// indistinguishable to the caller from a field that does not exist.
import schema from "./schema.js";
import { enforceRateLimit, resolveApiKey } from "./sdk_ingest.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type {
  PatternLifecycleTransition,
  PatternResolutionExposure,
  PatternResolutionMetadata,
} from "./failure_patterns.js";
import type { FixConfidenceResult } from "./insights.js";

const READ_SCOPE = "read";

/** Shared entry: resolve + authorize the key for the "read" scope, count 1 rate-limit unit. */
async function resolveReadApiKey(ctx: MutationCtx, apiKeyHash: string): Promise<Doc<"api_keys">> {
  const apiKey = await resolveApiKey(ctx, apiKeyHash, READ_SCOPE);
  await enforceRateLimit(ctx, apiKey, 1);
  return apiKey;
}

const RUN_STATUS = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("timed_out"),
);

// ===========================================================================
// FIELD PROJECTION (`fields`)
// ===========================================================================
//
// WHY IT IS SERVER-SIDE. The MCP server (packages/mcp) already projects
// documents down to a handful of fields before handing them to an agent, but
// it does so AFTER receiving the full thirty-field document. That saves the
// agent's context window and nothing else: the wire bytes, the Convex read
// bandwidth, and the JSON serialization of every unwanted field were all
// already paid. `fields` moves the projection to the only place that can
// actually avoid those costs.
//
// THE FIVE RULES OF THIS CONTRACT. Three other teams build against them; they
// are properties of the API, not implementation details.
//
//  1. OMITTING `fields` RETURNS THE FULL DOCUMENT, byte-for-byte as before.
//     Projection is purely opt-in; every existing caller is unaffected.
//
//  2. AN UNKNOWN FIELD NAME IS A HARD ERROR, never silently ignored. This is
//     the rule most likely to be "simplified" by a future editor, so: a
//     dropped field name yields a document that is MISSING the data the
//     caller asked for, which on the wire is indistinguishable from a
//     document where that data is legitimately absent/null. This codebase has
//     shipped that exact class of bug three times (see
//     tests/unit/api_v1_failure_patterns_params.test.ts for the most recent).
//     Rejecting loudly is the only behavior a caller can build on.
//
//  3. THE IDENTITY FIELD IS ALWAYS RETURNED, requested or not — `_id` for
//     runs, `sequenceNumber` for events, `fingerprintHash` for failure
//     patterns. A row you cannot address is not a useful row: the caller
//     cannot fetch its detail, cannot de-duplicate it across pages, and
//     cannot correlate it with anything. Callers do not have to remember to
//     ask.
//
//  4. AN EMPTY ARRAY IS AN ERROR, not "return nothing". `fields: []` is
//     overwhelmingly a bug in the caller's argument construction (a filter or
//     `.map` that produced no entries), and answering it with a page of
//     identity-only stubs would hide that bug behind plausible-looking data.
//
//  5. PROJECTION IS APPLIED AFTER ORG FILTERING, NEVER AS PART OF IT. Field
//     selection changes what each record CONTAINS and can never change WHICH
//     records come back. Every filter, index range, cursor and org check
//     below runs against the complete document; `projectDoc` is the last
//     thing that touches a row before it is returned.
//
// TENANCY. Field-name validation happens BEFORE any record lookup, in exactly
// the position and for exactly the reason `apiGetRunEvents`'s `fromSequence`
// validation does: an unknown-field error must be byte-identical whether the
// referenced record is in the key's org, does not exist, or belongs to
// another org. Validating after the lookup would make the error text a
// cross-org existence oracle — this codebase closed 25 of those and is not
// opening a 26th for a convenience parameter. Tests assert the three cases
// produce identical messages.

/** Resources whose documents this surface will project. Table names, so they cannot drift from the schema. */
type ProjectableTable = "runs" | "events" | "failure_patterns";

/**
 * Convex system fields. Present on every document, absent from the schema's
 * own validator, and legitimately selectable — `_creationTime` in particular
 * is the only ordering key some rows have.
 */
const SYSTEM_FIELDS = ["_id", "_creationTime"] as const;

/**
 * The identity field per resource, always included in a projection.
 * Deliberately NOT always `_id`: an event is addressed by its
 * `sequenceNumber` within its run (Event Log Rule 4) and a failure pattern by
 * its `fingerprintHash` (which is what every pattern-scoped endpoint here
 * takes as its key), so those are the identifiers a caller actually needs
 * back in order to do anything with the row.
 */
const IDENTITY_FIELD: Record<ProjectableTable, string> = {
  runs: "_id",
  events: "sequenceNumber",
  failure_patterns: "fingerprintHash",
};

/**
 * The valid field set for a resource, derived from the live schema rather
 * than restated here. Sorted so the error message's "valid fields are: ..."
 * list is stable across deployments — a caller (or a test) comparing two
 * error strings must not see them differ because of field declaration order.
 */
function validFieldsFor(table: ProjectableTable): string[] {
  return [...SYSTEM_FIELDS, ...Object.keys(schema.tables[table].validator.fields)].sort();
}

/** The `fields` validator, identical on every function that accepts it. */
const FIELDS_ARG = v.optional(v.array(v.string()));

/**
 * Validate a `fields` selection and expand it with the resource's identity
 * field. Returns `undefined` for an omitted selection, which `projectDoc`
 * treats as "return the whole document".
 *
 * MUST be called before any `ctx.db.get`/index read — see the TENANCY note
 * above.
 */
function validateFieldSelection(
  table: ProjectableTable,
  fields: string[] | undefined,
): ReadonlySet<string> | undefined {
  if (fields === undefined) return undefined;

  const valid = validFieldsFor(table);
  if (fields.length === 0) {
    throw new Error(
      `INVALID_ARGUMENT: fields must not be empty for ${table}; omit the argument to receive the full document (valid fields are: ${valid.join(", ")})`,
    );
  }

  const validSet = new Set(valid);
  for (const name of fields) {
    if (!validSet.has(name)) {
      throw new Error(
        `INVALID_ARGUMENT: unknown field "${name}" for ${table}; valid fields are: ${valid.join(", ")}`,
      );
    }
  }

  // Rule 3: identity is not optional. Adding it here (rather than at
  // projection time) also means a caller who DID request it is unaffected —
  // a Set makes the two cases identical.
  return new Set([...fields, IDENTITY_FIELD[table]]);
}

/**
 * Project one document down to a validated selection.
 *
 * Iterates the DOCUMENT's keys, not the selection's, so a requested-but-unset
 * optional field stays ABSENT rather than becoming an explicit `undefined`.
 * That matters: `{ endedAt: undefined }` and `{}` serialize differently and a
 * projected document must be indistinguishable from the corresponding slice
 * of the full document.
 *
 * TYPING NOTE — the cast back to `T` is deliberate. Widening the declared
 * return type to `T | Partial<T>` would break every existing consumer of
 * these functions (apps/web services, the CLI, the SDK reader) even though
 * none of them passes `fields`, which would violate rule 1 at the type level
 * while honoring it at runtime. A caller that opts into `fields` has, by
 * opting in, taken responsibility for reading only what it asked for.
 */
function projectDoc<T extends Record<string, unknown>>(doc: T, selection: ReadonlySet<string> | undefined): T {
  if (selection === undefined) return doc;
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(doc)) {
    if (selection.has(key)) projected[key] = doc[key];
  }
  return projected as T;
}

/** Vectorized `projectDoc`, for the list endpoints. */
function projectDocs<T extends Record<string, unknown>>(docs: T[], selection: ReadonlySet<string> | undefined): T[] {
  if (selection === undefined) return docs;
  return docs.map((doc) => projectDoc(doc, selection));
}

/**
 * List runs for the key's org, with the same filter shape as convex/runs.ts
 * listRuns (status/agentId/environment/session), paginated. Cross-org
 * references (a foreign agentId) are validated the same way listRuns does.
 *
 * `fields` (optional) projects each returned run — see §FIELD PROJECTION.
 * `_id` is always present. Filtering happens on the complete documents; the
 * projection is applied to the finished page and cannot change which runs it
 * contains.
 */
export const apiListRuns = mutation({
  args: {
    apiKeyHash: v.string(),
    status: v.optional(RUN_STATUS),
    agentId: v.optional(v.string()),
    environment: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    fields: FIELDS_ARG,
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    // BEFORE the agent lookup below, which is itself a record lookup that can
    // throw "not found in this organization" — a bad field name must not be
    // able to tell those two failures apart.
    const selection = validateFieldSelection("runs", args.fields);
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    let agentId: Id<"agents"> | undefined;
    if (args.agentId !== undefined) {
      agentId = args.agentId as Id<"agents">;
      const agent = await ctx.db.get(agentId);
      if (!agent || agent.orgId !== apiKey.orgId) {
        throw new Error("Agent not found in this organization");
      }
    }

    if (args.sessionId !== undefined) {
      const runs = await ctx.db
        .query("runs")
        .withIndex("by_org_session", (q) => q.eq("orgId", apiKey.orgId).eq("sessionId", args.sessionId))
        .order("desc")
        .take(limit);
      // pageSize counts ROWS, and is computed from the pre-projection array
      // for that reason — projection never changes cardinality.
      return { runs: projectDocs(runs, selection), nextCursor: undefined, pageSize: runs.length };
    }

    let runsQuery;
    if (agentId !== undefined) {
      runsQuery = ctx.db.query("runs").withIndex("by_agent_started", (q) => q.eq("agentId", agentId));
    } else if (args.status !== undefined) {
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_org_status", (q) => q.eq("orgId", apiKey.orgId).eq("status", args.status!));
    } else if (args.environment !== undefined) {
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_org_environment_started", (q) =>
          q.eq("orgId", apiKey.orgId).eq("environment", args.environment),
        );
    } else {
      runsQuery = ctx.db.query("runs").withIndex("by_org", (q) => q.eq("orgId", apiKey.orgId));
    }

    // Tenancy safety net, mirroring runs.ts listRuns.
    //
    // AUDIT FIX (cycle 4): when `agentId` is supplied, the branch above
    // selects `by_agent_started`, which encodes neither `status` nor
    // `environment` — both used to be silently dropped whenever combined
    // with `agentId` (e.g. `agentId=X&status=failed` returned ALL of agent
    // X's runs, not just its failed ones, with no error). Re-applied here —
    // redundant but harmless in the branches where the index already encoded
    // the condition (by_org_status / by_org_environment_started).
    //
    // THESE ARE `q.filter()` PREDICATES, NOT AN IN-MEMORY PASS OVER A
    // FINISHED PAGE, and that distinction is the whole reason this endpoint
    // does not need the overfetch-then-filter machinery
    // `apiListFailurePatterns` below does. Convex applies a `.filter()`
    // during pagination, so `numItems` counts rows that ALREADY SATISFIED
    // every predicate: a request for 25 returns 25 matches if 25 exist
    // anywhere down the cursor, and an empty page really does mean "nothing
    // matched". Filtering the RESULT of `.paginate()` instead — which is
    // what this function's comments used to describe, inaccurately — is the
    // silent-empty-page bug fixed below. Do not "simplify" these into a
    // `page.page.filter(...)`.
    const filtered = runsQuery
      .filter((q) => q.eq(q.field("orgId"), apiKey.orgId))
      .filter((q) =>
        args.status === undefined ? q.eq(q.field("_id"), q.field("_id")) : q.eq(q.field("status"), args.status),
      )
      .filter((q) =>
        args.environment === undefined
          ? q.eq(q.field("_id"), q.field("_id"))
          : q.eq(q.field("environment"), args.environment),
      );
    const page = await filtered.paginate({ numItems: limit, cursor: args.cursor ?? null });

    return {
      // LAST thing to touch the rows: every filter, index range and cursor
      // above ran against the complete documents.
      runs: projectDocs(page.page, selection),
      nextCursor: page.isDone ? undefined : page.continueCursor,
      pageSize: page.page.length,
    };
  },
});

/**
 * A single run plus cheap derived counts. eventCount is read from the
 * highest stored sequenceNumber (O(1) via the by_run index) rather than a
 * `.collect()` — sequence numbers are contiguous from 1 (Event Log Rule 4),
 * so the max sequence number IS the event count. artifactCount is bounded by
 * MAX_ARTIFACTS_PER_RUN already, so a direct count is cheap.
 *
 * `fields` (optional) projects the `run` document only — see §FIELD
 * PROJECTION. `_id` is always present. The derived `eventCount` /
 * `artifactCount` are NOT run fields and are always returned: they are
 * already the cheap summary this endpoint exists to provide, and making them
 * selectable would invite a caller to ask for a "field" that has no
 * corresponding column.
 */
export const apiGetRun = mutation({
  args: { apiKeyHash: v.string(), runId: v.string(), fields: FIELDS_ARG },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    // BEFORE the run lookup: identical error for present / absent / other-org.
    const selection = validateFieldSelection("runs", args.fields);
    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found in this organization");
    }

    const latestEvent = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .order("desc")
      .first();
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect();

    return {
      run: projectDoc(run, selection),
      eventCount: latestEvent ? latestEvent.sequenceNumber : 0,
      artifactCount: artifacts.length,
    };
  },
});

/**
 * Paginated event log for a run, same shape as convex/events.ts listEvents.
 *
 * `fromSequence` (optional) makes this a WINDOW read: only events with
 * `sequenceNumber >= fromSequence` are considered, and the page starts at
 * that floor instead of at the head of the log. This is a RANGE READ on the
 * EXISTING `by_run: ["runId", "sequenceNumber"]` index (convex/schema.ts) —
 * no new index, no migration, no scan of the events before the floor. It
 * exists so a caller that wants a window around sequence N (the MCP server's
 * tier-4 tool, packages/mcp) does not have to page through the N-1 events
 * before it just to reach it; fetching the whole log and slicing client-side
 * is exactly the token cost this parameter removes.
 *
 * A `fromSequence` past the end of the run is NOT an error — sequence
 * numbers are contiguous from 1 (Event Log Rule 4), so "past the end" is
 * simply an empty page. It is validated as a positive integer here as
 * defense in depth; the v1 route (apps/web/app/api/v1/runs/[runId]/events)
 * already rejects a malformed value with 400/INVALID_ARGUMENT before this
 * function is reached. Both surfaces REJECT rather than coerce: a silently
 * clamped or truncated floor returns the wrong window while looking like a
 * correct answer.
 *
 * Callers that need to distinguish "the server honored my floor" from "the
 * server is an older deployment that dropped the unknown arg and handed back
 * the head of the log" can compare the first returned event's
 * `sequenceNumber` against the requested floor — the two are otherwise
 * indistinguishable, which is why this implementation must genuinely honor
 * the floor rather than accept-and-ignore it.
 *
 * `fields` (optional) projects each returned event — see §FIELD PROJECTION.
 * `sequenceNumber` is always present (it is the event's identity within its
 * run), so a caller can always tell where in the log a projected event sits,
 * and the accept-and-ignore check described above keeps working under
 * projection. `fields: ["type"]` is the cheap "what happened, in order" read
 * that does not drag every `payload` across the wire.
 */
export const apiGetRunEvents = mutation({
  args: {
    apiKeyHash: v.string(),
    runId: v.string(),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    fromSequence: v.optional(v.number()),
    fields: FIELDS_ARG,
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);

    // Validated BEFORE the run lookup for exactly the same reason
    // `fromSequence` is, immediately below — and deliberately in the same
    // place, so the two argument validations cannot diverge in their
    // oracle-safety. Note that a bad `fields` and a bad `fromSequence` are
    // both decided with zero database reads, so neither can leak whether the
    // run exists.
    const selection = validateFieldSelection("events", args.fields);

    const fromSequence = args.fromSequence;
    if (fromSequence !== undefined && (!Number.isSafeInteger(fromSequence) || fromSequence < 1)) {
      throw new Error(
        "INVALID_ARGUMENT: fromSequence must be a positive integer (sequence numbers start at 1)",
      );
    }

    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found in this organization");
    }

    const limit = Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const page = await ctx.db
      .query("events")
      .withIndex("by_run", (q) =>
        fromSequence === undefined
          ? q.eq("runId", runId)
          : q.eq("runId", runId).gte("sequenceNumber", fromSequence),
      )
      .paginate({ numItems: limit, cursor: args.cursor ?? null });

    return {
      // Applied after the window floor and the org check, never as part of
      // them: `fields` cannot move the floor or change which events match it.
      events: projectDocs(page.page, selection),
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
  },
});

/**
 * Replay projection for a run, built via the read_api's own mirror of
 * apps/web's buildReplayProjection (see helpers/replay_projection.ts header
 * for why this is a mirror, not a cross-boundary import).
 */
export const apiGetReplay = mutation({
  args: { apiKeyHash: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found in this organization");
    }

    const events = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(MAX_EVENTS_PER_REPLAY);

    return buildReplayProjectionMirror(
      String(runId),
      events.map((e) => ({
        id: String(e._id),
        type: e.type,
        sequenceNumber: e.sequenceNumber,
        timestamp: e.timestamp,
        payload: e.payload,
        parentEventId: e.parentEventId !== undefined ? String(e.parentEventId) : undefined,
        // ADR-007. Both are REQUIRED for the projection to know whether its
        // frame order is a timeline or an arrival log. Dropping them here
        // would make every derived run report `sequence-native` — a silent
        // claim of full confidence over collector flush order.
        provenance: e.provenance,
        temporalOrder: e.temporalOrder,
      })),
    );
  },
});

// Key-authed (read scope) counterpart to run_explanations.getRunExplanation —
// the "Why did this fail?" root-cause for the v1 API / `afr explain`. Org is
// derived from the key, never a client arg.
//
// AUDIT FIX (Cycle 3, MEDIUM — coarse-null, same finding as
// run_explanations.getRunExplanation): this used to return
// `{ explanation: null }` for both "will never have one" (not
// failed/timed_out/cancelled) and "not generated yet" (eligible, still in
// flight). `status` is the explicit discriminant now, mirroring
// run_explanations.ts's `RunExplanationQueryStatus` exactly, so `afr explain`
// (packages/cli, sdk_quality-owned) can print "not applicable" vs "still
// analyzing, try again shortly" instead of the same blank result for both.
// `explanation` is kept (rather than removed) for backward compatibility
// with any existing caller that only checked truthiness of that field.
const V1_EXPLAINABLE_STATUSES = new Set(["failed", "timed_out", "cancelled"]);

export const apiGetExplanation = mutation({
  args: { apiKeyHash: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    const runId = args.runId as Id<"runs">;
    const run = await ctx.db.get(runId);
    if (!run || run.orgId !== apiKey.orgId) {
      throw new Error("Run not found in this organization");
    }
    if (!V1_EXPLAINABLE_STATUSES.has(run.status)) {
      return { status: "not_eligible" as const, explanation: null, runStatus: run.status, runEndedAt: run.endedAt };
    }
    const explanation = await ctx.db
      .query("run_explanations")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .first();
    if (!explanation || explanation.orgId !== run.orgId) {
      return { status: "pending" as const, explanation: null, runStatus: run.status, runEndedAt: run.endedAt };
    }
    return { status: "ready" as const, explanation, runStatus: run.status, runEndedAt: run.endedAt };
  },
});

// Key-authed (read scope) counterpart to the Failure Patterns rollup
// (PREVENTION, cycle 1 — docs/adr/005-failure-patterns.md, schema.ts's
// `failure_patterns` table). Powers `afr patterns` / the SDK's read client:
// a durable, org-scoped memory of recurring failure fingerprints, ranked by
// recency. This queries the `failure_patterns` rollup table directly (same
// "mirror the shape, don't cross-import an in-progress owner's function"
// approach apiListRuns/apiGetRun/apiGetReplay already take here) rather than
// depending on convex/failure_patterns.ts, which is a separate team's
// same-cycle deliverable and may not exist yet.
//
// `agentId`, when supplied, is validated org-scoped exactly like apiListRuns'
// `agentId` filter, then resolved to that agent's `agent_versions` ids so the
// already org-scoped patterns can be narrowed to ones whose
// `affectedAgentVersionIds` intersects.
//
// EVERY FILTER ON THIS ENDPOINT IS IN-MEMORY (none of the fields they read is
// indexed), which is why this function — alone on this surface — runs the
// bounded overfetch-then-filter scan documented immediately above
// `apiListFailurePatterns` rather than filtering a single `.paginate()` page.
// apiListRuns is NOT a precedent for that: its secondary filters are
// `q.filter()` predicates that Convex applies DURING pagination.
//
// `spiking`, when `true` (PREVENTION cycle 2 — proactive filtering), narrows
// the same fetched page further to patterns whose most recent spike
// assessment flagged them as currently spiking
// (`lastSpikeAssessment?.isSpiking === true`). Same bounded-scan in-memory
// approach as `agentId` above — there is no secondary index on
// `lastSpikeAssessment.isSpiking` (it's an optional nested field on a rollup
// row, not worth a dedicated index for what is an observability-grade,
// derived filter). `spiking: false` (or omitted) returns all patterns,
// unfiltered by spike status.
//
// `muted` (PREVENTION cycle 3, "mute reflection" — sdk_quality) is the same
// shape of filter again, this time over the `muted` flag an org admin sets
// via the (separate, Clerk-authed, audited) admin mute route — NOT a write
// this key-authed surface exposes. `muted: true` narrows to muted patterns,
// `muted: false` to active/unmuted ones, omitted returns all regardless of
// mute state.
function isPatternMuted(pattern: Doc<"failure_patterns">): boolean {
  return pattern.muted === true;
}

// `status`/`regressed` (Resolution cycle 1 — docs/adr/006-failure-resolution.md,
// Team A's lifecycle fields on `failure_patterns`): same bounded-scan,
// in-memory approach as `spiking`/`muted` above — no secondary index on
// `status`/`regressedAt`, both are read-side-only narrowings over the already
// org-scoped page. `status`, when supplied, matches exactly against the
// pattern's `status` field, treating an absent field as `"open"` (the
// documented default for every pre-lifecycle row). `regressed: true` narrows
// to patterns that currently have `regressedAt` set. Neither param sets
// lifecycle state — that only changes via the member-gated, audited
// acknowledge/resolve/reopen mutations (not owned by this file), exactly
// like `muted` is never set here.
function patternStatus(pattern: Doc<"failure_patterns">): string {
  return pattern.status ?? "open";
}

// ---------------------------------------------------------------------------
// `state` (ADR-006 cycle 2) — the FIX-CONFIDENCE grade, Team B's vocabulary
// verbatim (`FixConfidenceState`, convex/insights.ts §12). A different axis
// from `status`: `status` is what a human ASSERTED, `state` is what the
// evidence SUPPORTS. Both are exposed, and they are deliberately not merged.
//
// ALL FOUR VALUES ARE NOW ANSWERABLE (ADR-006 cycle 3). They were not
// before, and the reason is worth keeping because it shaped the design:
// "unproven"/"proving"/"confirmed" are functions of POST-RESOLUTION EXPOSURE
// — how many runs have executed since the fix — which costs a bounded scan of
// up to RESOLUTION_RUN_SCAN_CAP (2000) run rows across up to
// MAX_AFFECTED_AGENT_IDS agents PER PATTERN. Across a page of up to
// MAX_PAGE_SIZE patterns that is a six-figure row read on one request: not a
// slow endpoint, an endpoint that cannot exist. Cycle 2 therefore rejected
// those three loudly with a 422 rather than either silently dropping the
// filter or answering it without exposure (which would grade every unrecurred
// pattern "unproven" regardless of how well-tested it actually was — a wrong
// answer dressed as a real one).
//
// Cycle 3 does not make the scan cheaper; it moves it OFF the read path.
// `failure_patterns.lastFixConfidence` is a periodically-refreshed snapshot of
// the same canonical verdict, so the filter is served from a stored value.
// Three rules keep that from re-introducing the lie the rejection was
// protecting against:
//
//   1. SAME COMPUTATION. The snapshot is produced by
//      `computePatternFixConfidence` — the identical function this file's
//      evidence endpoint and the Clerk-authed detail query call. There is no
//      second implementation that could drift, and a test asserts the stored
//      snapshot equals a live computation for the same fixture.
//   2. SUPERSEDED SNAPSHOTS ARE DISCARDED, NOT SERVED.
//      `isFixConfidenceSnapshotUsable` requires the snapshot's
//      `basisResolvedAt` to match the rollup's current `resolvedAt`, so a
//      verdict about a PREVIOUS resolution episode (reopened and re-resolved
//      since) can never answer for the current one.
//   3. AGE IS REPORTED, NEVER HIDDEN. A snapshot older than
//      FIX_CONFIDENCE_SNAPSHOT_STALE_AFTER_MS is still served — it remains the
//      best available answer — but it is flagged `stale: true` in the
//      response's `fixConfidence` envelope, alongside the bound itself so a
//      client never has to hardcode it. Dropping stale rows from the filter
//      instead would be a silent lie by omission, which is strictly worse.
//      Serving a stale snapshot is safe in the one direction that matters:
//      soak and exposure only accumulate, so an aging snapshot can UNDER-report
//      (say "proving" where live says "confirmed") but not over-report, and
//      the single downgrade a verdict can take — `regressed` — is written
//      EAGERLY by the regression guard and never waits for a cron tick.
//
// PATTERNS WITH NO USABLE SNAPSHOT ARE NAMED, NOT DISAPPEARED. A rollup that
// has a live resolution but no usable snapshot yet (resolved before this cycle
// shipped and untouched since) cannot be graded. It is excluded from the
// filtered result — it genuinely does not match a known state — but its
// fingerprint is returned in `fixConfidence.unevaluated`, so a caller can say
// "3 patterns on this page have no confidence snapshot yet" instead of
// silently treating "unknown" as "no". `state=regressed` is exempt: see below.
//
// `state=regressed` KEEPS ITS EXACT, SNAPSHOT-FREE PATH as well as reading the
// snapshot, and matches if EITHER says so. `regressed` is the one
// exposure-INDEPENDENT verdict — it falls out of `recurred` alone, decided by
// two timestamps already on the rollup — so it is exactly computable per
// pattern at O(1) with no scan. Keeping that path means this filter is never
// weaker than it was before snapshots existed, and never depends on cron
// liveness for the one state a CI gate is built on.
//
// This is ALSO why `state=regressed` is not redundant with the existing
// `regressed` boolean, and why a CI job should prefer it: `regressed: true`
// matches any pattern with `regressedAt` SET, including one whose regression
// predates its current resolution (regressed, then genuinely re-fixed and
// re-resolved — `resolvePattern` deliberately preserves `regressedAt` as
// history). `state=regressed` matches only a recurrence STRICTLY AFTER the
// live `resolvedAt`, i.e. a fix that actually did not hold. Using the boolean
// for "fail the build if a confirmed-fixed pattern regressed" would fail
// builds on patterns that were already fixed again.
// ---------------------------------------------------------------------------

/** Per-pattern confidence view returned alongside every listed pattern. */
interface ApiPatternConfidenceEntry {
  fingerprintHash: string;
  /** Null when the pattern has no usable snapshot (never resolved, reopened, superseded, or not yet snapshotted). */
  state: string | null;
  score: number | null;
  /** When the served verdict was computed. Null when there is no snapshot. */
  computedAt: number | null;
  /** `now - computedAt`. Null when there is no snapshot. */
  ageMs: number | null;
  /** True when `ageMs` exceeds the staleness bound. Always false when there is no snapshot — absent is not stale, it is unknown. */
  stale: boolean;
  /**
   * `"snapshot"` — served from a usable stored verdict.
   * `"none"` — no usable snapshot; `state`/`score` are null and the pattern
   * was NOT evaluated against a `state` filter (except `regressed`, which has
   * its own exact path).
   */
  basis: "snapshot" | "none";
}

function confidenceEntryFor(pattern: Doc<"failure_patterns">, now: number): ApiPatternConfidenceEntry {
  const snapshot = isFixConfidenceSnapshotUsable(pattern) ? pattern.lastFixConfidence : undefined;
  if (!snapshot) {
    return {
      fingerprintHash: pattern.fingerprintHash,
      state: null,
      score: null,
      computedAt: null,
      ageMs: null,
      stale: false,
      basis: "none",
    };
  }
  return {
    fingerprintHash: pattern.fingerprintHash,
    state: snapshot.state,
    score: snapshot.score,
    computedAt: snapshot.computedAt,
    ageMs: Math.max(0, now - snapshot.computedAt),
    stale: isFixConfidenceSnapshotStale(snapshot, now),
    basis: "snapshot",
  };
}

/**
 * The evidence state of a rollup, computed WITHOUT measuring exposure.
 *
 * Delegates to Team B's `fixConfidence` rather than reimplementing the
 * precedence rules, so the recurrence definition ("strictly after
 * `resolvedAt`", and a recurrence with no usable resolution still counts)
 * cannot drift from §12. Exposure is deliberately left unmeasured, which is
 * why only the `regressed` verdict from this call is trustworthy — every
 * other pattern necessarily reads `unproven` here.
 */
function recurredSinceResolution(pattern: Doc<"failure_patterns">, now: number): boolean {
  return (
    fixConfidence(
      {
        ...(pattern.resolvedAt !== undefined && { resolvedAt: pattern.resolvedAt }),
        ...(pattern.regressedAt !== undefined && { recurredAt: pattern.regressedAt }),
      },
      now,
    ).state === "regressed"
  );
}

// ---------------------------------------------------------------------------
// BOUNDED OVERFETCH-THEN-FILTER (the fix for the silent-empty-page bug)
// ---------------------------------------------------------------------------
//
// THE BUG THIS REPLACES. Every one of this endpoint's filters — agentId,
// spiking, muted, status, regressed, state — reads a field with no index, so
// all of them run in memory. They used to run in memory over ONE
// already-paginated page: `.paginate({ numItems: limit })` first, `.filter()`
// second. `numItems` therefore counted ROWS EXAMINED, not rows matched, so a
// request for 25 could return 0 matches with a `nextCursor` set while matches
// sat on page 2. The caller saw a well-formed empty page and no way to tell it
// from "nothing matched".
//
// WHY THAT WAS WORSE THAN A COSMETIC PAGINATION WART. `state=regressed` exists
// to be a CI gate — "fail the build if a confirmed-fixed pattern regressed"
// (`afr patterns --state regressed`). Under the old ordering that command
// could report all-clear while a regression sat one page down, and the build
// went green. A regression detector that silently answers "nothing here" is
// worse than no detector, because a team stops looking. This is the same
// family as the `--spiking`/`--muted` defect that shipped for weeks: the
// filter predicate was correct both times, and the ANSWER was still wrong.
//
// THE SHAPE OF THE FIX is runs.ts's `listRunsByVerification`, deliberately —
// this codebase now has exactly two overfetch-then-filter readers and they
// work the same way, rather than three that each work slightly differently:
//
//   * Read a scan window LARGER than `limit` from the base index, then count
//     MATCHES rather than rows when deciding what the page contains.
//   * Bound that window. A filter with no matches in a large org must not turn
//     one request into a full-table read.
//   * Carry `{ underlyingCursor, skip }` as the cursor instead of a raw Convex
//     cursor, for the reason spelled out on `VerifyCursor` in runs.ts: a scan
//     window can yield MORE matches than `limit`, and a raw continuation
//     cursor can only resume PAST the whole window, so the surplus matches
//     would be skipped outright. `skip` resumes mid-window.
//
// WHY ONE BIG `.paginate()` AND NOT A LOOP OF SMALL ONES. The obvious
// implementation — keep paginating until `limit` matches accumulate — does not
// run. Convex permits exactly ONE `.paginate()` per function execution
// ("Only a single paginated query is allowed per function execution", enforced
// at runtime by the real backend and by convex-test alike). A loop was written
// first and every filtered test failed on that error, so: the window is taken
// in a single call, and the ceiling is therefore the window SIZE rather than a
// running total across batches. Do not reintroduce the loop.
//
// The consequence is that the scan window is sized by whether an in-memory
// filter is actually active. With none, `limit` rows ARE `limit` matches and
// the endpoint reads exactly what it returns, byte-for-byte as before. Only a
// filtered request pays for the wider window, which is the request that
// previously got a wrong answer for free.
//
// AND IT SAYS SO WHEN IT STOPS SHORT. Stopping on the ceiling — window full,
// page not filled, table not exhausted — sets `scanTruncated: true` alongside
// `nextCursor`, the same contract `exposure.runCountTruncated` already offers
// ("this number is a floor, ask again to see more"). A silently capped scan is
// the original bug wearing a different hat: it produces a short-or-empty page
// that is, on the wire, indistinguishable from a complete answer. With the
// flag, an empty page carrying `scanTruncated: false` means "nothing matched,
// full stop" — and that is the assertion a CI gate is entitled to make.

/**
 * Hard ceiling on rows examined for one request. The endpoint returns
 * `scanTruncated: true` plus a resumable cursor rather than reading past it.
 * Chosen to sit in the same order of magnitude as the other bounded scans this
 * surface already performs per request (the resolution exposure scan's 2000
 * run rows), so a `--state` query costs no more than the evidence endpoint it
 * complements.
 */
const PATTERN_SCAN_ROW_CEILING = 2_000;

/**
 * This endpoint's cursor: the underlying `failure_patterns` cursor for the
 * START of the scan window that produced this page, plus how many of that
 * window's matches have already been delivered. Opaque to callers — a string
 * they hand back unmodified. Same encoding as runs.ts's `VerifyCursor`.
 */
interface PatternScanCursor {
  underlyingCursor: string | null;
  skip: number;
}

function decodePatternScanCursor(cursor: string | undefined): PatternScanCursor {
  if (!cursor) return { underlyingCursor: null, skip: 0 };
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (
      parsed &&
      typeof parsed === "object" &&
      "skip" in parsed &&
      typeof (parsed as { skip: unknown }).skip === "number"
    ) {
      const p = parsed as { underlyingCursor: string | null; skip: number };
      return { underlyingCursor: p.underlyingCursor ?? null, skip: Math.max(0, p.skip) };
    }
  } catch {
    // fall through to the fallback below
  }
  // BACK-COMPAT + defence: a cursor issued by the previous implementation (or
  // by anything else) is a raw underlying cursor. Treating it as one keeps an
  // in-flight pagination from erroring across a deploy; it simply resumes at
  // that batch boundary with nothing skipped.
  return { underlyingCursor: cursor, skip: 0 };
}

function encodePatternScanCursor(c: PatternScanCursor): string {
  return JSON.stringify(c);
}

export const apiListFailurePatterns = mutation({
  args: {
    apiKeyHash: v.string(),
    agentId: v.optional(v.string()),
    spiking: v.optional(v.boolean()),
    muted: v.optional(v.boolean()),
    status: v.optional(v.union(v.literal("open"), v.literal("acknowledged"), v.literal("resolved"))),
    regressed: v.optional(v.boolean()),
    // Team B's FULL four-literal vocabulary (never a parallel one). All four
    // are answerable as of ADR-006 cycle 3 — the arg's name, type and meaning
    // are unchanged from cycle 2, exactly as that cycle's rejection comment
    // promised they would be.
    state: v.optional(
      v.union(
        v.literal("unproven"),
        v.literal("proving"),
        v.literal("confirmed"),
        v.literal("regressed"),
      ),
    ),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    // Projects the returned `patterns` documents only — see §FIELD
    // PROJECTION. `fingerprintHash` is always present. The `fixConfidence`
    // envelope is NOT projected and is keyed by `fingerprintHash`, so it
    // stays joinable to a projected page no matter how narrow the selection;
    // that is a second, independent reason identity is non-optional here.
    //
    // Every filter above (agentId / spiking / muted / status / regressed /
    // state) reads fields that a narrow projection would omit — which is
    // precisely why projection runs last, on the finished page. Selecting
    // `["label"]` must not quietly disable the `state` filter.
    fields: FIELDS_ARG,
  },
  handler: async (ctx, args) => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    // BEFORE the agent lookup below (which throws "not found in this
    // organization" for a foreign agentId) — same oracle argument as
    // apiListRuns.
    const selection = validateFieldSelection("failure_patterns", args.fields);
    // AUDIT FIX (cycle 3): clamp below 1 as well as above MAX_PAGE_SIZE — an
    // unclamped non-positive `limit` (e.g. `--limit -5`, or `0`) used to be
    // passed straight to `.paginate({ numItems })` unvalidated, which is at
    // best a confusing empty/degenerate page and at worst an unhandled
    // Convex-side error surfaced as a raw 500. Every caller-supplied `limit`
    // on this key-authed surface should produce either "the request was
    // rejected in a well-understood way" or "a valid, bounded page" — never
    // an unbounded or negative page size reaching the database layer.
    const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

    let agentVersionIds: Set<string> | undefined;
    if (args.agentId !== undefined) {
      const agentId = args.agentId as Id<"agents">;
      const agent = await ctx.db.get(agentId);
      if (!agent || agent.orgId !== apiKey.orgId) {
        throw new Error("Agent not found in this organization");
      }
      const versions = await ctx.db
        .query("agent_versions")
        .withIndex("by_agent", (q) => q.eq("agentId", agentId))
        .collect();
      agentVersionIds = new Set(versions.map((version) => String(version._id)));
    }

    // SERVER clock, read once so every entry in one response is aged against
    // the same instant — and, now that a request can span several batches,
    // so a pattern near the end of the scan is not graded against a later
    // instant than one near the start.
    const now = Date.now();

    // Every filter EXCEPT `state`. Split out because `unevaluated` below is
    // defined over the candidates that survive these — a pattern excluded by
    // `muted` or `agentId` is not "ungradable", it is simply not being asked
    // about.
    function matchesNonStateFilters(pattern: Doc<"failure_patterns">): boolean {
      // Tenancy safety net. The index above is already org-scoped; this makes
      // a cross-org row impossible to deliver even if that ever changes.
      if (pattern.orgId !== apiKey.orgId) return false;
      if (
        agentVersionIds !== undefined &&
        !pattern.affectedAgentVersionIds.some((versionId) => agentVersionIds.has(String(versionId)))
      ) {
        return false;
      }
      if (args.spiking === true && pattern.lastSpikeAssessment?.isSpiking !== true) return false;
      if (args.muted !== undefined && isPatternMuted(pattern) !== args.muted) return false;
      if (args.status !== undefined && patternStatus(pattern) !== args.status) return false;
      if (args.regressed === true && pattern.regressedAt === undefined) return false;
      return true;
    }

    function matchesStateFilter(pattern: Doc<"failure_patterns">): boolean {
      if (args.state === undefined) return true;
      const snapshot = isFixConfidenceSnapshotUsable(pattern) ? pattern.lastFixConfidence : undefined;
      // `regressed` additionally keeps its exact, snapshot-independent path,
      // so this filter is never weaker than it was before snapshots existed
      // and never depends on the cron having run. The two can only ever
      // agree — `recurred` short-circuits the engine before exposure is
      // consulted — so OR-ing them cannot manufacture a false positive; it
      // only refuses to lose a true one.
      if (args.state === "regressed" && recurredSinceResolution(pattern, now)) return true;
      return snapshot?.state === args.state;
    }

    const { underlyingCursor, skip } = decodePatternScanCursor(args.cursor);
    // Matches this request must reach before the page is complete: the ones
    // already delivered out of this window, plus a full page of new ones.
    const needed = skip + limit;

    // Is any filter that runs IN MEMORY actually active? `spiking: false` and
    // `regressed: false` are documented no-ops (they mean "do not narrow"), so
    // they do not count — treating them as active would make every default
    // `afr patterns` call pay for the wide window it does not need.
    const filtering =
      agentVersionIds !== undefined ||
      args.spiking === true ||
      args.muted !== undefined ||
      args.status !== undefined ||
      args.regressed === true ||
      args.state !== undefined;

    // Unfiltered: rows ARE matches, so reading `needed` of them is exact and
    // this endpoint costs precisely what it did before. Filtered: read the
    // bounded window, because the whole defect being fixed is that `numItems`
    // counted rows the filters were about to throw away.
    const scanSize = filtering ? PATTERN_SCAN_ROW_CEILING : needed;

    const matches: Doc<"failure_patterns">[] = [];
    // Candidates that HAVE something to grade but no usable snapshot to grade
    // it with. Collected BEFORE the state filter is consulted, so the caller
    // learns about them even though they cannot match — "we could not
    // evaluate these three" is a materially different answer from "these
    // three are not confirmed", and collapsing the two is precisely the
    // silent lie cycle 2 refused to ship. Scoped to the rows this request
    // actually examined (deduped, in encounter order): now that the scan
    // window is wider than the page, that is the honest bound on what this
    // response can speak for.
    const unevaluatedSeen = new Set<string>();
    const unevaluatedAll: string[] = [];

    // THE one permitted `.paginate()` for this execution. See the header
    // above for why this is a single wide read and not a loop.
    const scanWindow = await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_lastSeenAt", (q) => q.eq("orgId", apiKey.orgId))
      .order("desc")
      .paginate({ numItems: scanSize, cursor: underlyingCursor });

    for (const pattern of scanWindow.page) {
      if (!matchesNonStateFilters(pattern)) continue;
      if (
        pattern.resolvedAt !== undefined &&
        !isFixConfidenceSnapshotUsable(pattern) &&
        !unevaluatedSeen.has(pattern.fingerprintHash)
      ) {
        unevaluatedSeen.add(pattern.fingerprintHash);
        unevaluatedAll.push(pattern.fingerprintHash);
      }
      if (matchesStateFilter(pattern)) matches.push(pattern);
    }

    const scannedRows = scanWindow.page.length;
    const exhausted = scanWindow.isDone;
    // Truncated means: the window ran out before the page filled AND before
    // the table did. Exhaustion is checked FIRST — "there is nothing left" is
    // a stronger answer than "I stopped early", and a scan that reaches the
    // end of the table must never be reported as truncated. A window that
    // filled the page is not truncated either: the caller has a full page and
    // a cursor, which is an ordinary complete answer.
    const scanTruncated = !exhausted && matches.length < needed;

    const windowed = matches.slice(skip, skip + limit);

    let nextCursor: string | undefined;
    if (matches.length > needed) {
      // Surplus matches remain INSIDE this window, so resume by re-reading the
      // same window and skipping further into it. Advancing to
      // `continueCursor` instead would drop them — that is the bug runs.ts's
      // VerifyCursor comment records having actually shipped once, and it is
      // why a raw Convex cursor cannot express this endpoint's position.
      //
      // The re-read is the price of Convex's one-paginate-per-execution rule.
      // It is bounded by the ceiling on every request, and it only happens
      // when a window is match-dense — precisely the case where the caller is
      // getting full pages back.
      nextCursor = encodePatternScanCursor({ underlyingCursor, skip: needed });
    } else if (!exhausted) {
      // Every match found has been delivered, but the table is not finished —
      // the window either filled the page exactly or hit the ceiling. Resume
      // at this window's continuation: nothing re-seen, nothing skipped.
      nextCursor = encodePatternScanCursor({ underlyingCursor: scanWindow.continueCursor, skip: 0 });
    }

    // Bounded to one page's worth, matching the bound this list had when the
    // scan window WAS the page, with the overflow declared rather than
    // trimmed in silence.
    const unevaluated = unevaluatedAll.slice(0, limit);

    return {
      // Projected LAST — after every filter and after `unevaluated` / the
      // `fixConfidence` entries below were computed from the complete
      // documents. Those close over `windowed`, the pre-projection array,
      // which is why the projection is inlined here rather than reassigned.
      patterns: projectDocs(windowed, selection),
      nextCursor,
      /**
       * True when the scan stopped on PATTERN_SCAN_ROW_CEILING rather than on
       * the end of the table. The page may be short or empty purely because
       * of that ceiling, so a caller MUST NOT read an empty page as "nothing
       * matched" while this is true — follow `nextCursor` instead. False
       * means the returned page is the complete answer up to `limit`: an
       * empty page really does mean nothing matched, anywhere. Same contract
       * as `exposure.runCountTruncated`.
       */
      scanTruncated,
      /** Rows examined to produce this page, and the ceiling that bounds it. */
      scannedRows,
      scanRowCeiling: PATTERN_SCAN_ROW_CEILING,
      // Honesty envelope (ADR-006 cycle 3). Always present, filtered or not,
      // so a client can render a staleness marker next to a verdict without
      // having to ask for it — and so the bound itself is transported rather
      // than hardcoded on three separate surfaces.
      fixConfidence: {
        stalenessBoundMs: FIX_CONFIDENCE_SNAPSHOT_STALE_AFTER_MS,
        /** One entry per RETURNED pattern, in the same order. */
        entries: windowed.map((pattern) => confidenceEntryFor(pattern, now)),
        /** How many returned entries are served from a snapshot older than the bound. */
        staleCount: windowed.filter((pattern) => {
          const snapshot = isFixConfidenceSnapshotUsable(pattern) ? pattern.lastFixConfidence : undefined;
          return snapshot !== undefined && isFixConfidenceSnapshotStale(snapshot, now);
        }).length,
        /**
         * Fingerprints EXAMINED FOR THIS PAGE that have a live resolution but
         * no usable snapshot, and so could not be graded at all. Never
         * silently dropped — a caller filtering by `state` must be able to
         * tell "not matching" from "not evaluated". Scoped to the rows this
         * request scanned (which, with the bounded overfetch above, is a
         * superset of the returned page — by construction, since an
         * ungradable pattern is exactly one that cannot match a `state`
         * filter).
         */
        unevaluated,
        /**
         * True when more ungradable fingerprints were found than the list
         * above carries. The list is capped at `limit` so one request cannot
         * return an unbounded array of hashes; the flag is what keeps that cap
         * from being another silent truncation.
         */
        unevaluatedTruncated: unevaluatedAll.length > unevaluated.length,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Key-authed (read scope) counterpart to convex/failure_patterns.ts's
// `getPatternResolutionEvidence` (ADR-006 cycle 2, "prove the fix held").
// Powers `afr patterns evidence <fingerprint>` and the SDK reader's
// `getFailurePatternEvidence`.
//
// A MIRROR, not a call: `getPatternResolutionEvidence` is a Clerk-authed
// `query` gated on `requireOrgMembership`, which this surface has no JWT to
// satisfy (see this file's header). The two exposure helpers it uses are
// module-private there, so they are re-expressed below against the same
// tables, the same indexes, and — crucially — the SAME EXPORTED BOUNDS, so
// the two doors cannot report different numbers for the same pattern.
//
// STRICTLY READ-ONLY, exactly like every other function in this file. It
// reports the lifecycle and its evidence; it never sets any of it. ADR-006's
// acknowledge/resolve/reopen remain member-gated, Clerk-authed and audited,
// and are deliberately absent from this key-authed surface — an API key has
// no human actor to attribute a privileged state change to, and
// `audit_log.actorClerkUserId` exists precisely to answer "which person did
// this". Reading proof that a fix held needs no human actor; asserting that
// it held does. That asymmetry is why this endpoint exists and a key-authed
// `resolve` does not.
// ---------------------------------------------------------------------------

export interface ApiPatternResolutionEvidence {
  pattern: Doc<"failure_patterns">;
  resolution: PatternResolutionMetadata | null;
  exposure: PatternResolutionExposure | null;
  /** Oldest-first, bounded to the MAX_PATTERN_LIFECYCLE_TRANSITIONS most recent. */
  transitions: PatternLifecycleTransition[];
  /**
   * Team B's graded verdict over the evidence above (convex/insights.ts §12).
   * Null exactly when `resolution` is null — with nothing asserted there is
   * nothing to grade, and a fabricated "unproven" would read as a judgment
   * about a fix rather than the absence of one.
   */
  confidence: FixConfidenceResult | null;
}

/**
 * `fields` (optional) projects the embedded `pattern` DOCUMENT only — see
 * §FIELD PROJECTION. `fingerprintHash` is always present. The derived
 * evidence (`resolution`, `exposure`, `transitions`, `confidence`) is not a
 * document and is never projected; it is also computed from the COMPLETE
 * pattern before projection, so a narrow selection cannot change a verdict.
 * Same valid-field set and same identity field as `apiListFailurePatterns` —
 * deliberately, so `failure_patterns` means one thing on this surface.
 */
export const apiGetFailurePatternEvidence = mutation({
  args: { apiKeyHash: v.string(), fingerprintHash: v.string(), fields: FIELDS_ARG },
  handler: async (ctx, args): Promise<ApiPatternResolutionEvidence | null> => {
    const apiKey = await resolveReadApiKey(ctx, args.apiKeyHash);
    // BEFORE the fingerprint lookup. This endpoint returns `null` (not a
    // throw) for an unknown-or-foreign fingerprint precisely so the two are
    // indistinguishable; validating `fields` after the lookup would undo that
    // by making "unknown field" reachable only for fingerprints that exist in
    // the caller's org.
    const selection = validateFieldSelection("failure_patterns", args.fields);

    const pattern = await ctx.db
      .query("failure_patterns")
      .withIndex("by_org_fingerprint", (q) =>
        q.eq("orgId", apiKey.orgId).eq("fingerprintHash", args.fingerprintHash),
      )
      .first();
    // Null (not a throw) collapses "never existed" and "belongs to another
    // org" into one indistinguishable answer, exactly as every other
    // fingerprint-scoped lookup in this codebase does — a caller who could
    // tell those apart would have an existence oracle for another org's data.
    if (!pattern) return null;

    // Lifecycle transitions come from the APPEND-ONLY audit log, not a mutable
    // history table. Read newest-first so the bound keeps the most RECENT
    // transitions, then reversed into the oldest-first order a timeline
    // renders in. Includes the regression guard's own automatic
    // `failure_pattern.regressed` rows (actor "system").
    const auditRows = await ctx.db
      .query("audit_log")
      .withIndex("by_org_target", (q) =>
        q.eq("orgId", apiKey.orgId).eq("targetType", "failure_pattern").eq("targetId", args.fingerprintHash),
      )
      .order("desc")
      .take(MAX_PATTERN_LIFECYCLE_TRANSITIONS);

    const transitions: PatternLifecycleTransition[] = auditRows
      .map((row) => ({
        action: row.action,
        actorClerkUserId: row.actorClerkUserId,
        timestamp: row.timestamp,
        metadata: row.metadata as unknown,
      }))
      .reverse();

    // No live resolution to evidence. Also the state after a MANUAL reopen
    // (which clears `resolvedAt`) — but NOT after the regression guard's
    // auto-reopen, which KEEPS `resolvedAt` precisely so the "your fix didn't
    // hold" evidence below stays computable. A pattern with status "open" and
    // a non-null exposure is therefore valid and expected, not a bug.
    if (pattern.resolvedAt === undefined) {
      return { pattern: projectDoc(pattern, selection), resolution: null, exposure: null, transitions, confidence: null };
    }

    const resolvedInVersion =
      pattern.resolvedInVersionId !== undefined ? await ctx.db.get(pattern.resolvedInVersionId) : null;

    const resolution: PatternResolutionMetadata = {
      resolvedAt: pattern.resolvedAt,
      resolvedByUserId: pattern.resolvedByUserId,
      resolutionNote: pattern.resolutionNote,
      resolutionRef: pattern.resolutionRef,
      resolvedInVersionId: pattern.resolvedInVersionId,
      // Defensive org re-check: resolvePattern validated this id at write
      // time, but a version could have been purged/replaced since, and a
      // cross-org string must never be rendered from here.
      resolvedInVersion:
        resolvedInVersion && resolvedInVersion.orgId === apiKey.orgId ? resolvedInVersion.version : undefined,
      resolvedAtOccurrenceCount: pattern.resolvedAtOccurrenceCount,
      resolvedAtRunCount: pattern.resolvedAtRunCount,
    };

    // THE CANONICAL COMPUTATION — literally the same function
    // `getPatternResolutionEvidence` and the snapshot writer call. This
    // endpoint no longer has an opinion of its own about how a verdict is
    // derived, which is the only durable way for two doors onto the same
    // pattern to agree.
    const computation = await computePatternFixConfidence(ctx, pattern, Date.now());
    // Unreachable: null is returned only for an absent `resolvedAt`, which the
    // guard above already handled.
    if (!computation) {
      return { pattern: projectDoc(pattern, selection), resolution: null, exposure: null, transitions, confidence: null };
    }

    const exposure: PatternResolutionExposure = {
      since: pattern.resolvedAt,
      runCount: computation.exposure.count,
      runCountTruncated: computation.exposure.truncated,
      recurrenceCount: computation.recurrenceCount,
      baselineRunCount: pattern.resolvedAtRunCount,
      agentIds: computation.agentIds,
      // "Held SO FAR" — zero recurrences since resolution. NOT a claim the fix
      // is correct: `runCount` is what says whether this is meaningful
      // evidence. `heldSoFar: true` with `runCount: 0` means simply untested,
      // which is why `confidence.state` reads "unproven" there and never
      // "confirmed".
      heldSoFar: computation.recurrenceCount === 0,
    };

    return { pattern: projectDoc(pattern, selection), resolution, exposure, transitions, confidence: computation.confidence };
  },
});
