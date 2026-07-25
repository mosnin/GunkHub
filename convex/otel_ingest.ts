// ===========================================================================
// OpenTelemetry span ingestion — the server-side write for ADR-007.
//
// Authentication here is API-key-hash only, exactly like convex/sdk_ingest.ts:
// the caller is an OTLP receiver route, not a browser with a Clerk JWT. Do NOT
// call getAuthContext or requireOrgMembership in this file.
//
// ===========================================================================
// WHY THIS IS NOT `sdkCreateEvents`
// ===========================================================================
// convex/helpers/otel_mapping.ts ruled that the OTel path must not write
// through `sdkCreateEvents`, and the three reasons are all structural:
//
//   1. IDEMPOTENCY KEY. ADR-0007 fixed `sdkCreateEvents`'s key as
//      `(runId, sequenceNumber)`. A redelivered SPAN is assigned a DIFFERENT
//      derived ordinal whenever other spans landed in between, so it does not
//      collide and is inserted a second time. Under an append-only log that is
//      permanent doubling. This path keys on `(runId, provenance.spanId)`.
//   2. NO PROVENANCE CHANNEL. `sdkCreateEvents` has no `provenance` argument
//      and could not acquire one without letting the SDK path claim
//      `source: "otel"`. A derived event written through it would be
//      indistinguishable from a first-party recording — the exact lie
//      packages/contracts/src/provenance.ts exists to prevent, made permanent
//      by Event Log Rule 1.
//   3. RUN_STARTED-FIRST. `sdkCreateEvents` requires the first event of a run
//      to be `run.started`. A CONTINUATION batch of a trace legitimately
//      begins with anything at all, and the mapper deliberately does not
//      re-emit `run.started` for one.
//
// ===========================================================================
// RULING 1 — TRACE -> RUN: ONE TRACE IS EXACTLY ONE RUN, KEYED (orgId, traceId)
// ===========================================================================
// OTel hands us a trace id; the product's unit of work is a Run. Something has
// to bridge them, and the choice is load-bearing because it is unrenameable
// afterwards (the events are append-only and carry the run id).
//
// The candidates, and why they lose:
//
//   * CALLER-SUPPLIED runId. An OTLP exporter has no channel to learn one. It
//     would also make the run id caller-controlled, which is a cross-org write
//     oracle (see RULING 3).
//   * gen_ai.conversation.id, or a session attribute. Optional, absent from
//     most instrumentation, and semantically a GROUP of invocations — it would
//     merge unrelated runs into one, which is worse than splitting one.
//   * ONE RUN PER BATCH. Trivially safe, and useless: a trace's spans arrive
//     across many batches by design, so the artifact the UI renders would be
//     an arbitrary fragment of an execution.
//   * TRACE ID. A W3C trace is, by definition, one end-to-end invocation. It
//     is present on every span, required, and globally unique. The mapper has
//     already ruled (PART 5) that the trace's root span is the run boundary's
//     analogue, so the trace is the run's analogue by construction.
//
// The key is `(orgId, traceId)`, NOT `traceId`. Trace ids are client-generated
// and an attacker can pick one; scoping by org is what stops org B naming org
// A's trace. See RULING 3.
//
// The run is materialized lazily on the first batch of a trace, together with
// its AgentVersion when the caller names one. The Agent itself is NOT
// synthesized — see RULING 5.
//
// ===========================================================================
// RULING 2 — WHAT SERIALIZES CONCURRENT BATCHES OF THE SAME TRACE
// ===========================================================================
// STATED PRECISELY, because "Convex mutations are transactional" is not by
// itself an argument.
//
// Convex mutations are serializable transactions under OPTIMISTIC concurrency
// control. Each transaction records its READ SET, and a query issued through
// `withIndex` records the INDEX RANGE it scanned — not merely the documents it
// returned. At commit, if any other transaction has written into a range this
// one read, this one is rolled back and RE-EXECUTED from scratch against the
// new state. There are no locks to take and none are taken here.
//
// Three races matter, and each is closed by a range read that is deliberately
// placed BEFORE the corresponding write:
//
//   RACE A — two first batches of the same trace, both creating a run.
//     Both read the range `runs.by_org_trace (orgId, traceId)`, and both find
//     it empty. Whichever commits first inserts a run INTO THAT EXACT RANGE.
//     The second's read set is therefore invalidated; it re-executes, now
//     finds the run, and appends to it. Outcome: exactly one run per trace,
//     with no uniqueness constraint (Convex has none) and no lock.
//
//   RACE B — two batches allocating sequence numbers on the same run.
//     Both read `events.by_run (runId, ...)` descending to find the run's
//     current maximum. Whichever commits first inserts into that range. The
//     second re-executes and reads the NEW maximum. Outcome: sequence numbers
//     are contiguous with no gaps and no repeats, because no two committed
//     transactions can both have read the same maximum. This is also why the
//     max-sequence read is a real index query and not a cached number: caching
//     it across the mutation boundary is what would break the guarantee.
//
//   RACE C — two batches carrying the SAME span, e.g. an exporter retry
//     overlapping its own original. Both probe `events.by_run_span
//     (runId, provenance.spanId)`. The first commits an event into that range;
//     the second's probe range has been written into, so it re-executes, now
//     finds the span, and the mapper rejects it as `already-known`. Outcome:
//     zero duplicate events, even for a retry that races rather than follows.
//
// The one thing OCC does NOT give us is progress under unbounded contention —
// a hot trace can retry. That is bounded here by MAX_OTEL_SPANS_PER_BATCH and
// by the per-key rate limit, and it degrades into latency, never into
// corruption.
//
// ===========================================================================
// RULING 3 — CROSS-ORG INDISTINGUISHABILITY IS STRUCTURAL, NOT A CHECK
// ===========================================================================
// This repo has closed 25 existence oracles (see convex/tenancy_oracle.test.ts
// for the property: a foreign id must be indistinguishable from a missing one,
// EQUAL OUTCOMES, not merely both-throw). This path opens none, and the reason
// is that it never performs a lookup that COULD leak.
//
//   * The trace lookup is `by_org_trace` with `orgId` fixed to the API key's
//     own org as the FIRST index component. A lookup for org B physically
//     cannot range over org A's runs. Org A's trace id is not "denied" to org
//     B — it is absent, and B goes on to create its OWN run carrying the same
//     trace id string. The two runs are unrelated rows in different orgs.
//     There is no error, no timing difference, and no observable at all, which
//     is strictly stronger than collapsing two error messages into one.
//   * No `runId` is ever accepted from the caller, so there is no run-id
//     probe surface here at all.
//   * The only caller-supplied document id is `agentId`, and its
//     malformed / missing / foreign cases are collapsed into ONE outcome
//     ("Agent not found"), matching convex/sdk_ingest.ts sdkCreateRun.
//     Malformed is folded in deliberately: `normalizeId` returning null for a
//     syntactically invalid id, versus a get returning null for a valid-but-
//     absent one, is itself a (weak) oracle for id shape.
//
// ===========================================================================
// RULING 4 — REJECT, NEVER TRUNCATE; AND IDEMPOTENCY IS CHECKED FIRST
// ===========================================================================
// Every ceiling in this file rejects the WHOLE batch with a typed error. An
// OTLP exporter that receives a success response DROPS the batch; a partial
// acceptance therefore produces a permanently incomplete run that nothing in
// the system knows is incomplete, which is materially worse than a failed
// export the exporter will retry.
//
// Because Convex mutations are transactional, a throw anywhere in this handler
// commits nothing — the rejection really is all-or-nothing, not a best effort.
//
// ORDERING MATTERS: span-level dedupe runs BEFORE the run-status check, so a
// batch that is entirely a redelivery is a clean no-op EVEN IF the run has
// since terminated. Checking status first would turn every post-terminal
// exporter retry into an error, and the exporter would retry it forever. This
// mirrors the "idempotency FIRST" ordering in sdkCreateEvents.
//
// ===========================================================================
// RULING 5 — WHAT THIS PATH REFUSES TO INVENT
// ===========================================================================
//   * THE AGENT. `agentId` is a required argument, resolved against the key's
//     org. Deriving one from `gen_ai.agent.name` would spray a new Agent row
//     per distinct agent string into the org's namespace, keyed on a
//     Development-stability attribute that most instrumentation omits. The
//     transport layer knows which agent an exporter is configured for; the
//     span does not.
//   * THE AGENT VERSION, when the caller does not name one. `agentVersion` is
//     optional and, when absent, the run simply has none (the field is
//     optional in the schema). Synthesizing "unknown" would create an
//     immutable AgentVersion that means nothing and would pollute
//     convex/insights.ts compareVersions with a bucket that mixes every
//     un-versioned trace together.
//   * A TERMINAL EVENT for a trace whose root never arrives. That is the
//     mapper's ruling (PART 5) and this path does not second-guess it: the run
//     stays `running`, which Event Log Rule 5 already defines as in-progress.
// ===========================================================================

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { mutation } from "./_generated/server.js";
import { afrError } from "./helpers/errors.js";
import {
  mapTraceToEvents,
  type DerivedEventWrite,
  type MapResult,
  type OtelSpanInput,
  type OtelSpanKind,
} from "./helpers/otel_mapping.js";
import {
  MAX_EVENTS_PER_RUN,
  MAX_OTEL_SPANS_PER_BATCH,
  OTEL_TRACE_SETTLE_MS,
  STALE_RUN_TIMEOUT_MS,
} from "./helpers/pagination.js";
import {
  addModelSeen,
  buildSearchText,
  extractErrorMessage,
  extractModel,
  extractTokenUsage,
  tallyDerivedOrdering,
} from "./helpers/run_fields.js";
import { enforceRateLimit, resolveApiKey } from "./sdk_ingest.js";
import { incrementUsageCounters } from "./usage.js";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

/**
 * Scope required. DELIBERATELY the same `ingest:write` the SDK path requires,
 * not a new `otel:write`.
 *
 * A new scope would be silently denied to every key already provisioned — and
 * an OTLP exporter has no channel through which an operator would ever see the
 * 403. The trust being granted is also identical: a key that may append events
 * to this org's runs is being asked to append more events to this org's runs.
 * The DERIVED-vs-RECORDED distinction is carried by provenance on every row,
 * which is where it belongs, not by a scope that only gates the door.
 */
const INGEST_WRITE = "ingest:write";

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

/**
 * Event types this path may write. This is the mapper's `DerivedEventType`
 * set — the 17-literal `VALID_EVENT_TYPES` in convex/sdk_ingest.ts plus
 * `otel.span.unmapped`, and minus the types the mapper cannot produce.
 *
 * MAINTAINED SEPARATELY FROM sdk_ingest.ts ON PURPOSE. ADR-007 C4 observed
 * that contracts gained an 18th type (`otel.span.unmapped`) that
 * `sdkCreateEvents` still rejects. The resolution taken here is NOT to widen
 * the SDK's set: `otel.span.unmapped` asserts "we could not interpret somebody
 * else's span", which is a claim only this path is ever entitled to make.
 * Letting the first-party SDK write it would make the type meaningless.
 */
const DERIVED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.started",
  "run.completed",
  "run.failed",
  "llm.request",
  "llm.response",
  "llm.error",
  "tool.call",
  "tool.result",
  "tool.error",
  "memory.read",
  "memory.write",
  "retrieval.query",
  "retrieval.result",
  "custom",
  "otel.span.unmapped",
]);

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(["run.completed", "run.failed"]);

/** Event Log Rule 3, enforced identically to convex/sdk_ingest.ts. */
const MAX_INLINE_PAYLOAD_BYTES = 10 * 1024;

/**
 * Bound on the map -> exclude-offenders -> re-map loop.
 *
 * Each pass strictly grows the exclusion set, so the loop terminates on its
 * own; this caps the WORK, not the correctness. Three is generous: the mapper's
 * own attribute budget means an oversized derived payload is already rare, and
 * a batch needing more than three rounds of exclusion is better refused than
 * ground through.
 */
const MAX_MAPPING_PASSES = 3;

/** See convex/sdk_ingest.ts for why these are referenced by name. */
const _runEvalsThenEvaluateAlertsRef = makeFunctionReference<"action">(
  "alert_engine:runEvalsThenEvaluateAlerts",
);
const _generateRunExplanationRef = makeFunctionReference<"action">(
  "run_explanations:generateRunExplanation",
);
/** ADR-007 trace settle — see convex/otel_settle.ts for the whole argument. */
const _settleOtelTraceRef = makeFunctionReference<"mutation">("otel_settle:settleOtelTrace");

// ---------------------------------------------------------------------------
// Argument validator
//
// A JSON-SAFE mirror of the mapper's `OtelSpanInput`. Two deliberate
// differences from that interface:
//
//  - Timestamps are `string | number`, never `bigint`. `bigint` does not
//    survive the Convex wire (and is not JSON), so the decimal-string form
//    OTLP/JSON already uses for uint64 is the lossless one. A `number` is
//    accepted for ergonomics and the mapper flags it `timing-approximated`,
//    because float64 cannot hold an epoch-nanosecond value exactly.
//  - `attributes` is `v.any()`. This is the SECOND `v.any()` in the codebase
//    after `events.payload`, and it is justified for the same reason and no
//    other: OTel attribute values are scalars OR homogeneous arrays of
//    scalars OR (for the Opt-In content attributes) arbitrary nested JSON,
//    which the validator DSL cannot express as a union. It is an ARGUMENT
//    validator, not a stored column — everything derived from it is bounded
//    and shape-checked by the mapper before it reaches a table.
// ---------------------------------------------------------------------------
const spanValidator = v.object({
  traceId: v.string(),
  spanId: v.string(),
  parentSpanId: v.optional(v.string()),
  name: v.string(),
  kind: v.optional(
    v.union(
      v.literal("unspecified"),
      v.literal("internal"),
      v.literal("server"),
      v.literal("client"),
      v.literal("producer"),
      v.literal("consumer"),
    ),
  ),
  startTimeUnixNano: v.union(v.string(), v.number()),
  endTimeUnixNano: v.optional(v.union(v.string(), v.number())),
  attributes: v.optional(v.any()),
  status: v.optional(
    v.object({
      code: v.union(
        v.number(),
        v.literal("unset"),
        v.literal("ok"),
        v.literal("error"),
      ),
      message: v.optional(v.string()),
    }),
  ),
  scopeName: v.optional(v.string()),
  schemaUrl: v.optional(v.string()),
  spanEventCount: v.optional(v.number()),
  spanLinkCount: v.optional(v.number()),
});

// ---------------------------------------------------------------------------
// Local mirrors of contract-side invariants
//
// convex/ cannot import @agent-flight-recorder/contracts (see
// convex/package.json — its only dependency is `convex`), so the checks that
// live there are mirrored here. This is not redundancy: contracts enforces at
// COMPILE time for TypeScript callers, and this enforces at the RUNTIME
// boundary of an append-only table, where a bad row can never be corrected.
// ---------------------------------------------------------------------------

/**
 * Runtime mirror of contracts `isProvenanceConsistent`, restricted to the OTel
 * arm (this path cannot produce the `sdk` arm — see the module header).
 *
 * The mapper reports malformed W3C ids as a NON-FATAL diagnostic and states
 * explicitly that "the ingest boundary must reject their provenance via
 * isProvenanceConsistent". This is that boundary.
 */
function provenanceProblem(p: DerivedEventWrite["provenance"]): string | undefined {
  if (p.source !== "otel") return "provenance.source must be \"otel\" on the derived path";
  if (!TRACE_ID_RE.test(p.traceId)) return `traceId ${JSON.stringify(p.traceId)} is not 32 lowercase hex chars`;
  if (!SPAN_ID_RE.test(p.spanId)) return `spanId ${JSON.stringify(p.spanId)} is not 16 lowercase hex chars`;
  if (p.parentSpanId !== undefined && !SPAN_ID_RE.test(p.parentSpanId)) {
    return `parentSpanId ${JSON.stringify(p.parentSpanId)} is not 16 lowercase hex chars`;
  }
  if (!Number.isFinite(p.receivedAt) || p.receivedAt <= 0) return "receivedAt must be a positive finite epoch-ms value";
  if (p.lossy && (p.lossReasons === undefined || p.lossReasons.length === 0)) {
    return "lossy provenance must name at least one lossReason";
  }
  if (!p.lossy && p.lossReasons !== undefined && p.lossReasons.length > 0) {
    return "non-lossy provenance must not carry lossReasons";
  }
  return undefined;
}

/**
 * UTF-8 byte cost of a payload, NEVER throwing.
 *
 * `JSON.stringify` recurses in the engine, so a deeply nested caller-controlled
 * value throws `RangeError: Maximum call stack size exceeded` — not a typed
 * error, not catchable by anything upstream, an untyped 500 that loses the
 * whole batch. The mapper now depth-bounds every payload field, so this should
 * be unreachable; treating an unmeasurable payload as OVER the limit is the
 * backstop, and it routes into the ordinary per-span exclusion path instead of
 * a crash. Reporting the span as `payload-too-large` is also honest: a payload
 * we cannot measure is one we cannot certify as storable.
 */
function payloadBytes(payload: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload ?? null)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Normalize the wire span into the mapper's input shape.
 *
 * The only transformation is dropping `attributes` that are not a plain
 * object. The mapper indexes `attributes` by key and a non-object would make
 * every read return undefined silently; refusing it here means a hostile
 * `attributes: "sentinel"` becomes a visible rejection rather than a span that
 * quietly maps to nothing.
 */
function toSpanInput(raw: Record<string, unknown>): OtelSpanInput {
  const attributes =
    typeof raw["attributes"] === "object" &&
    raw["attributes"] !== null &&
    !Array.isArray(raw["attributes"])
      ? (raw["attributes"] as Record<string, unknown>)
      : undefined;

  const span: OtelSpanInput = {
    traceId: raw["traceId"] as string,
    spanId: raw["spanId"] as string,
    name: raw["name"] as string,
    startTimeUnixNano: raw["startTimeUnixNano"] as string | number,
  };
  if (typeof raw["parentSpanId"] === "string" && raw["parentSpanId"] !== "") {
    span.parentSpanId = raw["parentSpanId"];
  }
  if (raw["kind"] !== undefined) span.kind = raw["kind"] as OtelSpanKind;
  if (raw["endTimeUnixNano"] !== undefined) {
    span.endTimeUnixNano = raw["endTimeUnixNano"] as string | number;
  }
  if (attributes !== undefined) span.attributes = attributes;
  if (raw["status"] !== undefined) span.status = raw["status"] as OtelSpanInput["status"];
  if (typeof raw["scopeName"] === "string") span.scopeName = raw["scopeName"];
  if (typeof raw["schemaUrl"] === "string") span.schemaUrl = raw["schemaUrl"];
  if (typeof raw["spanEventCount"] === "number") span.spanEventCount = raw["spanEventCount"];
  if (typeof raw["spanLinkCount"] === "number") span.spanLinkCount = raw["spanLinkCount"];
  return span;
}

/**
 * Get-or-create the immutable AgentVersion for `(agentId, version)`.
 *
 * The range read on `by_agent_version` is what makes this safe under
 * concurrent first batches of the same trace — RACE A in the module header,
 * applied to versions rather than runs. Two transactions both reading the
 * empty `(agentId, version)` range cannot both commit an insert into it.
 *
 * An EXISTING version is returned untouched. AgentVersions are immutable
 * (CLAUDE.md Core Entities); this never patches one.
 */
async function resolveAgentVersion(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  version: string,
): Promise<Id<"agent_versions">> {
  const existing = await ctx.db
    .query("agent_versions")
    .withIndex("by_agent_version", (q) => q.eq("agentId", agent._id).eq("version", version))
    .first();
  if (existing !== null) return existing._id;

  return await ctx.db.insert("agent_versions", {
    agentId: agent._id,
    orgId: agent.orgId,
    version,
    // The changelog records HOW this version came to exist, because unlike an
    // SDK-declared version nobody chose to create it — it was materialized as
    // a side effect of a trace naming it.
    changelog: "Materialized by OpenTelemetry span ingestion (ADR-007).",
    createdAt: Date.now(),
  });
}

export interface OtelIngestResult {
  runId: string;
  runCreated: boolean;
  eventIds: string[];
  unmappedCount: number;
  rejected: Array<{ spanId: string; reason: string }>;
  diagnostics: Array<{ code: string; fatal: boolean; spanIds: string[]; message: string }>;
  runOpen: boolean;
  terminalType: string | null;
  firstSequenceNumber: number | null;
  lastSequenceNumber: number | null;
  stats: MapResult["stats"];
}

/**
 * Ingest one decoded OTLP batch for ONE trace.
 *
 * `traceId` is an explicit argument rather than being inferred from the spans.
 * The mapper CAN infer one (majority wins, lexicographic tiebreak) and still
 * does as a second line of defence, but inference is the wrong primitive at
 * this boundary: the trace id is the RUN KEY, and a key that depends on which
 * spans happened to be in the batch would let one malformed batch attach a
 * trace's spans to a brand-new run. Spans naming a different trace are
 * rejected here, before the mapper sees them, and reported.
 */
export const otelIngestSpans = mutation({
  args: {
    apiKeyHash: v.string(),
    traceId: v.string(),
    agentId: v.string(),
    agentVersion: v.optional(v.string()),
    spans: v.array(spanValidator),
  },
  handler: async (ctx, args): Promise<OtelIngestResult> => {
    // --- Shape gates BEFORE authentication is spent -------------------------
    // Cheap, caller-supplied-shape checks only. Nothing here reads a table, so
    // nothing here can be an oracle for anything.
    if (!TRACE_ID_RE.test(args.traceId)) {
      throw afrError(
        "INVALID_ARGUMENT",
        "traceId must be 32 lowercase hex characters (W3C trace id)",
      );
    }
    if (args.spans.length === 0) {
      throw afrError("INVALID_ARGUMENT", "spans must not be empty");
    }
    // RULING 4: reject, never truncate.
    if (args.spans.length > MAX_OTEL_SPANS_PER_BATCH) {
      throw afrError(
        "BATCH_TOO_LARGE",
        `OTLP batch carries ${args.spans.length} spans, exceeding the maximum of ${MAX_OTEL_SPANS_PER_BATCH}. ` +
          `The batch was REJECTED IN FULL and nothing was recorded — resend it in smaller batches. ` +
          `It was not truncated: a truncated batch would be reported as recorded and the dropped spans would be lost silently.`,
      );
    }

    const apiKey = await resolveApiKey(ctx, args.apiKeyHash, INGEST_WRITE);
    // Charged in SPANS, the unit the caller actually controls, and charged
    // even for a pure redelivery — a retry storm is precisely what this limit
    // exists to bound. The whole mutation is transactional, so a rejection
    // here commits nothing.
    await enforceRateLimit(ctx, apiKey, args.spans.length);

    // --- Agent resolution (RULING 3: one collapsed outcome) -----------------
    const agentId = ctx.db.normalizeId("agents", args.agentId);
    const agent = agentId === null ? null : await ctx.db.get(agentId);
    if (!agent || agent.orgId !== apiKey.orgId) {
      throw new Error("Agent not found");
    }

    // --- Trace partition ----------------------------------------------------
    // A single OTLP export legitimately carries many traces; only this one's
    // spans may enter this run or consume its sequence numbers.
    const rejected: Array<{ spanId: string; reason: string }> = [];
    const ownTrace: OtelSpanInput[] = [];
    for (const raw of args.spans) {
      if (raw.traceId !== args.traceId) {
        rejected.push({ spanId: raw.spanId, reason: "foreign-trace" });
        continue;
      }
      // MALFORMED W3C IDS ARE REJECTED PER SPAN, NOT PER BATCH.
      //
      // These used to reach the mapper (which reports them as a NON-fatal
      // diagnostic and explicitly delegates the refusal here) and then fail the
      // provenance check during validation — which refused the WHOLE batch. So
      // one hand-rolled span with a blank id destroyed every innocent span
      // travelling with it, and `rejected` had no member that could say why.
      // OTLP has partial success for exactly this reason.
      if (
        !SPAN_ID_RE.test(raw.spanId) ||
        (raw.parentSpanId !== undefined &&
          raw.parentSpanId !== "" &&
          !SPAN_ID_RE.test(raw.parentSpanId))
      ) {
        rejected.push({ spanId: raw.spanId, reason: "malformed-id" });
        continue;
      }
      ownTrace.push(toSpanInput(raw as unknown as Record<string, unknown>));
    }
    if (ownTrace.length === 0) {
      // Nothing usable for this trace. Creating a run here would materialize an
      // empty run for every misrouted or malformed batch — visible, permanent,
      // and meaningless.
      throw afrError(
        "INVALID_ARGUMENT",
        `None of the ${args.spans.length} spans in this batch are usable for trace ${args.traceId} ` +
          `(${rejected.filter((r) => r.reason === "foreign-trace").length} foreign-trace, ` +
          `${rejected.filter((r) => r.reason === "malformed-id").length} malformed-id)`,
      );
    }

    // --- RULING 2 / RACE A: trace -> run, via the org-scoped index range ----
    const existingRun = await ctx.db
      .query("runs")
      .withIndex("by_org_trace", (q) =>
        q.eq("orgId", apiKey.orgId).eq("otelTraceId", args.traceId),
      )
      // .unique() rather than .first(): two runs for one (orgId, traceId) is
      // an invariant violation that OCC is supposed to make impossible, and it
      // must fail loudly rather than have one of them silently win forever.
      .unique();

    let run = existingRun;
    let runCreated = false;

    if (run === null) {
      // --- First batch of this trace: materialize the run -------------------
      let earliestStartMs = Number.POSITIVE_INFINITY;
      for (const span of ownTrace) {
        const ms = Number(BigInt(normalizeNanos(span.startTimeUnixNano)) / 1_000_000n);
        if (Number.isFinite(ms) && ms < earliestStartMs) earliestStartMs = ms;
      }
      const now = Date.now();
      if (!Number.isFinite(earliestStartMs) || earliestStartMs <= 0) earliestStartMs = now;

      // ADR-007 C3 / mapper F4, handled rather than papered over.
      //
      // convex/stale_runs.ts sweeps runs still `running` whose `startedAt` is
      // older than STALE_RUN_TIMEOUT_MS and patches them to `timed_out`
      // WITHOUT a terminal event, after which nothing further can ever be
      // appended. `startedAt` here is the earliest SPAN start — the truth
      // about when the agent ran, which is what every runs-by-time surface
      // needs — so a backfill of a week-old trace would create a run the very
      // next sweep kills, silently losing the rest of the trace.
      //
      // So it is refused AT THE DOOR, with a code the caller can see, rather
      // than accepted into a run that is already doomed. Lifting this
      // restriction is a change to the SWEEP's anchor (it should measure from
      // when the row was created, not from when the work it describes
      // happened) and belongs with that file, not here.
      if (now - earliestStartMs > STALE_RUN_TIMEOUT_MS) {
        throw afrError(
          "OTEL_TRACE_TOO_OLD",
          `Trace ${args.traceId} begins ${Math.floor((now - earliestStartMs) / 3_600_000)}h in the past, ` +
            `beyond the ${STALE_RUN_TIMEOUT_MS / 3_600_000}h stale-run ceiling. A run created for it would be ` +
            `expired by the stale sweep before the trace could finish arriving, so the batch is rejected instead.`,
        );
      }

      const agentVersionId =
        args.agentVersion !== undefined && args.agentVersion !== ""
          ? await resolveAgentVersion(ctx, agent, args.agentVersion)
          : undefined;

      const runId = await ctx.db.insert("runs", {
        orgId: apiKey.orgId,
        projectId: agent.projectId,
        agentId: agent._id,
        agentVersionId,
        status: "running",
        startedAt: earliestStartMs,
        metadata: {},
        tags: [],
        // Recorded so a reader can tell at a glance that this run was not
        // reported by an instrumented process using our SDK. Per-event
        // provenance remains the authoritative, non-forgeable statement.
        triggeredBy: "otel",
        environment: apiKey.environment,
        otelTraceId: args.traceId,
        searchText: buildSearchText([agent.name, "otel", args.traceId]),
      });
      const created = await ctx.db.get(runId);
      if (created === null) throw new Error("Failed to create run for trace");
      run = created;
      runCreated = true;
    }

    const runId = run._id;

    // --- RULING 2 / RACE C: span-level idempotency, BEFORE any status gate --
    // One index probe per span. `knownSpanIds` is handed to the mapper, which
    // rejects those spans as `already-known` rather than re-emitting them.
    const knownSpanIds: string[] = [];
    const inBatch = new Set(ownTrace.map((s) => s.spanId));
    for (const span of ownTrace) {
      const hit = await ctx.db
        .query("events")
        .withIndex("by_run_span", (q) =>
          q.eq("runId", runId).eq("provenance.spanId", span.spanId),
        )
        .first();
      if (hit !== null) knownSpanIds.push(span.spanId);
    }

    // --- PARENT ANCHORS: make the causality clamp reach across batches ------
    // The mapper's clamp is batch-local — it can only clamp a child against a
    // parent in the same batch. Parent r(50-100ms) with child a(10-60ms)
    // delivered together clamps a to 50ms; delivered as {a} alone, 10ms stands.
    // That is a real mapped operation whose timeline position would otherwise
    // be decided by exporter flush timing.
    //
    // For every parent named by a span in this batch but ABSENT from it, look
    // up whether we already recorded it and hand the mapper its effective
    // start. Bounded by the batch size, on the same index the dedupe probe
    // uses. This closes the parent-first delivery order; the child-first order
    // is not closable (the parent is unknowable when the child is written, and
    // there is no update mutation) and is MARKED instead.
    const parentAnchors: Record<string, { instantUnixNano: string; inferred: boolean }> = {};
    const wantedParents = new Set<string>();
    for (const span of ownTrace) {
      const parent = span.parentSpanId;
      if (parent === undefined || parent === "" || parent === span.spanId) continue;
      if (inBatch.has(parent)) continue;
      wantedParents.add(parent);
    }
    for (const parent of wantedParents) {
      const hit = await ctx.db
        .query("events")
        .withIndex("by_run_span", (q) =>
          q.eq("runId", runId).eq("provenance.spanId", parent),
        )
        .first();
      const instant = hit?.temporalOrder?.instantUnixNano;
      if (instant === undefined) continue;
      // Carry whether the anchor's OWN instant was inferred. A parent recorded
      // in an earlier batch may itself have been unverified at write time, and
      // clamping against it would otherwise produce a child that looks verified
      // while resting on a value that can still move.
      const reasons =
        hit?.provenance?.source === "otel" ? hit.provenance.lossReasons ?? [] : [];
      parentAnchors[parent] = {
        instantUnixNano: instant,
        inferred: reasons.includes("timing-approximated"),
      };
    }

    // --- RULING 2 / RACE B: sequence allocation from the run's real maximum -
    // Read through the index, every time, inside this transaction. This read
    // is what makes contiguity hold under concurrency (see RACE B); a value
    // cached anywhere outside the transaction would silently break it.
    const latest = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .order("desc")
      .first();
    const lastSequenceNumber = latest?.sequenceNumber ?? 0;
    const hasTerminalEvent = latest !== null && TERMINAL_EVENT_TYPES.has(latest.type);
    // Computed here, where `run` is known non-null, because the mapping closure
    // below cannot re-narrow it.
    const runIsClosed = hasTerminalEvent || run.status !== "running";

    // --- MAPPING, WITH PER-SPAN EXCLUSION OF UNSTORABLE SPANS --------------
    //
    // A span whose DERIVED payload exceeds the 10 KB inline limit used to
    // refuse the entire batch. That punishes every innocent span travelling
    // with it, and an OTLP exporter's only recourse is to retry the identical
    // batch forever. OTLP defines partial success precisely so one bad span
    // does not cost the batch.
    //
    // So: map, find the offenders, EXCLUDE THEM BY SPAN ID, and map again.
    // Re-mapping rather than deleting events from the result is what keeps
    // sequence numbers contiguous — dropping events from a numbered list
    // leaves gaps, and a gap in an append-only log is unfixable.
    //
    // Bounded to MAX_MAPPING_PASSES: each pass strictly grows the exclusion
    // set, so it terminates, and the bound stops a pathological batch from
    // spending the transaction on re-mapping.
    const excluded = new Set<string>();
    let result = runMapping(ownTrace, excluded);
    for (let pass = 1; pass < MAX_MAPPING_PASSES; pass += 1) {
      const offenders = oversizedSpanIds(result);
      if (offenders.length === 0) break;
      for (const spanId of offenders) excluded.add(spanId);
      result = runMapping(ownTrace, excluded);
    }
    for (const spanId of excluded) rejected.push({ spanId, reason: "payload-too-large" });

    function runMapping(spans: readonly OtelSpanInput[], skip: ReadonlySet<string>): MapResult {
      const kept = skip.size === 0 ? spans : spans.filter((s) => !skip.has(s.spanId));
      return mapTraceToEvents({
      spans: kept,
      receivedAt: Date.now(),
      lastSequenceNumber,
      knownSpanIds,
      // BROADER THAN "a terminal event exists", and deliberately so. A run
      // moved to a terminal STATUS without one is equally closed —
      // convex/stale_runs.ts patches `timed_out` directly, appending nothing —
      // and it needs the same per-span accounting, not a different failure
      // mode. Passing only `hasTerminalEvent` here would have left an exact
      // twin of D6 reachable through the stale sweep.
      hasTerminal: runIsClosed,
      parentAnchors,
      // RULING 6 (see convex/otel_settle.ts for the counterexample that forced
      // it): terminality is NOT a per-batch decision. "Every span in the batch
      // is closed" is a fact about a batch and says nothing about a trace, and
      // deciding on it meant `{root}` then `{child}` closed the run on batch 1
      // and lost the child permanently, while `{root, child}` kept both. Every
      // batch here is a pure append; the terminal is added once, later, by the
      // settle mutation, after the trace has gone quiet.
      terminalPolicy: "defer",
      });
    }

    /** Span ids whose derived events cannot be stored inline (Event Log Rule 3). */
    function oversizedSpanIds(mapped: MapResult): string[] {
      const out = new Set<string>();
      for (const evt of mapped.events) {
        if (payloadBytes(evt.payload) > MAX_INLINE_PAYLOAD_BYTES) out.add(evt.provenance.spanId);
      }
      return [...out].sort();
    }
    for (const r of result.rejected) rejected.push({ spanId: r.spanId, reason: r.reason });

    // The mapper's own self-check (RULING 3 in otel_mapping.ts) failed: an
    // accepted span produced no event. Refusing is mandatory — the mapper's
    // contract says a caller MUST NOT ingest a `!ok` result.
    if (!result.ok) {
      const fatal = result.diagnostics.filter((d) => d.fatal);
      throw afrError(
        "OTEL_MAPPING_FAILED",
        `Span mapping returned a fatal diagnostic; nothing was recorded. ` +
          fatal.map((d) => `[${d.code}] ${d.message}`).join("; "),
      );
    }

    const diagnostics = result.diagnostics.map((d) => ({
      code: d.code as string,
      fatal: d.fatal,
      spanIds: d.spanIds,
      message: d.message,
    }));

    // --- RULING 4: idempotent redelivery is a NO-OP, not an error ----------
    // Reached when every span in the batch was already recorded. Returns
    // success WITHOUT consulting run status, so an exporter retrying after the
    // run terminated stops retrying instead of looping on RUN_NOT_ACTIVE.
    if (result.events.length === 0) {
      return {
        runId,
        runCreated,
        eventIds: [],
        unmappedCount: 0,
        rejected,
        diagnostics,
        runOpen: run.status === "running",
        terminalType: null,
        firstSequenceNumber: null,
        lastSequenceNumber: null,
        stats: result.stats,
      };
    }

    // --- Genuinely new events: now the run must be appendable ---------------
    // TRIPWIRE, not the primary guard. A closed run now yields zero events
    // above and returns through the per-span rejection path, so this should be
    // unreachable; if it ever fires, the suppression has regressed and a
    // whole-batch refusal is still better than appending after a terminal.
    if (run.status !== "running" || hasTerminalEvent) {
      throw afrError(
        "RUN_NOT_ACTIVE",
        `Cannot append derived events to run ${runId} for trace ${args.traceId}: ` +
          `run status is "${run.status}"${hasTerminalEvent ? " and a terminal event is already recorded" : ""}. ` +
          `${result.events.length} span-derived event(s) were REJECTED IN FULL.`,
      );
    }

    // --- Validation pass over the WHOLE batch, before any insert ------------
    // Convex would roll back a mid-loop throw anyway; validating up front
    // means the error a caller sees does not depend on how far the insert loop
    // happened to get, and that the same bad batch always reports the same
    // first problem.
    let expected = lastSequenceNumber;
    for (let i = 0; i < result.events.length; i += 1) {
      const evt = result.events[i] as DerivedEventWrite;
      expected += 1;

      if (!DERIVED_EVENT_TYPES.has(evt.type)) {
        throw afrError(
          "INVALID_ARGUMENT",
          `Derived event type "${evt.type}" is not writable on the OTel path`,
        );
      }
      if (!Number.isInteger(evt.sequenceNumber) || evt.sequenceNumber !== expected) {
        // Event Log Rule 4. The mapper guarantees this; asserting it here is
        // what makes a mapper regression a rejected batch instead of a
        // permanently gapped run.
        throw afrError(
          "SEQUENCE_CONFLICT",
          `Derived sequenceNumber ${evt.sequenceNumber} is not contiguous for run ${runId}: expected ${expected}`,
        );
      }
      if (evt.sequenceNumber > MAX_EVENTS_PER_RUN) {
        throw afrError(
          "EVENT_LIMIT_EXCEEDED",
          `Run ${runId} has reached the maximum of ${MAX_EVENTS_PER_RUN} events`,
        );
      }
      const problem = provenanceProblem(evt.provenance);
      if (problem !== undefined) {
        throw afrError(
          "INVALID_ARGUMENT",
          `Refusing to write an event with inconsistent provenance (span ${evt.provenance.spanId}): ${problem}`,
        );
      }
      if (evt.provenance.traceId !== args.traceId) {
        throw afrError(
          "INVALID_ARGUMENT",
          `Derived event provenance names trace ${evt.provenance.traceId}, not ${args.traceId}`,
        );
      }
      const bytes = payloadBytes(evt.payload);
      if (bytes > MAX_INLINE_PAYLOAD_BYTES) {
        // Event Log Rule 3, and a TRIPWIRE rather than the primary guard: the
        // exclusion loop above should already have removed this span. Reaching
        // here means the loop's bound was exhausted, so the batch is refused —
        // storing it would violate Rule 3, and truncating it would store a
        // falsified record of what the model was actually sent.
        throw afrError(
          "PAYLOAD_TOO_LARGE",
          `Derived payload for span ${evt.provenance.spanId} is ${bytes} bytes, over the ` +
            `${MAX_INLINE_PAYLOAD_BYTES}-byte inline limit, and could not be excluded within ` +
            `${MAX_MAPPING_PASSES} mapping passes. Externalize the span's content attributes to blob ` +
            `storage before ingest; this path cannot truncate it without falsifying the record.`,
        );
      }
      if (evt.parentEventIndex !== undefined && evt.parentEventIndex >= i) {
        throw afrError(
          "INVALID_ARGUMENT",
          `parentEventIndex ${evt.parentEventIndex} does not precede its child at index ${i}`,
        );
      }
    }

    // --- Append -------------------------------------------------------------
    const eventIds: Id<"events">[] = [];
    let unmappedCount = 0;
    let insertedBytes = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let modelsSeen = run.modelsSeen;
    let terminal: DerivedEventWrite | undefined;

    for (const evt of result.events) {
      const parentEventId =
        evt.parentEventIndex !== undefined ? eventIds[evt.parentEventIndex] : undefined;

      const eventId = await ctx.db.insert("events", {
        runId,
        orgId: run.orgId,
        type: evt.type,
        sequenceNumber: evt.sequenceNumber,
        timestamp: evt.timestamp,
        payload: evt.payload,
        parentEventId,
        // Structurally impossible to omit: `DerivedEventWrite.provenance` is
        // required and typed as OTel provenance specifically, so this path
        // cannot write an event that looks first-party.
        provenance: evt.provenance,
        // THE TEMPORAL TRUTH. Persisting this is not optional decoration: on
        // this path `sequenceNumber` is the order we LEARNED about the event,
        // and this key is the only carrier of the order it HAPPENED. Because
        // the log is append-only, an event written without it can never be
        // temporally ordered by anything, ever — there is no backfill that is
        // not a rewrite of history. A replay or diff over a derived run sorts
        // by this (contracts `orderEventsForProjection`), never by
        // `sequenceNumber`.
        temporalOrder: evt.temporalOrder,
      });
      eventIds.push(eventId);
      if (evt.type === "otel.span.unmapped") unmappedCount += 1;
      insertedBytes += payloadBytes(evt.payload);

      // ADR-002 denormalized counters, mirroring convex/sdk_ingest.ts so a
      // derived run is not second-class on the analytics surfaces. Accumulated
      // in memory and flushed once after the loop rather than re-reading the
      // run per event.
      if (evt.type === "llm.response") {
        const usage = extractTokenUsage(evt.payload);
        tokensIn += usage.tokensIn;
        tokensOut += usage.tokensOut;
      }
      if (evt.type === "llm.request" || evt.type === "llm.response") {
        const model = extractModel(evt.payload);
        if (model !== undefined) modelsSeen = addModelSeen(modelsSeen, model) ?? modelsSeen;
      }
      // Under `terminalPolicy: "defer"` the mapper emits none of these. The
      // check stays as a tripwire: if one ever appears, the deferral has
      // regressed and the convergence argument no longer holds.
      if (TERMINAL_EVENT_TYPES.has(evt.type)) terminal = evt;
    }

    // --- Reconcile the run document ----------------------------------------
    const patch: Record<string, unknown> = {};
    if (tokensIn > 0 || tokensOut > 0) {
      patch["tokensIn"] = (run.tokensIn ?? 0) + tokensIn;
      patch["tokensOut"] = (run.tokensOut ?? 0) + tokensOut;
    }
    if (modelsSeen !== run.modelsSeen) patch["modelsSeen"] = modelsSeen;

    if (terminal !== undefined) {
      patch["status"] = terminal.type === "run.failed" ? "failed" : "completed";
      patch["endedAt"] = terminal.timestamp;
      if (terminal.type === "run.failed") {
        const errorMessage = extractErrorMessage(terminal.payload);
        if (errorMessage) {
          patch["searchText"] = buildSearchText([run.searchText, errorMessage]);
        }
      }
    }
    // --- RULING 6: observe the closed true root, and arm the settle ---------
    // `otelLastAppendAt` is bumped on EVERY append, which is what makes the
    // settle window mean "quiet for N" rather than "N since the root closed" —
    // a trace still streaming spans keeps pushing its own deadline out.
    patch["otelLastAppendAt"] = Date.now();

    // ADR-007 O(1) ordering verdict. Add-only sums over the events this batch
    // actually appended, so they are a function of the event SET and converge
    // under any partition; a redelivery appends nothing and therefore adds
    // nothing. Taken through the SHARED tally, not a second hand-rolled loop.
    {
      const tally = tallyDerivedOrdering(result.events);
      if (tally.derived > 0) {
        patch["derivedEventCount"] = (run.derivedEventCount ?? 0) + tally.derived;
      }
      if (tally.unkeyed > 0) {
        patch["otelUnkeyedDerivedCount"] = (run.otelUnkeyedDerivedCount ?? 0) + tally.unkeyed;
      }
    }

    // Running max of every appended event's temporal instant. The settle
    // terminal is placed at (or after) this, so it cannot sort before an event
    // it terminates. Maintained here rather than derived at settle time
    // because deriving it from the LAST-APPENDED event is wrong — the event SET
    // is partition-independent, but which event was appended last is not — and
    // scanning the run's events is not affordable at the 50k ceiling.
    {
      let maxInstant =
        run.otelMaxInstantNano === undefined ? 0n : BigInt(run.otelMaxInstantNano);
      for (const evt of result.events) {
        const instant = BigInt(evt.temporalOrder.instantUnixNano);
        if (instant > maxInstant) maxInstant = instant;
      }
      if (run.otelMaxInstantNano === undefined || maxInstant > BigInt(run.otelMaxInstantNano)) {
        patch["otelMaxInstantNano"] = maxInstant.toString();
      }
    }

    // A TRUE root has no parent reference at all. A span whose parent is named
    // but absent from this batch is an ORPHAN — its parent probably exists and
    // simply has not arrived — and an orphan is never a run boundary. Recorded
    // only the FIRST time one is seen closed; the root is immutable in the
    // trace, so re-recording it could only ever overwrite truth with a later
    // duplicate export.
    //
    // SELECTION IS A FUNCTION OF THE TRACE, NOT OF THE BATCH. This used to take
    // the first true root in the batch's array order and keep it forever, so a
    // trace with TWO true roots — one OK, one ERROR — settled to
    // `run.completed` or `run.failed` depending purely on which batch the
    // exporter flushed first. The run's OUTCOME, decided by arrival order.
    //
    // The key is (effective start, span id): total, deterministic, and
    // independent of arrival. A strictly-better root arriving in a later batch
    // REPLACES the recorded one, which is what makes the choice converge. That
    // is not a mutation of the log — `otelRoot` is ingest state, and no terminal
    // event has been appended yet (the settle fires only after the trace goes
    // quiet, and once it has, `run.status !== "running"` closes the door).
    {
      let best = run.otelRoot === undefined
        ? undefined
        : { startNs: BigInt(run.otelRootStartNano ?? run.otelRoot.endUnixNano), root: run.otelRoot };
      for (const span of ownTrace) {
        const isTrueRoot =
          span.parentSpanId === undefined ||
          span.parentSpanId === "" ||
          span.parentSpanId === span.spanId;
        if (!isTrueRoot) continue;
        const endNs = span.endTimeUnixNano === undefined
          ? 0n
          : BigInt(normalizeNanos(span.endTimeUnixNano));
        // Zero/absent end is UNSET on the wire, not an instant at the epoch —
        // the root has not closed and the trace's outcome is still unknown.
        if (endNs <= 0n) continue;
        const startNs = BigInt(normalizeNanos(span.startTimeUnixNano));
        const better =
          best === undefined ||
          startNs < best.startNs ||
          (startNs === best.startNs && span.spanId < best.root.spanId);
        if (!better) continue;
        best = {
          startNs,
          root: {
            spanId: span.spanId,
            spanName: span.name,
            status: normalizeSpanStatus(span.status?.code),
            endUnixNano: endNs.toString(),
          },
        };
      }
      if (best !== undefined && best.root.spanId !== run.otelRoot?.spanId) {
        patch["otelRoot"] = best.root;
        patch["otelRootStartNano"] = best.startNs.toString();
      }
    }

    if (Object.keys(patch).length > 0) await ctx.db.patch(runId, patch);

    // Arm the settle the first time a closed root is observed. Only once: the
    // settle mutation reschedules ITSELF while spans keep arriving, so
    // re-arming on every batch would only pile up redundant no-ops.
    if (run.otelRoot === undefined && patch["otelRoot"] !== undefined) {
      await ctx.scheduler.runAfter(OTEL_TRACE_SETTLE_MS, _settleOtelTraceRef, { runId });
    }

    if (terminal !== undefined) {
      // Same downstream wiring as the SDK terminal path (convex/sdk_ingest.ts)
      // — evals + alerts, and explanations for the failure path only. A
      // derived run gets the same treatment as a recorded one; the provenance
      // on its events is what tells those engines what kind of evidence they
      // are reading.
      await ctx.scheduler.runAfter(0, _runEvalsThenEvaluateAlertsRef, { runId });
      if (terminal.type === "run.failed") {
        await ctx.scheduler.runAfter(0, _generateRunExplanationRef, { runId });
      }
    }

    await incrementUsageCounters(ctx, run.orgId, {
      eventsIngested: eventIds.length,
      bytesIngested: insertedBytes,
    });

    const first = result.events[0] as DerivedEventWrite;
    const last = result.events[result.events.length - 1] as DerivedEventWrite;

    return {
      runId,
      runCreated,
      eventIds,
      unmappedCount,
      rejected,
      diagnostics,
      runOpen: terminal === undefined,
      terminalType: result.terminalType,
      firstSequenceNumber: first.sequenceNumber,
      lastSequenceNumber: last.sequenceNumber,
      stats: result.stats,
    };
  },
});

/**
 * Coerce a wire timestamp to a decimal nanosecond string for BigInt().
 *
 * Anything unparseable becomes "0", which the caller treats as "no usable
 * start" and falls back to the ingest clock. It is never allowed to become
 * `NaN` — `BigInt(NaN)` throws and would fail the whole batch on one bad span
 * before the mapper ever got the chance to report it.
 */
/** OTLP status code (0 unset / 1 ok / 2 error) or its lowercased name. */
function normalizeSpanStatus(
  code: number | "unset" | "ok" | "error" | undefined,
): "unset" | "ok" | "error" {
  if (code === undefined) return "unset";
  if (typeof code === "number") return code === 2 ? "error" : code === 1 ? "ok" : "unset";
  return code;
}

function normalizeNanos(value: string | number | bigint): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^\d+$/.test(value) ? value : "0";
  if (!Number.isFinite(value) || value < 0) return "0";
  return Math.trunc(value).toString();
}
