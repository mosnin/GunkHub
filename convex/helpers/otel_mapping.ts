// ---------------------------------------------------------------------------
// OpenTelemetry GenAI span → Agent Flight Recorder event mapping.
//
// PURE. Deterministic. No `ctx`, no `ctx.db`, no I/O, no `Date.now()`, no
// randomness, no recursion. A function from spans to events, in the same
// posture as the engines in
// convex/helpers/{analytics,evals,pricing,failure_summary}.ts: same input,
// same output, every time, testable with a plain array.
//
// Server wall clock is NOT read here. `receivedAt` is an INPUT (see
// MapOptions.receivedAt). It is the one genuinely wall-clock-dependent field
// of `OtelEventProvenance`, and taking it as a parameter is what lets this
// module stay pure while still emitting a complete provenance record.
//
// ===========================================================================
// PART 1 — THE SPEC THIS IMPLEMENTS, AND ITS STABILITY
// ===========================================================================
//
// Researched 2026-07-25 against the primary sources, not from memory. Two
// facts dominate everything below and both are load-bearing:
//
// (A) THE GenAI CONVENTIONS NO LONGER LIVE IN THE MAIN SEMCONV REPO. As of
//     `open-telemetry/semantic-conventions` **v1.42.0 (2026-06-12)**, every
//     `gen_ai.*` attribute, metric, event and span was moved out to
//     `open-telemetry/semantic-conventions-genai`. The main repo's registry
//     now renders every `gen_ai.*` row as "Deprecated / Moved" — that is a
//     RELOCATION TOMBSTONE, NOT A DEPRECATION. Anyone reading
//     `opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/` today
//     will see "Deprecated" on attributes that are perfectly current. Do not
//     let that misreading into a design doc.
//
// (B) THERE IS NO RELEASED VERSION OF THE GenAI CONVENTIONS TO PIN TO. The
//     new repo has ZERO releases, its CHANGELOG contains only an empty
//     `## Unreleased` stub, and its README's "Schema URL" section reads,
//     literally, `TODO`. So there is no GenAI schema URL and no GenAI version
//     number. The last VERSIONED artifact containing `gen_ai.*` is main-repo
//     **v1.41.1 (2026-05-11)**, and that content is now stale.
//
// STABILITY — the part that decides whether this module is safe to build:
//
//   * EVERY `gen_ai.*` attribute is **Development** (experimental). Not one is
//     Stable. Every `gen_ai.*` span group is Development. Every enum member of
//     every `gen_ai.*` value set is Development.
//   * The ONLY Stable attributes appearing on GenAI spans are BORROWED from
//     the core registry: `error.type`, `server.address`, `server.port`. This
//     module reads exactly one of them — `error.type`.
//   * So the "read the stable parts, label the experimental parts" split this
//     module was meant to make DOES NOT EXIST inside `gen_ai.*`. The correct
//     labelling is blunt: **everything below except `error.type` is
//     experimental and can be renamed without a major-version signal.**
//     `OtelEventProvenance.mapperVersion` and `.semconvVersion` are what make
//     that survivable under an append-only log — see PART 2.
//
// RENAMES ALREADY SURVIVED, both read here in both spellings:
//   * `gen_ai.system` → `gen_ai.provider.name` (main repo **v1.37.0**).
//     `gen_ai.system` is genuinely deprecated. Value-set trap: the old set
//     spelled xAI `xai`; the new one spells it `x_ai`.
//   * `gen_ai.usage.prompt_tokens`/`completion_tokens` →
//     `gen_ai.usage.input_tokens`/`output_tokens` (main repo **v1.28.0**).
//   Reading only the new names would blind us to every currently-deployed
//   instrumentation; reading only the old ones would blind us to every new
//   one. Both are read, new wins.
//
// CONTENT (prompts/completions) — this went the OPPOSITE way from the usual
// telling, so it is stated explicitly:
//   * `gen_ai.prompt` / `gen_ai.completion`: Deprecated, "removed, no
//     replacement at this time."
//   * The per-message log events (`gen_ai.system.message`, `.user.message`,
//     `.assistant.message`, `.tool.message`, `gen_ai.choice`) were ALL
//     deprecated in v1.37.0 and are gone.
//   * They were replaced by three structured attributes —
//     `gen_ai.input.messages`, `gen_ai.output.messages`,
//     `gen_ai.system_instructions` — type `any`, **Opt-In**, Development,
//     which may appear EITHER on the GenAI span OR on the single surviving
//     event `gen_ai.client.inference.operation.details`. So content came BACK
//     onto spans as an option. This module therefore DOES read them when
//     present, and records `attributes-dropped` when they are absent (the
//     default, since capture is opt-in and off by default).
//   * The spec explicitly blesses the pattern "store content externally and
//     record references on the spans" for production volume — which is
//     exactly CLAUDE.md Event Log Rule 3's artifact/blob model. But it ends
//     with a literal `TODO: document a common approach to record references to
//     externally stored content`, so **there is no standard attribute name for
//     the blob pointer yet.** Nothing here can map one until there is.
//
// ---------------------------------------------------------------------------
// THE MAPPING TABLE
// ---------------------------------------------------------------------------
// Classification is by `gen_ai.operation.name` (authoritative), then the
// conventional span name prefix, then attribute shape. `gen_ai.operation.name`
// has SEVENTEEN well-known values; all seventeen are accounted for below.
//
//  operation.name        | span name                        | SpanKind        | open event     | close event
//  ----------------------+----------------------------------+-----------------+----------------+--------------------------
//  chat                  | "chat {request.model}"           | CLIENT (MAY INT)| llm.request    | llm.response / llm.error
//  text_completion       | "text_completion {model}"        | CLIENT          | llm.request    | llm.response / llm.error
//  generate_content      | "generate_content {model}"       | CLIENT          | llm.request    | llm.response / llm.error
//  embeddings            | "embeddings {model}"             | CLIENT          | llm.request    | llm.response / llm.error
//  execute_tool          | "execute_tool {tool.name}"       | INTERNAL        | tool.call      | tool.result / tool.error
//  retrieval             | "retrieval {data_source.id}"     | CLIENT          | retrieval.query| retrieval.result
//  search_memory         | "search_memory"                  | CLIENT (MAY INT)| memory.read    | (none)
//  create_memory         | "create_memory"                  | CLIENT          | memory.write   | (none)
//  update_memory         | "update_memory"                  | CLIENT          | memory.write   | (none)
//  upsert_memory         | "upsert_memory"                  | CLIENT          | memory.write   | (none)
//  delete_memory         | "delete_memory"                  | CLIENT          | memory.write   | (none)
//  create_memory_store   | "create_memory_store"            | CLIENT          | memory.write   | (none)
//  delete_memory_store   | "delete_memory_store"            | CLIENT          | memory.write   | (none)
//  invoke_agent          | "invoke_agent {agent.name}"      | CLIENT *and* INT| custom         | custom
//  create_agent          | "create_agent {agent.name}"      | CLIENT          | custom         | custom
//  invoke_workflow       | "invoke_workflow {workflow.name}"| INTERNAL        | custom         | custom
//  plan                  | "plan {agent.name}"              | INTERNAL        | custom         | custom
//  (anything else)       | —                                | any             | otel.span.unmapped (ONE event)
//
// Notes on the deliberate approximations, each of which sets a loss reason:
//   * `embeddings` has no AFR event type of its own; it is recorded as an
//     llm.request/llm.response pair because it IS a model inference with a
//     model name and token usage. Flagged `status-approximated`.
//   * `memory.*` in AFR is a SINGLE event with no close and no error slot.
//     A memory span therefore emits one event at its start instant — and if
//     the span ERRORED, it emits `custom` carrying the error instead, because
//     silently dropping the error message to fit `MemoryWritePayload` is the
//     exact failure this module exists to prevent.
//   * `retrieval.result` has no error member either; same rule.
//   * agent/workflow/plan operations have no AFR type at all. `custom`
//     records them verbatim rather than inventing a type or dropping them.
//   * `invoke_agent` is defined as TWO span groups (`.client` for hosted/
//     remote agents, `.internal` for in-process frameworks). SpanKind is
//     therefore NOT usable as a classifier and is only ever recorded, never
//     branched on.
//
// Attribute → payload field:
//   llm.request.model        ← gen_ai.request.model
//   llm.request.temperature  ← gen_ai.request.temperature
//   llm.request.max_tokens   ← gen_ai.request.max_tokens
//   llm.request.messages     ← gen_ai.input.messages (Opt-In; usually absent)
//   llm.response.model       ← gen_ai.response.model ?? gen_ai.request.model
//   llm.response.content     ← gen_ai.output.messages (Opt-In) ?? gen_ai.response.id
//   llm.response.usage.*     ← gen_ai.usage.{input,output}_tokens
//                              ?? gen_ai.usage.{prompt,completion}_tokens
//   llm.response.finish_reason ← gen_ai.response.finish_reasons[0]
//   tool.call.name           ← gen_ai.tool.name
//   tool.call.call_id        ← gen_ai.tool.call.id, ELSE synthesized from spanId
//   tool.call.input          ← gen_ai.tool.call.arguments (Opt-In)
//   tool.result.output       ← gen_ai.tool.call.result (Opt-In)
//   *.error.code             ← error.type  (the one Stable attribute read here)
//   *.error.message          ← span status.message
//
// KNOWN-BUT-UNMAPPED attributes, listed so their absence is a decision and not
// an oversight: `gen_ai.usage.cache_creation.input_tokens`,
// `gen_ai.usage.cache_read.input_tokens`,
// `gen_ai.usage.reasoning.output_tokens` (all SUBSETS of input/output tokens,
// not addends — adding them would double-count), `gen_ai.request.top_p/top_k/
// seed/stop_sequences/frequency_penalty/presence_penalty/choice.count/stream/
// reasoning.level`, `gen_ai.prompt.name/version/variable.*`,
// `gen_ai.agent.version`, `gen_ai.conversation.compacted`,
// `gen_ai.response.time_to_first_chunk`, `gen_ai.data_source.id`,
// `gen_ai.tool.definitions`, `server.address`, `server.port`, and every
// non-GenAI attribute. Our payload shapes have no field for them. They are
// preserved for unmapped spans (in the payload's `attributes` bag) and
// reported as `attributes-dropped` everywhere else. There is no silent drop.
//
// ===========================================================================
// PART 2 — RULING 1: PROVENANCE IS MANDATORY
// ===========================================================================
// Every event this module emits carries an `OtelEventProvenance` with
// `source: "otel"`. There is no code path that can emit one without it:
// `DerivedEventWrite.provenance` is required, non-optional, and typed as OTel
// provenance SPECIFICALLY (mirroring `OtelDerivedEventWrite` in
// packages/contracts/src/api.ts), so a derived event with no provenance — or
// one claiming `source: "sdk"` — does not typecheck.
//
// MECHANISM CHOSEN: a field ON THE EVENT RECORD. Not a side table, not a
// naming convention, not a wrapper object.
//   * A SIDE TABLE is mutable and deletable. Lose the row and the derived
//     event silently re-launders itself into a first-party-looking one — the
//     precise lie this is built to prevent, made permanent by Rule 1.
//   * A WRAPPER around the event would not survive the storage boundary; the
//     `events` table stores rows, not wrappers.
//   * A NAMING CONVENTION (e.g. an `otel.` type prefix) cannot carry the
//     trace/span identity, the semconv version, or the loss accounting, and
//     silently degrades to nothing for the types that ARE shared with the SDK
//     path (`llm.request` is `llm.request` either way).
// Provenance has to be exactly as immutable as the event it qualifies, which
// means it has to be part of it.
//
// The two version fields are not redundant. `semconvVersion` says which
// rulebook we read the span under; `mapperVersion` says which reading of that
// rulebook we applied. A convention can be stable while our implementation is
// buggy, and under an append-only log `mapperVersion` is the ONLY thing that
// can later identify which stored events a discovered mapper bug contaminated.
//
// ===========================================================================
// PART 3 — RULING 2: ORDERING
// ===========================================================================
// Ordering runs over EMISSIONS. A span produces up to two: `open` at its start
// instant, `close` at its end instant (memory/unmapped spans produce one).
//
// THE KEY, in order:
//   1. effective instant, NANOSECOND precision (bigint), ascending
//   2. phase: `open` before `close`
//   3. tree depth: ASCENDING for opens, DESCENDING for closes
//   4. spanId, lexicographic ascending      ← the totality guarantee
//
// DEFENCE OF EACH CLAUSE:
//
// (1) NANOSECONDS, NOT MILLISECONDS, AND NOT `Number`. A 2026 epoch-nanosecond
//     value is ~1.75e18; float64 ULP there is 256ns, so `Number()` COLLAPSES
//     any two instants under ~128ns apart into the same value — manufacturing
//     ties out of genuinely ordered input. Our `timestamp` column is epoch-ms,
//     but rounding to ms happens only at materialization, never in the
//     comparator. Decimal-string comparison is equally wrong across differing
//     lengths ('999999999' > '1750000000000000000' because '9' > '1'), so
//     every comparison here goes through `BigInt`.
//
// (1b) EFFECTIVE, NOT RAW. Span timestamps come from the emitting process's
//     clock and OTel guarantees no synchronization. A skewed child that claims
//     to start before its parent would otherwise produce a `parentEventIndex`
//     pointing at a LATER sequence number: an effect preceding its cause, in a
//     log with no update mutation. So starts clamp top-down
//     (`effStart(s) = max(s.start, effStart(parent))`) and ends clamp
//     bottom-up (`effEnd(parent) = max(parent.end, max effEnd(children))`).
//     Every clamp is REPORTED — a `clock-skew-clamped` diagnostic plus a
//     `timing-approximated` loss reason on every event derived from that span.
//     Clamping FALSIFIES a recorded timestamp; doing it unflagged would be
//     indistinguishable from the data having been that way.
//
//     This clamp is also what makes `timestamp` NON-DECREASING along the
//     sequence, which `apps/web/src/lib/replay/projection.ts` needs: it
//     computes `elapsed_ms = event.timestamp - firstTimestamp`, so an event
//     later in sequence but earlier in time renders a NEGATIVE elapsed_ms.
//     Because the effective instant IS the primary sort key and `timestamp` is
//     a monotone function of it (floor to ms), monotonicity is structural
//     here, not incidental.
//
// (2) OPENS BEFORE CLOSES IS FORCED, NOT CHOSEN. A zero-duration child of a
//     parent starting at the same instant would otherwise have its close
//     ordered before its open.
//
// (3) DEPTH IS WHAT TURNS (1)+(2) INTO CORRECT BRACKETING. With the clamp,
//     `effStart(parent) <= effStart(child)` and `effEnd(child) <=
//     effEnd(parent)` always hold; when either is EQUAL, depth decides, and
//     depth-ascending-for-opens / descending-for-closes gives exactly
//     `parentOpen < childOpen` and `childClose < parentClose`. The run
//     boundary uses depth -1 so `run.started` sorts outside every open and the
//     terminal sorts outside every close even at a shared instant.
//
// (4) SPAN ID IS ARBITRARY BUT TOTAL AND STABLE. Ties on timestamp are not an
//     edge case — fan-out dispatched in one tick shares a start instant
//     exactly, and millisecond-granularity clocks pad with zeros so spans
//     genuinely microseconds apart arrive byte-identical. The tiebreak is
//     therefore load-bearing. A tiebreak on ARRAY INDEX looks deterministic in
//     a single-batch test and is not deterministic at all: it encodes the
//     exporter's flush order, which carries no information (a
//     BatchSpanProcessor flushes by completion, so children normally arrive
//     before parents). Span ids are unique within a trace by definition, so
//     lexicographic order is total and no two emissions can tie. It carries no
//     meaning; it is a STABLE FICTION, which is the most that is available
//     when the true order is unrecoverable. Duplicate span ids — the one input
//     that could defeat it — are detected and reported, never silently merged
//     (see `dedupeSpans`).
//
// Sequence numbers are then `priorLastSequenceNumber + emissionIndex + 1`:
// contiguous, non-repeating, exactly what Event Log Rule 4 and
// `sdkCreateEvents` demand.
//
// ---------------------------------------------------------------------------
// WHAT `sequenceNumber` MEANS ON THIS PATH — READ THIS BEFORE CONSUMING IT
// ---------------------------------------------------------------------------
// `sequenceNumber` is THE ORDER WE LEARNED ABOUT AN EVENT, not the order it
// happened. For SDK-recorded events those coincide, which is why nobody has
// had to say it. For OTel-derived events they do NOT, and pretending otherwise
// is the lie this product exists to prevent.
//
// Within a single batch the two DO coincide, because the whole batch is
// learned at once and this module canonicalises it. ACROSS batches they
// diverge, and they must: a span arriving in batch 2 that occurred before
// spans already appended in batch 1 cannot be inserted before them, because
// insertion requires renumbering and renumbering an append-only log is
// permanent corruption. So it is APPENDED, and the temporal truth is carried
// separately.
//
// That separate carrier is `DerivedEventWrite.temporalOrder`, and
// `compareTemporalOrder` is the comparator for it. **A replay or diff
// projection over a derived run MUST sort by `temporalOrder` (via
// `compareTemporalOrder`), not by `sequenceNumber`.** Sorting a
// multi-batch derived run by `sequenceNumber` renders a timeline in the order
// the collector happened to flush. `event.provenance.source === "otel"` is the
// signal that tells a consumer which ordering applies — which is the concrete
// reason provenance had to be mandatory rather than advisory.
//
// ===========================================================================
// PART 4 — RULING 3: LOSSY MAPPING IS EXPLICIT
// ===========================================================================
// Three independent mechanisms, because one is a promise and three is a
// system:
//
//   1. A span matching no rule becomes an `otel.span.unmapped` EVENT in the
//      log, in sequence order, next to its siblings — carrying its span name,
//      kind, status, duration and (bounded) attribute bag. Not a dropped span,
//      not a counter, not a row in a side table nobody opens. It appears in
//      replay, export and the timeline for free.
//   2. `MapResult.unmapped` mirrors every one of them for the caller, and
//      `MapResult.rejected` lists spans NOT recorded at all (foreign trace,
//      already known). Those two are kept strictly distinct: an unmapped span
//      WAS recorded, a rejected one was NOT, and conflating them is how a
//      dropped span passes for a recorded one.
//   3. `verifySpanConservation` — exported for tests AND run by the mapper on
//      its own output before returning. Every accepted span id must appear in
//      at least one emitted event's provenance. If one does not, the result
//      comes back `ok: false` with a `span-dropped` FATAL diagnostic. Losing a
//      span is therefore a self-detected failure, not something a reviewer has
//      to notice.
//
// ===========================================================================
// PART 5 — RULING 4: RUN_STARTED FIRST, TERMINAL LAST (Event Log Rule 5)
// ===========================================================================
// OTel has no run concept. The root span is the analogue. Precisely:
//
//   * TRUE ROOT = a span with no `parentSpanId`, or an empty one, or one equal
//     to its own span id. ORPHAN ROOT = a span whose `parentSpanId` names a
//     span not in this batch. The distinction matters: an orphan's parent
//     probably exists and simply is not here, so an orphan is a root for TREE
//     purposes but NEVER a run boundary.
//   * `run.started` is emitted at sequence 1 from the earliest true root's
//     effective start — unless prior state says the run already has events, in
//     which case it is NOT re-emitted (a continuation batch must not restart
//     the run).
//   * The terminal event is emitted ONLY when a true root exists AND EVERY
//     span in the batch is closed. `run.failed` iff a true root's status is
//     ERROR; otherwise `run.completed`. A DESCENDANT failure does not fail the
//     run — a retried tool error inside a successful agent run is not a failed
//     run, and only the root reports the invocation's own outcome.
//   * ROOT STILL OPEN, or any span still open → `run.started` but NO terminal.
//     Rule 5 already defines this state: "a run without a terminal event is
//     considered in-progress." Honest and compliant, no invention needed.
//     `endTimeUnixNano` of `0` means UNSET on the wire and is treated as open,
//     not as an instant at the epoch.
//   * ROOT ABSENT ENTIRELY (crashed exporter: children batched, root never
//     arrives) → `run.started` is still emitted, so Rule 5 holds structurally,
//     but it is anchored to the earliest span, reported as a `no-root-span`
//     diagnostic, and carries `identity-synthesized`. NO terminal event: the
//     outcome is genuinely unknown. The run stays in-progress until the 24h
//     stale sweep (`convex/stale_runs.ts`) flips it to `timed_out` — WITHOUT
//     appending a terminal event, after which nothing further can be appended.
//     This module therefore does not assume a trace can always be completed;
//     see the FINDINGS block at the bottom of this file.
//   * A true root that ALSO classifies as an inference or tool operation
//     emits its own open/close pair too, nested inside the boundary. Folding a
//     root `chat` span into `run.started` and calling it done would drop a
//     real LLM call.
//
// ===========================================================================
// PART 6 — SCOPE LIMITS, STATED SO NOBODY READS MORE INTO THIS THAN IT DOES
// ===========================================================================
//  * MULTI-BATCH STABILITY IS ONLY ACHIEVABLE WITH `prior`. Two requirements
//    that both look reasonable are jointly unsatisfiable by ANY pure function
//    of the span set alone:
//      DETERMINISM — the same span SET yields identical output under any
//        arrival order. Forces the order to be a function of the SET.
//      STABILITY — adding a span to a later ingest must not renumber the
//        spans already written. Forces every new span to sort AFTER the
//        existing ones, i.e. forces the order to depend on insertion history.
//    A function of the set cannot depend on insertion history. So a mapper
//    given `(spans)` with no `prior` CANNOT satisfy both, and this one chooses
//    DETERMINISM and requires `prior` for stability. That is not a gap in this
//    implementation; it is a property of the problem. See the FINDINGS block.
//  * This module maps SPANS ONLY. OTel log records and metrics are out of
//    scope. Non-GenAI semantic-convention groups (HTTP, DB, messaging) are
//    deliberately NOT force-fitted onto our event types — they become
//    `otel.span.unmapped`, which records them honestly.
//  * This is a mapping proposal, not a write. The caller — an org-scoped
//    Convex mutation — owns auth, `orgId` scoping, run resolution, span-keyed
//    dedupe against already-stored events, and the appends. A caller MUST
//    refuse to ingest a result whose `ok` is false.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mirrored contract types
//
// `convex/` does not depend on `@agent-flight-recorder/contracts` (see
// convex/package.json — its only dependency is `convex`), for the reason
// documented in convex/helpers/{failure_summary,evals,notifier,delivery}.ts.
// These declarations therefore MIRROR, structurally and exactly:
//
//   OtelEventProvenance, OtelMappingLossReason → contracts/src/provenance.ts
//   OtelSpanKind, OtelUnmappedReason, EventType → contracts/src/events.ts
//   OtelDerivedEventWrite  → contracts/src/api.ts (here: DerivedEventWrite)
//
// KEEP IN SYNC. `tests/unit/otel_mapping_contract.test.ts` asserts the mirror
// against the real contracts package, so drift is a test failure rather than a
// runtime surprise.
// ---------------------------------------------------------------------------

/** Mirror of contracts `OtelMappingLossReason`. */
export type OtelMappingLossReason =
  | "attributes-dropped"
  | "span-events-dropped"
  | "span-links-dropped"
  | "timing-approximated"
  | "usage-partial"
  | "payload-truncated"
  | "status-approximated"
  | "identity-synthesized";

/** Mirror of contracts `OtelEventProvenance`. */
export interface OtelEventProvenance {
  source: "otel";
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  spanName: string;
  scopeName?: string;
  semconvVersion: string;
  mapperVersion: string;
  lossy: boolean;
  lossReasons?: OtelMappingLossReason[];
  receivedAt: number;
}

/** Mirror of contracts `OtelSpanKind`. */
export type OtelSpanKind =
  | "unspecified"
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

/** Mirror of contracts `OtelUnmappedReason`. */
export type OtelUnmappedReason =
  | "no-matching-rule"
  | "unsupported-semconv-version"
  | "ambiguous-match"
  | "missing-required-attributes";

/** The subset of contracts `EventType` this mapper can produce. */
export type DerivedEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "llm.request"
  | "llm.response"
  | "llm.error"
  | "tool.call"
  | "tool.result"
  | "tool.error"
  | "memory.read"
  | "memory.write"
  | "retrieval.query"
  | "retrieval.result"
  | "custom"
  | "otel.span.unmapped";

/**
 * The temporal truth, carried separately from `sequenceNumber`.
 *
 * See the "WHAT `sequenceNumber` MEANS ON THIS PATH" block above. This is the
 * field a replay/diff projection must sort by for a derived run.
 *
 * Nanosecond values are DECIMAL STRINGS, not `bigint` and not `number`:
 * `bigint` is not storable in Convex or serializable to JSON, and `number`
 * cannot hold an epoch-nanosecond value without losing ~256ns of resolution.
 */
export interface TemporalOrderKey {
  /** Effective (skew-clamped) instant, epoch nanoseconds, decimal string. */
  instantUnixNano: string;
  /** RAW instant as the emitting process reported it. Differs from `instantUnixNano` iff a clamp was applied. */
  rawInstantUnixNano: string;
  phase: "open" | "close";
  /** Depth in the reconstructed span tree. -1 for the synthesized run boundary. */
  depth: number;
  spanId: string;
}

/** Loose mirror of the contracts payload union members this mapper produces. */
export type DerivedPayload =
  | { type: "run.started"; input: unknown; config: Record<string, unknown> }
  | { type: "run.completed"; output: unknown; duration_ms: number }
  | {
      type: "run.failed";
      error: { message: string; code?: string };
      duration_ms: number;
      errorSummary?: string;
    }
  | {
      type: "llm.request";
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      temperature?: number;
      max_tokens?: number;
    }
  | {
      type: "llm.response";
      model: string;
      content: unknown;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      finish_reason: string;
    }
  | { type: "llm.error"; error: { message: string; code?: string } }
  | { type: "tool.call"; name: string; input: unknown; call_id: string }
  | { type: "tool.result"; call_id: string; output: unknown; duration_ms: number }
  | { type: "tool.error"; error: { message: string; code?: string }; call_id?: string }
  | { type: "memory.read"; key?: string; result?: unknown }
  | { type: "memory.write"; key?: string; value?: unknown }
  | { type: "retrieval.query"; query: string; filters?: Record<string, unknown> }
  | { type: "retrieval.result"; results: unknown[]; duration_ms?: number }
  | { type: "custom"; data: unknown }
  | {
      type: "otel.span.unmapped";
      spanName: string;
      spanKind: OtelSpanKind;
      reason: OtelUnmappedReason;
      attributes: Record<string, unknown>;
      attributesTruncated: boolean;
      status?: { code: "unset" | "ok" | "error"; message?: string };
      durationMs?: number;
    };

/**
 * Mirror of contracts `OtelDerivedEventWrite`, with three deliberate
 * differences, each justified:
 *
 *  - NO `runId`. This module is pure and knows nothing about runs. The caller
 *    supplies it at write time.
 *  - `parentEventIndex` INSTEAD OF `parentEventId`. A Convex `Id<"events">`
 *    only exists after the insert, so a pure mapper cannot know one. The index
 *    is the honest pre-insert form of the same edge — it points into `events`
 *    of the SAME result — and a parent's index is always strictly less than
 *    its child's by construction, so the ingest mutation always already knows
 *    the id by the time it needs it.
 *  - `spanId` and `temporalOrder` ADDED. `spanId` duplicates
 *    `provenance.spanId` for correlation at the mapper boundary; STORAGE keeps
 *    exactly one copy, in `provenance`. `temporalOrder` is the separate
 *    carrier for trace order described above.
 */
export interface DerivedEventWrite {
  type: DerivedEventType;
  sequenceNumber: number;
  /** Epoch MILLISECONDS (our schema's unit), floored from the effective nanosecond instant. */
  timestamp: number;
  payload: DerivedPayload;
  /** Index into `MapResult.events`. Always strictly less than this event's own index. */
  parentEventIndex?: number;
  /** REQUIRED and OTel-specific: this path is structurally incapable of emitting a first-party-looking event. */
  provenance: OtelEventProvenance;
  /** Convenience mirror of `provenance.spanId`. Not stored separately. */
  spanId: string;
  /** The temporal truth. Authoritative for "when did this happen". */
  temporalOrder: TemporalOrderKey;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Version of THIS mapping code, stamped onto every derived event.
 *
 * Bump on ANY change to the mapping table, the ordering key, or the loss
 * accounting. Because the log is append-only, this string is the only thing
 * that can later identify which stored events a discovered mapper bug
 * contaminated. It is not decoration.
 */
export const MAPPER_VERSION = "otel-genai-mapper/1.0.0";

/**
 * The convention revision this mapper implements, stamped onto every
 * provenance.
 *
 * There is NO released GenAI convention version to name (see PART 1(B)): the
 * dedicated repo has zero releases and its schema URL is literally `TODO`. So
 * this string names BOTH anchors honestly — the last main-repo release that
 * still carried `gen_ai.*` (1.41.1) and the unreleased dedicated-repo tip this
 * mapping was read from, with the date it was read. A version string that
 * claimed "1.38.0" or "1.43.0" would be asserting a pin that does not exist.
 */
export const SEMCONV_VERSION = "genai-unreleased@2026-07-25+semconv-1.41.1";

/**
 * Schema-URL versions whose GenAI attribute names this mapper reads correctly.
 *
 * Floor is 1.28.0 — the release that renamed
 * `gen_ai.usage.prompt_tokens`/`completion_tokens`. Both spellings are read,
 * so everything from 1.28 up is interpretable. Ceiling is 1.43.0, the newest
 * main-repo release at the time of writing.
 *
 * A span declaring a schema URL OUTSIDE this set is NOT quietly read under
 * these rules — it becomes `otel.span.unmapped` with reason
 * `unsupported-semconv-version`, because reading an unknown convention's
 * attributes under this one's is exactly the "same name, different meaning"
 * hazard `provenance.semconvVersion` exists to make visible. A span with NO
 * schema URL is read under these rules; that is the common case, and since the
 * GenAI repo has no schema URL at all yet, it may stay the common case.
 */
export const SUPPORTED_SEMCONV_VERSIONS: ReadonlySet<string> = new Set([
  "1.28.0", "1.29.0", "1.30.0", "1.31.0", "1.32.0", "1.33.0", "1.34.0",
  "1.35.0", "1.36.0", "1.37.0", "1.38.0", "1.39.0", "1.40.0", "1.41.0",
  "1.41.1", "1.42.0", "1.43.0",
]);

// ---------------------------------------------------------------------------
// GenAI attribute names
// ---------------------------------------------------------------------------

const ATTR_OPERATION_NAME = "gen_ai.operation.name";
/** Current name (main-repo v1.37.0+). */
const ATTR_PROVIDER_NAME = "gen_ai.provider.name";
/** Former name, deprecated but still emitted by most deployed instrumentation. */
const ATTR_SYSTEM = "gen_ai.system";
const ATTR_REQUEST_MODEL = "gen_ai.request.model";
const ATTR_RESPONSE_MODEL = "gen_ai.response.model";
const ATTR_RESPONSE_ID = "gen_ai.response.id";
const ATTR_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
/** Current names (main-repo v1.28.0+). */
const ATTR_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const ATTR_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
/** Pre-1.28 names, deprecated, still emitted in the wild. */
const ATTR_USAGE_PROMPT_TOKENS = "gen_ai.usage.prompt_tokens";
const ATTR_USAGE_COMPLETION_TOKENS = "gen_ai.usage.completion_tokens";
const ATTR_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
const ATTR_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
const ATTR_TOOL_NAME = "gen_ai.tool.name";
const ATTR_TOOL_CALL_ID = "gen_ai.tool.call.id";
const ATTR_TOOL_DESCRIPTION = "gen_ai.tool.description";
const ATTR_TOOL_TYPE = "gen_ai.tool.type";
/** Opt-In content attributes (Development). Usually absent. */
const ATTR_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
const ATTR_TOOL_CALL_RESULT = "gen_ai.tool.call.result";
const ATTR_INPUT_MESSAGES = "gen_ai.input.messages";
const ATTR_OUTPUT_MESSAGES = "gen_ai.output.messages";
const ATTR_SYSTEM_INSTRUCTIONS = "gen_ai.system_instructions";
const ATTR_AGENT_NAME = "gen_ai.agent.name";
const ATTR_AGENT_ID = "gen_ai.agent.id";
const ATTR_AGENT_DESCRIPTION = "gen_ai.agent.description";
const ATTR_CONVERSATION_ID = "gen_ai.conversation.id";
const ATTR_DATA_SOURCE_ID = "gen_ai.data_source.id";
/** From the core registry. The ONLY Stable attribute this mapper reads. */
const ATTR_ERROR_TYPE = "error.type";

/**
 * Every attribute the mapper consumes. Anything on a span outside this set is
 * dropped, and dropping it sets `attributes-dropped`. Keeping the set explicit
 * makes "did we lose anything?" a COMPUTATION rather than a claim.
 */
const CONSUMED_ATTRIBUTES: ReadonlySet<string> = new Set([
  ATTR_OPERATION_NAME, ATTR_PROVIDER_NAME, ATTR_SYSTEM,
  ATTR_REQUEST_MODEL, ATTR_RESPONSE_MODEL, ATTR_RESPONSE_ID,
  ATTR_RESPONSE_FINISH_REASONS, ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS, ATTR_USAGE_PROMPT_TOKENS,
  ATTR_USAGE_COMPLETION_TOKENS, ATTR_REQUEST_TEMPERATURE,
  ATTR_REQUEST_MAX_TOKENS, ATTR_TOOL_NAME, ATTR_TOOL_CALL_ID,
  ATTR_TOOL_DESCRIPTION, ATTR_TOOL_TYPE, ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_RESULT, ATTR_INPUT_MESSAGES, ATTR_OUTPUT_MESSAGES,
  ATTR_SYSTEM_INSTRUCTIONS, ATTR_AGENT_NAME, ATTR_AGENT_ID,
  ATTR_AGENT_DESCRIPTION, ATTR_CONVERSATION_ID, ATTR_DATA_SOURCE_ID,
  ATTR_ERROR_TYPE,
]);

/**
 * `gen_ai.operation.name` well-known values — all seventeen, grouped by how
 * this mapper treats them. Kept as complete sets rather than a prefix test so
 * that a NEW enum member added upstream falls through to `no-matching-rule`
 * (recorded, visible) instead of being silently absorbed by a loose match.
 */
const OPERATION_INFERENCE: ReadonlySet<string> = new Set([
  "chat", "text_completion", "generate_content", "embeddings",
]);
const OPERATION_TOOL = "execute_tool";
const OPERATION_RETRIEVAL = "retrieval";
const OPERATION_MEMORY_READ: ReadonlySet<string> = new Set(["search_memory"]);
const OPERATION_MEMORY_WRITE: ReadonlySet<string> = new Set([
  "create_memory", "update_memory", "upsert_memory", "delete_memory",
  "create_memory_store", "delete_memory_store",
]);
const OPERATION_OPAQUE: ReadonlySet<string> = new Set([
  "invoke_agent", "create_agent", "invoke_workflow", "plan",
]);

/** Bounds on what an `otel.span.unmapped` payload carries inline. */
const MAX_UNMAPPED_ATTRIBUTES = 128;
const MAX_ATTRIBUTE_STRING_LENGTH = 2048;
/** Cap on `run.failed.errorSummary`, matching the SDK's own 512-char cap. */
const MAX_ERROR_SUMMARY_LENGTH = 512;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** OTel attribute values: scalars, or homogeneous arrays of scalars. Opt-In content attributes are typed `any` upstream, hence `unknown`. */
export type OtelAttributeValue = unknown;

/**
 * A normalized OTel span.
 *
 * NORMALIZED, not raw OTLP: the caller is expected to have flattened OTLP's
 * `KeyValue[]` attribute list into a plain object. That flattening is
 * mechanical and lossless; owning it here would give this module a
 * protobuf/JSON decoding surface it has no business owning and would make the
 * ordering engine untestable without OTLP fixtures.
 *
 * Timestamps are UNIX NANOSECONDS as `bigint` or as the decimal `string`
 * OTLP/JSON uses for uint64. A `number` is accepted for ergonomics but is NOT
 * safe at nanosecond scale, so a numeric timestamp is flagged
 * `timing-approximated` on every event derived from that span.
 *
 * `endTimeUnixNano` absent, or equal to zero, means the span HAS NOT ENDED.
 * Zero is "unset" on the wire; read as an instant it sorts to the front of the
 * run, putting a tool's result before the run began.
 */
export interface OtelSpanInput {
  traceId: string;
  spanId: string;
  /** Absent, empty, or equal to `spanId` all mean "root". */
  parentSpanId?: string;
  name: string;
  kind?: OtelSpanKind;
  startTimeUnixNano: bigint | string | number;
  endTimeUnixNano?: bigint | string | number;
  attributes?: Readonly<Record<string, OtelAttributeValue>>;
  /** OTLP numeric status code (0 unset / 1 ok / 2 error) or the lowercased name. */
  status?: { code: number | "unset" | "ok" | "error"; message?: string };
  scopeName?: string;
  schemaUrl?: string;
  /** Count only — span events are not representable and are reported as lost. */
  spanEventCount?: number;
  /** Count only — span links are not representable and are reported as lost. */
  spanLinkCount?: number;
}

/**
 * What the mapper must be told about what has ALREADY been written for this
 * run, if it is to extend an append-only log across batches.
 *
 * Without this a continuation batch restarts at sequence 1 and collides with
 * already-written events; and a redelivered batch (OTLP collectors redeliver)
 * permanently doubles the run.
 */
export interface PriorRunState {
  /** Highest `sequenceNumber` already durably written for this run. */
  lastSequenceNumber?: number;
  /** Span ids already mapped into this run. Spans in this set are REJECTED, not re-emitted. */
  knownSpanIds?: readonly string[];
}

export interface MapOptions extends PriorRunState {
  /**
   * Server wall clock at ingest, epoch ms. Written verbatim to every emitted
   * event's `provenance.receivedAt` — the field that makes clock skew between
   * the emitting process and us VISIBLE instead of indistinguishable from
   * out-of-order execution.
   *
   * OPTIONAL only so the mapper stays callable as a pure ordering function in
   * tests and analysis. When omitted it falls back to the trace's own latest
   * observed instant (a provable LOWER BOUND on when we could have received
   * it), emits a `received-at-defaulted` diagnostic, and marks the affected
   * events `timing-approximated`. A real ingest path MUST pass it.
   */
  receivedAt?: number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type DiagnosticCode =
  | "empty-batch"
  | "foreign-trace-spans"
  | "duplicate-span-id"
  | "orphan-span"
  | "parent-cycle"
  | "self-parent"
  | "multiple-roots"
  | "no-root-span"
  | "clock-skew-clamped"
  | "trace-incomplete"
  | "unsupported-semconv-version"
  | "timestamp-precision-loss"
  | "malformed-span-id"
  | "negative-duration"
  | "already-known-span"
  | "received-at-defaulted"
  /** SELF-CHECK FAILURE: an accepted span produced no event. Fatal, must never fire. */
  | "span-dropped";

export interface MappingDiagnostic {
  code: DiagnosticCode;
  /** True if this diagnostic means the result must not be ingested. */
  fatal: boolean;
  /** Sorted, so the report is deterministic. */
  spanIds: string[];
  message: string;
}

export interface UnmappedSpanReport {
  spanId: string;
  spanName: string;
  spanKind: OtelSpanKind;
  reason: OtelUnmappedReason;
  /** Index into `MapResult.events` of the `otel.span.unmapped` event. */
  eventIndex: number;
}

/**
 * A span NOT recorded at all. Strictly distinct from `unmapped`: an unmapped
 * span WAS recorded (as an `otel.span.unmapped` event), a rejected one was
 * not. Maps onto `IngestOtelSpansResponse.rejected`.
 */
export interface RejectedSpanReport {
  spanId: string;
  reason: "foreign-trace" | "already-known" | "duplicate";
}

export interface MapResult {
  /** False if any diagnostic is fatal. A caller MUST NOT ingest a `!ok` result. */
  ok: boolean;
  traceId: string | null;
  /** Sequence-ordered. `events[i].sequenceNumber === priorLast + i + 1`, always. */
  events: DerivedEventWrite[];
  /** True when NO terminal event was emitted — the run is in-progress per Rule 5. */
  runOpen: boolean;
  terminalType: "run.completed" | "run.failed" | null;
  /** Spans RECORDED as `otel.span.unmapped`. */
  unmapped: UnmappedSpanReport[];
  /** Spans NOT recorded. Never conflate with `unmapped`. */
  rejected: RejectedSpanReport[];
  diagnostics: MappingDiagnostic[];
  stats: {
    spansIn: number;
    spansAccepted: number;
    spansMapped: number;
    spansUnmapped: number;
    spansRejected: number;
    eventsOut: number;
    clockSkewClamps: number;
  };
}

// ---------------------------------------------------------------------------
// Small pure utilities
// ---------------------------------------------------------------------------

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const NANOS_PER_MS = 1_000_000n;

function toNanos(value: bigint | string | number): { ns: bigint; approximate: boolean } {
  if (typeof value === "bigint") return { ns: value, approximate: false };
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return { ns: 0n, approximate: true };
    return { ns: BigInt(value), approximate: false };
  }
  if (!Number.isFinite(value)) return { ns: 0n, approximate: true };
  return { ns: BigInt(Math.trunc(value)), approximate: !Number.isSafeInteger(value) };
}

/** Floor-divide nanoseconds to epoch milliseconds (our schema's unit). */
function nanosToMs(ns: bigint): number {
  return Number(ns / NANOS_PER_MS);
}

function cmpBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeStatusCode(
  code: number | "unset" | "ok" | "error" | undefined,
): "unset" | "ok" | "error" {
  if (code === undefined) return "unset";
  if (typeof code === "number") return code === 2 ? "error" : code === 1 ? "ok" : "unset";
  return code;
}

function readString(attrs: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const raw = attrs[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function readNumber(attrs: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const raw = attrs[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return undefined;
}

function readStringArrayFirst(
  attrs: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const raw = attrs[key];
  if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === "string" && v.length > 0);
    return typeof first === "string" ? first : undefined;
  }
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Read an Opt-In `gen_ai.{input,output}.messages` value into our
 * `{role, content}` shape. Type is `any` upstream and MAY be a JSON string
 * where structured attributes are not yet supported (pending OTEP 4485), so
 * both are handled; anything unrecognised is preserved verbatim under a
 * `_raw` role rather than discarded.
 */
function readMessages(
  attrs: Readonly<Record<string, unknown>>,
  key: string,
): Array<{ role: string; content: unknown }> | undefined {
  const raw = attrs[key];
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (typeof item === "object" && item !== null && "role" in item) {
        const rec = item as Record<string, unknown>;
        return {
          role: typeof rec["role"] === "string" ? rec["role"] : "unknown",
          content: rec["parts"] ?? rec["content"] ?? item,
        };
      }
      return { role: "unknown", content: item };
    });
  }
  return [{ role: "_raw", content: raw }];
}

/** Extract "1.41.1" out of "https://opentelemetry.io/schemas/1.41.1". */
function schemaUrlVersion(schemaUrl: string | undefined): string | undefined {
  if (schemaUrl === undefined) return undefined;
  const match = /\/(\d+\.\d+(?:\.\d+)?)$/.exec(schemaUrl);
  return match?.[1];
}

function truncateString(value: string): { value: string; truncated: boolean } {
  return value.length <= MAX_ATTRIBUTE_STRING_LENGTH
    ? { value, truncated: false }
    : { value: value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH), truncated: true };
}

/**
 * Bound the attribute bag carried inline on an `otel.span.unmapped` payload.
 * Keys are sorted first so the cap is deterministic rather than dependent on
 * the caller's object-construction order.
 */
function boundAttributes(attrs: Readonly<Record<string, unknown>>): {
  attributes: Record<string, unknown>;
  truncated: boolean;
} {
  const keys = Object.keys(attrs).sort();
  let truncated = keys.length > MAX_UNMAPPED_ATTRIBUTES;
  const out: Record<string, unknown> = {};
  for (const key of keys.slice(0, MAX_UNMAPPED_ATTRIBUTES)) {
    const raw = attrs[key];
    if (typeof raw === "string") {
      const t = truncateString(raw);
      truncated = truncated || t.truncated;
      out[key] = t.value;
    } else {
      out[key] = raw;
    }
  }
  return { attributes: out, truncated };
}

// ---------------------------------------------------------------------------
// Prepared spans, tree reconstruction, and the causality clamp
// ---------------------------------------------------------------------------

interface PreparedSpan {
  input: OtelSpanInput;
  spanId: string;
  /** Resolved parent within this batch; undefined for any kind of root. */
  parentSpanId?: string;
  attrs: Readonly<Record<string, unknown>>;
  rawStartNs: bigint;
  /** Undefined means the span never ended (absent or zero end time). */
  rawEndNs?: bigint;
  effStartNs: bigint;
  effEndNs?: bigint;
  depth: number;
  /** No parent reference at all (or self-parent): a genuine run boundary candidate. */
  isTrueRoot: boolean;
  /** Parent named but not present in this batch: a tree root, but NEVER a run boundary. */
  isOrphanRoot: boolean;
  status: "unset" | "ok" | "error";
  baseLoss: Set<OtelMappingLossReason>;
}

/**
 * Deduplicate by span id.
 *
 * A duplicate span id would defeat the spanId tiebreak (ordering clause 4) and
 * leave a genuine tie, so it cannot be ignored. Exporters retry on timeout and
 * on 5xx, and some SDKs export the same span twice with DIFFERING content (a
 * later export carrying an end time or status the first lacked) — so the
 * survivor must not be "whichever arrived first". It is chosen by a TOTAL,
 * arrival-order-independent key: (startNs, endNs, name, canonical JSON of
 * attributes). Every discarded copy is REPORTED, never silently merged.
 */
function dedupeSpans(spans: readonly OtelSpanInput[]): {
  kept: OtelSpanInput[];
  duplicateSpanIds: string[];
} {
  const groups = new Map<string, OtelSpanInput[]>();
  for (const span of spans) {
    const list = groups.get(span.spanId);
    if (list) list.push(span);
    else groups.set(span.spanId, [span]);
  }

  const kept: OtelSpanInput[] = [];
  const duplicateSpanIds: string[] = [];
  for (const [spanId, list] of groups) {
    const first = list[0] as OtelSpanInput;
    if (list.length === 1) {
      kept.push(first);
      continue;
    }
    duplicateSpanIds.push(spanId);
    let best = first;
    for (const candidate of list.slice(1)) {
      if (compareDuplicateCandidates(candidate, best) < 0) best = candidate;
    }
    kept.push(best);
  }

  kept.sort((a, b) => cmpString(a.spanId, b.spanId));
  return { kept, duplicateSpanIds: duplicateSpanIds.sort() };
}

function compareDuplicateCandidates(a: OtelSpanInput, b: OtelSpanInput): number {
  const as = toNanos(a.startTimeUnixNano).ns;
  const bs = toNanos(b.startTimeUnixNano).ns;
  if (as !== bs) return cmpBigint(as, bs);
  const ae = a.endTimeUnixNano === undefined ? -1n : toNanos(a.endTimeUnixNano).ns;
  const be = b.endTimeUnixNano === undefined ? -1n : toNanos(b.endTimeUnixNano).ns;
  if (ae !== be) return cmpBigint(ae, be);
  if (a.name !== b.name) return cmpString(a.name, b.name);
  return cmpString(JSON.stringify(a.attributes ?? {}), JSON.stringify(b.attributes ?? {}));
}

interface TreeResult {
  prepared: PreparedSpan[];
  byId: Map<string, PreparedSpan>;
  orphanSpanIds: string[];
  selfParentSpanIds: string[];
  cycleSpanIds: string[];
  skewClampedSpanIds: string[];
  negativeDurationSpanIds: string[];
  precisionLossSpanIds: string[];
}

/**
 * Reconstruct the span forest and apply the causality clamp.
 *
 * Every traversal here is ITERATIVE and MEMOIZED — O(n) overall, no recursion.
 * A 10,000-deep parent chain is reachable from a recursive agent; a recursive
 * walk blows the JS stack (a `RangeError` inside a Convex mutation loses the
 * whole batch), and a per-span ancestor walk is O(n^2) and times the ingest
 * out at the same scale.
 */
function buildTree(spans: readonly OtelSpanInput[]): TreeResult {
  const byId = new Map<string, PreparedSpan>();
  const prepared: PreparedSpan[] = [];
  const precisionLossSpanIds: string[] = [];
  const negativeDurationSpanIds: string[] = [];
  const selfParentSpanIds: string[] = [];

  for (const input of spans) {
    const start = toNanos(input.startTimeUnixNano);
    // Zero/absent end == UNSET on the wire, NOT "ended at the epoch".
    const endRaw =
      input.endTimeUnixNano === undefined ? undefined : toNanos(input.endTimeUnixNano);
    const end = endRaw !== undefined && endRaw.ns > 0n ? endRaw : undefined;
    const baseLoss = new Set<OtelMappingLossReason>();

    if (start.approximate || end?.approximate === true) {
      baseLoss.add("timing-approximated");
      precisionLossSpanIds.push(input.spanId);
    }
    if ((input.spanEventCount ?? 0) > 0) baseLoss.add("span-events-dropped");
    if ((input.spanLinkCount ?? 0) > 0) baseLoss.add("span-links-dropped");

    let rawEndNs = end?.ns;
    if (rawEndNs !== undefined && rawEndNs < start.ns) {
      // NTP step-back mid-span, or hand-written instrumentation. A span whose
      // close precedes its own open is not a rendering problem, it is a log
      // that cannot be replayed. Clamp up and SAY SO.
      negativeDurationSpanIds.push(input.spanId);
      baseLoss.add("timing-approximated");
      rawEndNs = start.ns;
    }

    const selfParent = input.parentSpanId !== undefined && input.parentSpanId === input.spanId;
    if (selfParent) selfParentSpanIds.push(input.spanId);

    const span: PreparedSpan = {
      input,
      spanId: input.spanId,
      attrs: input.attributes ?? {},
      rawStartNs: start.ns,
      rawEndNs,
      effStartNs: start.ns,
      effEndNs: rawEndNs,
      depth: 0,
      isTrueRoot:
        input.parentSpanId === undefined || input.parentSpanId === "" || selfParent,
      isOrphanRoot: false,
      status: normalizeStatusCode(input.status?.code),
      baseLoss,
    };
    if (!span.isTrueRoot) span.parentSpanId = input.parentSpanId;
    prepared.push(span);
    byId.set(span.spanId, span);
  }

  // --- orphans: parent named but absent from this batch --------------------
  const orphanSpanIds: string[] = [];
  for (const span of prepared) {
    if (span.parentSpanId === undefined) continue;
    if (!byId.has(span.parentSpanId)) {
      span.isOrphanRoot = true;
      span.parentSpanId = undefined;
      orphanSpanIds.push(span.spanId);
    }
  }

  // --- cycle breaking, O(n) via three-colour iterative walk ----------------
  // A -> B -> C -> A is impossible in a well-behaved tracer and trivially
  // constructible by a broken or hostile client posting raw OTLP. The break
  // point is the LOWEST span id in the cycle, so it is deterministic rather
  // than dependent on which member the walk happened to enter from.
  const cycleSpanIds: string[] = [];
  const colour = new Map<string, 1 | 2>(); // 1 = in progress, 2 = settled
  for (const seed of prepared) {
    if (colour.has(seed.spanId)) continue;
    const path: PreparedSpan[] = [];
    let cursor: PreparedSpan | undefined = seed;
    while (cursor !== undefined && !colour.has(cursor.spanId)) {
      colour.set(cursor.spanId, 1);
      path.push(cursor);
      cursor = cursor.parentSpanId === undefined ? undefined : byId.get(cursor.parentSpanId);
    }
    if (cursor !== undefined && colour.get(cursor.spanId) === 1) {
      const entry = path.indexOf(cursor);
      const members = path.slice(entry === -1 ? 0 : entry);
      let lowest = members[0] as PreparedSpan;
      for (const m of members) if (m.spanId < lowest.spanId) lowest = m;
      lowest.parentSpanId = undefined;
      lowest.isOrphanRoot = true;
      cycleSpanIds.push(lowest.spanId);
    }
    for (const node of path) colour.set(node.spanId, 2);
  }

  // --- depth, O(n) via memoized iterative walk -----------------------------
  const depth = new Map<string, number>();
  for (const seed of prepared) {
    if (depth.has(seed.spanId)) continue;
    const stack: PreparedSpan[] = [];
    let cursor: PreparedSpan | undefined = seed;
    while (cursor !== undefined && !depth.has(cursor.spanId)) {
      const parentId: string | undefined = cursor.parentSpanId;
      const parent: PreparedSpan | undefined =
        parentId === undefined ? undefined : byId.get(parentId);
      if (parent === undefined) {
        depth.set(cursor.spanId, 0);
        break;
      }
      stack.push(cursor);
      cursor = parent;
    }
    while (stack.length > 0) {
      const node = stack.pop() as PreparedSpan;
      const parentId = node.parentSpanId;
      const parentDepth = parentId === undefined ? -1 : depth.get(parentId) ?? -1;
      depth.set(node.spanId, parentDepth + 1);
    }
  }
  for (const span of prepared) span.depth = depth.get(span.spanId) ?? 0;

  // --- the causality clamp (ordering clause 1b) ----------------------------
  // Starts clamp TOP-DOWN: a child can never begin before its parent.
  // Ends clamp BOTTOM-UP:  a parent can never end before its children.
  // Both deterministic; every clamp that actually moved a value is recorded.
  const skewClamped = new Set<string>();
  const byDepth = [...prepared].sort((a, b) => a.depth - b.depth || cmpString(a.spanId, b.spanId));

  for (const span of byDepth) {
    const parent = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
    if (parent === undefined) continue;
    if (span.effStartNs < parent.effStartNs) {
      span.effStartNs = parent.effStartNs;
      skewClamped.add(span.spanId);
      span.baseLoss.add("timing-approximated");
    }
    if (span.effEndNs !== undefined && span.effEndNs < span.effStartNs) {
      span.effEndNs = span.effStartNs;
      skewClamped.add(span.spanId);
      span.baseLoss.add("timing-approximated");
    }
  }

  for (let i = byDepth.length - 1; i >= 0; i -= 1) {
    const span = byDepth[i] as PreparedSpan;
    const parent = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
    if (parent === undefined) continue;
    if (parent.effEndNs !== undefined && span.effEndNs !== undefined && parent.effEndNs < span.effEndNs) {
      parent.effEndNs = span.effEndNs;
      skewClamped.add(parent.spanId);
      parent.baseLoss.add("timing-approximated");
    }
  }

  return {
    prepared,
    byId,
    orphanSpanIds: orphanSpanIds.sort(),
    selfParentSpanIds: selfParentSpanIds.sort(),
    cycleSpanIds: cycleSpanIds.sort(),
    skewClampedSpanIds: [...skewClamped].sort(),
    negativeDurationSpanIds: negativeDurationSpanIds.sort(),
    precisionLossSpanIds: precisionLossSpanIds.sort(),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type SpanClass =
  | { kind: "inference"; operation: string }
  | { kind: "tool" }
  | { kind: "retrieval" }
  | { kind: "memory"; write: boolean; operation: string }
  | { kind: "opaque"; operation: string }
  | { kind: "unmapped"; reason: OtelUnmappedReason };

/**
 * Classify a span.
 *
 * `gen_ai.operation.name` is authoritative when present; otherwise the
 * conventional span-name prefix; otherwise attribute shape. SpanKind is NEVER
 * used as a classifier — `invoke_agent` is defined as two span groups (CLIENT
 * for hosted agents, INTERNAL for in-process frameworks), and inference MAY be
 * INTERNAL for in-process models, so kind carries no discriminating power. It
 * is recorded, not branched on.
 *
 * A span that is not GenAI at all — an HTTP client span, a DB span, a
 * framework-internal span — is `unmapped`, NOT force-fitted. Those belong to
 * other semantic-convention groups, and guessing at them here would be exactly
 * the invented-vocabulary failure this module exists to avoid.
 */
export function classifySpan(span: {
  name: string;
  attributes?: Readonly<Record<string, unknown>>;
  schemaUrl?: string;
}): SpanClass {
  const version = schemaUrlVersion(span.schemaUrl);
  if (version !== undefined && !SUPPORTED_SEMCONV_VERSIONS.has(version)) {
    return { kind: "unmapped", reason: "unsupported-semconv-version" };
  }

  const attrs = span.attributes ?? {};
  const declared = readString(attrs, ATTR_OPERATION_NAME);
  const fromName = span.name.split(" ", 1)[0] ?? "";
  const operation = declared ?? fromName;

  if (OPERATION_INFERENCE.has(operation)) return { kind: "inference", operation };
  if (operation === OPERATION_TOOL) {
    return readString(attrs, ATTR_TOOL_NAME) === undefined
      ? { kind: "unmapped", reason: "missing-required-attributes" }
      : { kind: "tool" };
  }
  if (operation === OPERATION_RETRIEVAL) return { kind: "retrieval" };
  if (OPERATION_MEMORY_READ.has(operation)) return { kind: "memory", write: false, operation };
  if (OPERATION_MEMORY_WRITE.has(operation)) return { kind: "memory", write: true, operation };
  if (OPERATION_OPAQUE.has(operation)) return { kind: "opaque", operation };

  // A DECLARED operation we do not implement (a newer enum member, or a vendor
  // extension) is explicitly unmapped, never coerced to the nearest fit.
  if (declared !== undefined) return { kind: "unmapped", reason: "no-matching-rule" };

  // Last resort: attribute shape.
  const hasTool = readString(attrs, ATTR_TOOL_NAME) !== undefined;
  const hasModel = readString(attrs, ATTR_REQUEST_MODEL) !== undefined;
  if (hasTool && hasModel) return { kind: "unmapped", reason: "ambiguous-match" };
  if (hasTool) return { kind: "tool" };
  if (hasModel) return { kind: "inference", operation: "chat" };

  const hasAnyGenAi = Object.keys(attrs).some((k) => k.startsWith("gen_ai."));
  return {
    kind: "unmapped",
    reason: hasAnyGenAi ? "missing-required-attributes" : "no-matching-rule",
  };
}

// ---------------------------------------------------------------------------
// Emissions and THE ORDERING KEY
// ---------------------------------------------------------------------------

type EmissionRole =
  | "run-boundary-open"
  | "run-boundary-close"
  | "span-open"
  | "span-close"
  | "span-single"
  | "span-unmapped";

interface Emission {
  role: EmissionRole;
  span: PreparedSpan;
  instantNs: bigint;
  rawInstantNs: bigint;
  /** -1 for the synthesized run boundary, so it brackets every span. */
  depth: number;
  phase: "open" | "close";
}

/**
 * THE ORDERING KEY. See PART 3 in the file header for the defence of each
 * clause.
 *
 * This is a STRICT TOTAL ORDER over the emissions of one trace: no ties are
 * possible, because the final clause is span id (unique per trace after
 * `dedupeSpans`) and a span emits at most one emission per phase.
 */
export function compareEmissions(a: Emission, b: Emission): number {
  // 1. effective instant, nanosecond precision
  const byInstant = cmpBigint(a.instantNs, b.instantNs);
  if (byInstant !== 0) return byInstant;

  // 2. opens before closes — forced, not chosen
  const aPhase = a.phase === "open" ? 0 : 1;
  const bPhase = b.phase === "open" ? 0 : 1;
  if (aPhase !== bPhase) return aPhase - bPhase;

  // 3. depth: outside-in for opens, inside-out for closes
  if (a.depth !== b.depth) return a.phase === "open" ? a.depth - b.depth : b.depth - a.depth;

  // 4. span id: arbitrary, but total and stable
  return cmpString(a.span.spanId, b.span.spanId);
}

/**
 * The comparator a REPLAY or DIFF projection must use over derived events.
 *
 * `sequenceNumber` is append order, which for a multi-batch derived run is the
 * order the collector flushed, not the order things happened. This orders by
 * the same key `compareEmissions` used, reconstructed from the stored
 * `temporalOrder` field. Exported so no consumer has to re-derive it (or, more
 * likely, quietly not bother).
 */
export function compareTemporalOrder(a: TemporalOrderKey, b: TemporalOrderKey): number {
  const byInstant = cmpBigint(BigInt(a.instantUnixNano), BigInt(b.instantUnixNano));
  if (byInstant !== 0) return byInstant;
  const aPhase = a.phase === "open" ? 0 : 1;
  const bPhase = b.phase === "open" ? 0 : 1;
  if (aPhase !== bPhase) return aPhase - bPhase;
  if (a.depth !== b.depth) return a.phase === "open" ? a.depth - b.depth : b.depth - a.depth;
  return cmpString(a.spanId, b.spanId);
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function hasDroppedAttributes(attrs: Readonly<Record<string, unknown>>): boolean {
  for (const key of Object.keys(attrs)) if (!CONSUMED_ATTRIBUTES.has(key)) return true;
  return false;
}

function provenanceFor(
  span: PreparedSpan,
  traceId: string,
  receivedAt: number,
  extraLoss: readonly OtelMappingLossReason[],
): OtelEventProvenance {
  const reasons = new Set<OtelMappingLossReason>(span.baseLoss);
  for (const reason of extraLoss) reasons.add(reason);
  const lossReasons = [...reasons].sort();
  const provenance: OtelEventProvenance = {
    source: "otel",
    traceId,
    spanId: span.spanId,
    spanName: span.input.name,
    semconvVersion: SEMCONV_VERSION,
    mapperVersion: MAPPER_VERSION,
    // `lossy` and `lossReasons` are derived from ONE source here, so the
    // invariant contracts' `isProvenanceConsistent` enforces (non-empty iff
    // lossy) cannot drift.
    lossy: lossReasons.length > 0,
    receivedAt,
  };
  if (span.parentSpanId !== undefined) provenance.parentSpanId = span.parentSpanId;
  else if (span.input.parentSpanId !== undefined && span.input.parentSpanId !== "") {
    // Preserve the RAW parent pointer even when it was severed (orphan, cycle,
    // self-parent): the reader needs to see what the emitter claimed.
    provenance.parentSpanId = span.input.parentSpanId;
  }
  if (span.input.scopeName !== undefined) provenance.scopeName = span.input.scopeName;
  if (lossReasons.length > 0) provenance.lossReasons = lossReasons;
  return provenance;
}

function errorOf(span: PreparedSpan): { message: string; code?: string } {
  const code = readString(span.attrs, ATTR_ERROR_TYPE);
  const message =
    span.input.status?.message ??
    code ??
    `OTel span "${span.input.name}" reported status ERROR with no message`;
  const { value } = truncateString(message);
  return code === undefined ? { message: value } : { message: value, code };
}

function durationMsOf(span: PreparedSpan): number {
  return span.effEndNs === undefined ? 0 : nanosToMs(span.effEndNs - span.effStartNs);
}

/**
 * Synthesized tool-call id when the span carries no `gen_ai.tool.call.id`.
 *
 * `ToolCallPayload.call_id` is REQUIRED, so there is no honest "absent" to
 * record. Deriving it from the span id keeps the call↔result correlation
 * correct and makes the synthesis self-evident (the `otel:` prefix), and the
 * event carries `identity-synthesized` — the most dangerous loss class,
 * because the value LOOKS first-party but was invented at ingest.
 */
function synthesizedCallId(spanId: string): string {
  return `otel:${spanId}`;
}

function fatal(code: DiagnosticCode, spanIds: string[], message: string): MappingDiagnostic {
  return { code, fatal: true, spanIds: [...spanIds].sort(), message };
}

function note(code: DiagnosticCode, spanIds: string[], message: string): MappingDiagnostic {
  return { code, fatal: false, spanIds: [...spanIds].sort(), message };
}

function emptyResult(
  diagnostics: MappingDiagnostic[],
  traceId: string | null,
  spansIn: number,
  rejected: RejectedSpanReport[],
): MapResult {
  return {
    ok: !diagnostics.some((d) => d.fatal),
    traceId,
    events: [],
    runOpen: true,
    terminalType: null,
    unmapped: [],
    rejected,
    diagnostics,
    stats: {
      spansIn,
      spansAccepted: 0,
      spansMapped: 0,
      spansUnmapped: 0,
      spansRejected: rejected.length,
      eventsOut: 0,
      clockSkewClamps: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

/**
 * Map one OTel trace batch to a contiguous, sequence-ordered event log.
 *
 * PURE: no `ctx`, no db, no clock, no randomness, no recursion.
 *
 * The result is a PROPOSAL, not a write. The caller (an org-scoped Convex
 * mutation) owns auth, `orgId` scoping, run resolution and the appends, and
 * MUST refuse to ingest a result whose `ok` is false.
 */
export function mapOtelSpansToEvents(
  spans: readonly OtelSpanInput[],
  options: MapOptions = {},
): MapResult {
  const diagnostics: MappingDiagnostic[] = [];
  const rejected: RejectedSpanReport[] = [];
  const spansIn = spans.length;
  const priorLast = Math.max(0, Math.trunc(options.lastSequenceNumber ?? 0));
  const known = new Set(options.knownSpanIds ?? []);
  const isContinuation = priorLast > 0 || known.size > 0;

  if (spansIn === 0) {
    return emptyResult([note("empty-batch", [], "No spans supplied")], null, 0, rejected);
  }

  // --- TENANCY: one run is exactly one trace ------------------------------
  // A single OTLP ExportTraceServiceRequest legitimately carries spans from
  // MANY traces — that is what a batch processor is for. Foreign spans must
  // neither appear in this run nor consume its sequence numbers. Selection is
  // deterministic (most spans wins; lexicographically smallest trace id breaks
  // the tie) so it cannot depend on arrival order.
  const traceCounts = new Map<string, number>();
  for (const span of spans) traceCounts.set(span.traceId, (traceCounts.get(span.traceId) ?? 0) + 1);
  let traceId = "";
  let bestCount = -1;
  for (const [candidate, count] of [...traceCounts.entries()].sort((a, b) => cmpString(a[0], b[0]))) {
    if (count > bestCount) {
      bestCount = count;
      traceId = candidate;
    }
  }

  const ownTrace: OtelSpanInput[] = [];
  for (const span of spans) {
    if (span.traceId === traceId) ownTrace.push(span);
    else rejected.push({ spanId: span.spanId, reason: "foreign-trace" });
  }
  if (traceCounts.size > 1) {
    diagnostics.push(
      note(
        "foreign-trace-spans",
        rejected.map((r) => r.spanId),
        `batch carried ${traceCounts.size} distinct trace ids; ${rejected.length} span(s) from other traces were REJECTED (not recorded) rather than numbered into this run`,
      ),
    );
  }

  // --- DEDUP within the batch ---------------------------------------------
  const { kept: deduped, duplicateSpanIds } = dedupeSpans(ownTrace);
  if (duplicateSpanIds.length > 0) {
    for (const spanId of duplicateSpanIds) rejected.push({ spanId, reason: "duplicate" });
    diagnostics.push(
      note(
        "duplicate-span-id",
        duplicateSpanIds,
        `${duplicateSpanIds.length} span id(s) appeared more than once; one copy per id was kept by a deterministic key and the rest discarded`,
      ),
    );
  }

  // --- DEDUP across batches ------------------------------------------------
  const accepted: OtelSpanInput[] = [];
  const alreadyKnown: string[] = [];
  for (const span of deduped) {
    if (known.has(span.spanId)) {
      alreadyKnown.push(span.spanId);
      rejected.push({ spanId: span.spanId, reason: "already-known" });
      continue;
    }
    accepted.push(span);
  }
  if (alreadyKnown.length > 0) {
    diagnostics.push(
      note(
        "already-known-span",
        alreadyKnown,
        `${alreadyKnown.length} span(s) were already mapped into this run; re-emitting them would permanently double the run under an append-only log`,
      ),
    );
  }
  if (accepted.length === 0) {
    // A redelivered batch whose every span is already known. The correct
    // output is nothing at all — not a second copy, not an empty run boundary.
    return emptyResult(diagnostics, traceId, spansIn, rejected);
  }

  // --- id well-formedness (REPORTED, not fatal) ---------------------------
  // The mapper's job is mapping; W3C-shape validation belongs at the ingest
  // boundary, where contracts' `isProvenanceConsistent` already rejects a
  // malformed provenance BEFORE it reaches an append-only table. Failing the
  // whole batch here would also make the mapper untestable with readable
  // fixture ids.
  const malformed = accepted
    .filter(
      (s) =>
        !TRACE_ID_RE.test(s.traceId) ||
        !SPAN_ID_RE.test(s.spanId) ||
        (s.parentSpanId !== undefined &&
          s.parentSpanId !== "" &&
          !SPAN_ID_RE.test(s.parentSpanId)),
    )
    .map((s) => s.spanId);
  if (malformed.length > 0) {
    diagnostics.push(
      note(
        "malformed-span-id",
        malformed,
        `${malformed.length} span(s) carry a trace/span/parent id that is not W3C hex; the ingest boundary must reject their provenance via isProvenanceConsistent`,
      ),
    );
  }

  // --- tree, clamp, classification ----------------------------------------
  const tree = buildTree(accepted);

  if (tree.selfParentSpanIds.length > 0) {
    diagnostics.push(
      note("self-parent", tree.selfParentSpanIds, "parentSpanId equals spanId; treated as a root"),
    );
  }
  if (tree.orphanSpanIds.length > 0) {
    diagnostics.push(
      note(
        "orphan-span",
        tree.orphanSpanIds,
        "parentSpanId names a span not in this batch; treated as a tree root but NOT as a run boundary",
      ),
    );
  }
  if (tree.cycleSpanIds.length > 0) {
    diagnostics.push(
      note("parent-cycle", tree.cycleSpanIds, "parentSpanId cycle broken at the lowest span id in the cycle"),
    );
  }
  if (tree.skewClampedSpanIds.length > 0) {
    diagnostics.push(
      note(
        "clock-skew-clamped",
        tree.skewClampedSpanIds,
        "start/end instant clamped to preserve parent-before-child causality; a recorded timestamp was falsified, so affected events carry timing-approximated",
      ),
    );
  }
  if (tree.negativeDurationSpanIds.length > 0) {
    diagnostics.push(
      note("negative-duration", tree.negativeDurationSpanIds, "span ended before it started; end clamped up to start"),
    );
  }
  if (tree.precisionLossSpanIds.length > 0) {
    diagnostics.push(
      note(
        "timestamp-precision-loss",
        tree.precisionLossSpanIds,
        "timestamp arrived as a JS number beyond Number.MAX_SAFE_INTEGER; nanosecond resolution was already lost before this mapper saw it",
      ),
    );
  }

  const classes = new Map<string, SpanClass>();
  for (const span of tree.prepared) classes.set(span.spanId, classifySpan(span.input));

  const unsupportedVersion = tree.prepared
    .filter((s) => (classes.get(s.spanId) as SpanClass).kind === "unmapped" &&
      (classes.get(s.spanId) as { reason?: string }).reason === "unsupported-semconv-version")
    .map((s) => s.spanId);
  if (unsupportedVersion.length > 0) {
    diagnostics.push(
      note(
        "unsupported-semconv-version",
        unsupportedVersion,
        `span declares a semantic-convention version outside this mapper's supported set; recorded as otel.span.unmapped rather than read under the wrong rulebook`,
      ),
    );
  }

  // --- receivedAt ---------------------------------------------------------
  let receivedAt = options.receivedAt;
  if (receivedAt === undefined) {
    let latest = 1n;
    for (const span of tree.prepared) {
      const end = span.effEndNs ?? span.effStartNs;
      if (end > latest) latest = end;
    }
    receivedAt = Math.max(1, nanosToMs(latest));
    diagnostics.push(
      note(
        "received-at-defaulted",
        [],
        "no receivedAt supplied; provenance.receivedAt was defaulted to the trace's latest observed instant, a provable lower bound. A real ingest path MUST pass the server clock",
      ),
    );
    for (const span of tree.prepared) span.baseLoss.add("timing-approximated");
  }

  // --- RULING 4: run boundary ---------------------------------------------
  const byStart = [...tree.prepared].sort(
    (a, b) => cmpBigint(a.effStartNs, b.effStartNs) || cmpString(a.spanId, b.spanId),
  );
  const trueRoots = byStart.filter((s) => s.isTrueRoot);
  const allClosed = tree.prepared.every((s) => s.effEndNs !== undefined);
  const boundarySpan = (trueRoots[0] ?? byStart[0]) as PreparedSpan;
  const noTrueRoot = trueRoots.length === 0;

  if (trueRoots.length > 1) {
    diagnostics.push(
      note(
        "multiple-roots",
        trueRoots.map((r) => r.spanId),
        "more than one true root span; run.started is anchored to the earliest and the terminal event is withheld unless every span is closed",
      ),
    );
  }
  if (noTrueRoot) {
    diagnostics.push(
      note(
        "no-root-span",
        [boundarySpan.spanId],
        "no true root span in this batch (the root never arrived, or every span is an orphan); run.started is anchored to the earliest span and NO terminal event is emitted — the run's outcome is genuinely unknown",
      ),
    );
  }

  // `run.started` only once per run: a continuation batch must not restart it.
  const emitRunStarted = !isContinuation;
  // Terminal only when the outcome is actually known.
  const emitTerminal = !noTrueRoot && allClosed;
  if (!emitTerminal) {
    diagnostics.push(
      note(
        "trace-incomplete",
        tree.prepared.filter((s) => s.effEndNs === undefined).map((s) => s.spanId),
        "no terminal event emitted; the run stays in-progress per Event Log Rule 5",
      ),
    );
  }

  // A true-root span that is itself an inference or tool operation ALSO emits
  // its own pair inside the boundary — folding a root `chat` span into
  // run.started would drop a real LLM call.
  const boundaryClass = classes.get(boundarySpan.spanId) as SpanClass;
  const boundaryAlsoEmitsOwnPair =
    !emitRunStarted ||
    boundaryClass.kind === "inference" ||
    boundaryClass.kind === "tool" ||
    boundaryClass.kind === "retrieval" ||
    boundaryClass.kind === "memory" ||
    boundaryClass.kind === "unmapped";

  // --- emissions ----------------------------------------------------------
  const emissions: Emission[] = [];

  if (emitRunStarted) {
    emissions.push({
      role: "run-boundary-open",
      span: boundarySpan,
      instantNs: boundarySpan.effStartNs,
      rawInstantNs: boundarySpan.rawStartNs,
      depth: -1,
      phase: "open",
    });
  }

  for (const span of tree.prepared) {
    const cls = classes.get(span.spanId) as SpanClass;

    if (cls.kind === "unmapped") {
      // RULING 3: ONE event, never a drop. Placed at the span's start instant
      // so it sits in the timeline exactly where the work happened.
      emissions.push({
        role: "span-unmapped",
        span,
        instantNs: span.effStartNs,
        rawInstantNs: span.rawStartNs,
        depth: span.depth,
        phase: "open",
      });
      continue;
    }

    if (cls.kind === "memory") {
      // AFR memory events are single, with no close and no error slot.
      emissions.push({
        role: "span-single",
        span,
        instantNs: span.effStartNs,
        rawInstantNs: span.rawStartNs,
        depth: span.depth,
        phase: "open",
      });
      continue;
    }

    if (span === boundarySpan && !boundaryAlsoEmitsOwnPair) continue;

    emissions.push({
      role: "span-open",
      span,
      instantNs: span.effStartNs,
      rawInstantNs: span.rawStartNs,
      depth: span.depth,
      phase: "open",
    });
    if (span.effEndNs !== undefined) {
      emissions.push({
        role: "span-close",
        span,
        instantNs: span.effEndNs,
        rawInstantNs: span.rawEndNs ?? span.effEndNs,
        depth: span.depth,
        phase: "close",
      });
    }
  }

  if (emitTerminal) {
    // The trace's latest effective end, not merely the root's: with multiple
    // true roots the anchor's own end is not the trace's end.
    let latestEnd = boundarySpan.effEndNs ?? boundarySpan.effStartNs;
    for (const span of tree.prepared) {
      if (span.effEndNs !== undefined && span.effEndNs > latestEnd) latestEnd = span.effEndNs;
    }
    emissions.push({
      role: "run-boundary-close",
      span: boundarySpan,
      instantNs: latestEnd,
      rawInstantNs: boundarySpan.rawEndNs ?? latestEnd,
      depth: -1,
      phase: "close",
    });
  }

  emissions.sort(compareEmissions);

  // --- materialize --------------------------------------------------------
  const events: DerivedEventWrite[] = [];
  const unmapped: UnmappedSpanReport[] = [];
  const openIndexBySpanId = new Map<string, number>();
  let boundaryOpenIndex: number | undefined;
  let spansMapped = 0;
  let spansUnmapped = 0;

  const parentIndexFor = (span: PreparedSpan): number | undefined => {
    if (span.parentSpanId !== undefined) {
      const viaParent = openIndexBySpanId.get(span.parentSpanId);
      if (viaParent !== undefined) return viaParent;
    }
    return boundaryOpenIndex;
  };

  const push = (
    span: PreparedSpan,
    emission: Emission,
    type: DerivedEventType,
    payload: DerivedPayload,
    parentEventIndex: number | undefined,
    extraLoss: readonly OtelMappingLossReason[],
  ): number => {
    const index = events.length;
    const event: DerivedEventWrite = {
      type,
      sequenceNumber: priorLast + index + 1,
      timestamp: nanosToMs(emission.instantNs),
      payload,
      provenance: provenanceFor(span, traceId, receivedAt, extraLoss),
      spanId: span.spanId,
      temporalOrder: {
        instantUnixNano: emission.instantNs.toString(),
        rawInstantUnixNano: emission.rawInstantNs.toString(),
        phase: emission.phase,
        depth: emission.depth,
        spanId: span.spanId,
      },
    };
    if (parentEventIndex !== undefined) event.parentEventIndex = parentEventIndex;
    events.push(event);
    return index;
  };

  for (const emission of emissions) {
    const span = emission.span;
    const cls = classes.get(span.spanId) as SpanClass;
    const dropped = hasDroppedAttributes(span.attrs);
    const attrLoss: OtelMappingLossReason[] = dropped ? ["attributes-dropped"] : [];

    switch (emission.role) {
      case "run-boundary-open": {
        const config: Record<string, unknown> = {};
        const provider =
          readString(span.attrs, ATTR_PROVIDER_NAME) ?? readString(span.attrs, ATTR_SYSTEM);
        if (provider !== undefined) config[ATTR_PROVIDER_NAME] = provider;
        for (const key of [
          ATTR_AGENT_NAME, ATTR_AGENT_ID, ATTR_AGENT_DESCRIPTION,
          ATTR_CONVERSATION_ID, ATTR_REQUEST_MODEL,
        ]) {
          const value = readString(span.attrs, key);
          if (value !== undefined) config[key] = value;
        }
        config["otel.trace_id"] = traceId;
        config["otel.root_span_id"] = span.spanId;
        config["otel.span_name"] = span.input.name;

        // The agent's run INPUT is not on the span: content capture is opt-in
        // and, when present, describes the MODEL call, not the run. `null`
        // says "not recorded", which is true; `{}` would say "empty", which
        // is not.
        const index = push(
          span,
          emission,
          "run.started",
          { type: "run.started", input: null, config },
          undefined,
          // Always lossy: a synthesized run boundary is by construction our
          // interpretation, not something the agent reported.
          ["attributes-dropped", ...(noTrueRoot ? (["identity-synthesized"] as const) : [])],
        );
        boundaryOpenIndex = index;
        if (!boundaryAlsoEmitsOwnPair) openIndexBySpanId.set(span.spanId, index);
        break;
      }

      case "run-boundary-close": {
        const durationMs = nanosToMs(emission.instantNs - boundarySpan.effStartNs);
        if (span.status === "error") {
          const err = errorOf(span);
          push(
            span, emission, "run.failed",
            {
              type: "run.failed",
              error: err,
              duration_ms: durationMs,
              errorSummary: err.message.slice(0, MAX_ERROR_SUMMARY_LENGTH),
            },
            boundaryOpenIndex,
            ["attributes-dropped", "status-approximated"],
          );
        } else {
          push(
            span, emission, "run.completed",
            { type: "run.completed", output: null, duration_ms: durationMs },
            boundaryOpenIndex,
            ["attributes-dropped"],
          );
        }
        break;
      }

      case "span-unmapped": {
        spansUnmapped += 1;
        const bounded = boundAttributes(span.attrs);
        const reason = cls.kind === "unmapped" ? cls.reason : "no-matching-rule";
        const payload: DerivedPayload = {
          type: "otel.span.unmapped",
          spanName: span.input.name,
          spanKind: span.input.kind ?? "unspecified",
          reason,
          attributes: bounded.attributes,
          attributesTruncated: bounded.truncated,
          ...(span.input.status !== undefined
            ? { status: { code: span.status, ...(span.input.status.message !== undefined ? { message: span.input.status.message } : {}) } }
            : {}),
          ...(span.effEndNs !== undefined ? { durationMs: durationMsOf(span) } : {}),
        };
        const index = push(
          span, emission, "otel.span.unmapped", payload, parentIndexFor(span),
          // An unmapped span is BY DEFINITION a lossy mapping: the entire
          // typed reading of it was lost.
          ["attributes-dropped", ...(bounded.truncated ? (["payload-truncated"] as const) : [])],
        );
        openIndexBySpanId.set(span.spanId, index);
        unmapped.push({
          spanId: span.spanId,
          spanName: span.input.name,
          spanKind: span.input.kind ?? "unspecified",
          reason,
          eventIndex: index,
        });
        break;
      }

      case "span-single": {
        // memory.* — one event, no close. An ERRORED memory span becomes
        // `custom` carrying the error, because MemoryRead/WritePayload have no
        // error slot and dropping the message to fit the shape is exactly the
        // silent loss this module forbids.
        spansMapped += 1;
        const memory = cls.kind === "memory" ? cls : { write: true, operation: "unknown" };
        if (span.status === "error") {
          push(
            span, emission, "custom",
            {
              type: "custom",
              data: {
                otel: {
                  operation: memory.operation,
                  spanName: span.input.name,
                  error: errorOf(span),
                  note: "memory operation failed; AFR memory.* payloads carry no error field",
                },
              },
            },
            parentIndexFor(span),
            [...attrLoss, "status-approximated"],
          );
          break;
        }
        const index = push(
          span, emission,
          memory.write ? "memory.write" : "memory.read",
          memory.write
            ? { type: "memory.write", key: span.input.name, value: null }
            : { type: "memory.read", key: span.input.name, result: null },
          parentIndexFor(span),
          // Memory content has no GenAI attribute at all.
          ["attributes-dropped"],
        );
        openIndexBySpanId.set(span.spanId, index);
        break;
      }

      case "span-open": {
        spansMapped += 1;
        let index: number;
        if (cls.kind === "inference") {
          const messages = readMessages(span.attrs, ATTR_INPUT_MESSAGES);
          const temperature = readNumber(span.attrs, ATTR_REQUEST_TEMPERATURE);
          const maxTokens = readNumber(span.attrs, ATTR_REQUEST_MAX_TOKENS);
          index = push(
            span, emission, "llm.request",
            {
              type: "llm.request",
              model: readString(span.attrs, ATTR_REQUEST_MODEL) ?? "unknown",
              // Content capture is Opt-In and off by default, so `messages` is
              // usually empty. The `attributes-dropped` loss reason is what
              // stops that reading as "the model was called with no input".
              messages: messages ?? [],
              ...(temperature !== undefined ? { temperature } : {}),
              ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            },
            parentIndexFor(span),
            [...attrLoss, ...(messages === undefined ? (["attributes-dropped"] as const) : []),
             ...(cls.operation === "embeddings" ? (["status-approximated"] as const) : [])],
          );
        } else if (cls.kind === "tool") {
          const explicitCallId = readString(span.attrs, ATTR_TOOL_CALL_ID);
          const args = span.attrs[ATTR_TOOL_CALL_ARGUMENTS];
          index = push(
            span, emission, "tool.call",
            {
              type: "tool.call",
              name: readString(span.attrs, ATTR_TOOL_NAME) ?? span.input.name,
              input: args ?? null,
              call_id: explicitCallId ?? synthesizedCallId(span.spanId),
            },
            parentIndexFor(span),
            [...attrLoss, ...(args === undefined ? (["attributes-dropped"] as const) : []),
             ...(explicitCallId === undefined ? (["identity-synthesized"] as const) : [])],
          );
        } else if (cls.kind === "retrieval") {
          index = push(
            span, emission, "retrieval.query",
            {
              type: "retrieval.query",
              query: readString(span.attrs, ATTR_DATA_SOURCE_ID) ?? span.input.name,
              filters: {},
            },
            parentIndexFor(span),
            // The query TEXT has no GenAI span attribute; the data-source id is
            // the closest available identifier and is not the query.
            [...attrLoss, "attributes-dropped"],
          );
        } else {
          // opaque: invoke_agent / create_agent / invoke_workflow / plan.
          index = push(
            span, emission, "custom",
            {
              type: "custom",
              data: {
                otel: {
                  operation: cls.kind === "opaque" ? cls.operation : "unknown",
                  phase: "start",
                  spanName: span.input.name,
                  spanKind: span.input.kind ?? "unspecified",
                  agentName: readString(span.attrs, ATTR_AGENT_NAME),
                  agentId: readString(span.attrs, ATTR_AGENT_ID),
                  conversationId: readString(span.attrs, ATTR_CONVERSATION_ID),
                  systemInstructions: span.attrs[ATTR_SYSTEM_INSTRUCTIONS],
                },
              },
            },
            parentIndexFor(span),
            [...attrLoss, "status-approximated"],
          );
        }
        openIndexBySpanId.set(span.spanId, index);
        break;
      }

      case "span-close": {
        const parentEventIndex = openIndexBySpanId.get(span.spanId);
        if (cls.kind === "inference") {
          if (span.status === "error") {
            push(
              span, emission, "llm.error",
              { type: "llm.error", error: errorOf(span) },
              parentEventIndex,
              [...attrLoss, "status-approximated"],
            );
            break;
          }
          const inputTokens =
            readNumber(span.attrs, ATTR_USAGE_INPUT_TOKENS) ??
            readNumber(span.attrs, ATTR_USAGE_PROMPT_TOKENS);
          const outputTokens =
            readNumber(span.attrs, ATTR_USAGE_OUTPUT_TOKENS) ??
            readNumber(span.attrs, ATTR_USAGE_COMPLETION_TOKENS);
          const outMessages = readMessages(span.attrs, ATTR_OUTPUT_MESSAGES);
          const responseId = readString(span.attrs, ATTR_RESPONSE_ID);
          push(
            span, emission, "llm.response",
            {
              type: "llm.response",
              model:
                readString(span.attrs, ATTR_RESPONSE_MODEL) ??
                readString(span.attrs, ATTR_REQUEST_MODEL) ??
                "unknown",
              content:
                outMessages ?? (responseId === undefined ? null : { [ATTR_RESPONSE_ID]: responseId }),
              usage: {
                prompt_tokens: inputTokens ?? 0,
                completion_tokens: outputTokens ?? 0,
                total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
              },
              finish_reason:
                readStringArrayFirst(span.attrs, ATTR_RESPONSE_FINISH_REASONS) ?? "unknown",
            },
            parentEventIndex,
            [
              ...attrLoss,
              ...(inputTokens === undefined || outputTokens === undefined
                ? (["usage-partial"] as const)
                : []),
              ...(outMessages === undefined ? (["attributes-dropped"] as const) : []),
            ],
          );
          break;
        }

        if (cls.kind === "tool") {
          const callId = readString(span.attrs, ATTR_TOOL_CALL_ID) ?? synthesizedCallId(span.spanId);
          if (span.status === "error") {
            push(
              span, emission, "tool.error",
              { type: "tool.error", error: errorOf(span), call_id: callId },
              parentEventIndex,
              [...attrLoss, "status-approximated"],
            );
          } else {
            const result = span.attrs[ATTR_TOOL_CALL_RESULT];
            push(
              span, emission, "tool.result",
              {
                type: "tool.result",
                call_id: callId,
                output: result ?? null,
                duration_ms: durationMsOf(span),
              },
              parentEventIndex,
              [...attrLoss, ...(result === undefined ? (["attributes-dropped"] as const) : [])],
            );
          }
          break;
        }

        if (cls.kind === "retrieval") {
          if (span.status === "error") {
            push(
              span, emission, "custom",
              {
                type: "custom",
                data: {
                  otel: {
                    operation: "retrieval",
                    phase: "end",
                    spanName: span.input.name,
                    error: errorOf(span),
                    note: "retrieval failed; AFR retrieval.result carries no error field",
                  },
                },
              },
              parentEventIndex,
              [...attrLoss, "status-approximated"],
            );
            break;
          }
          push(
            span, emission, "retrieval.result",
            { type: "retrieval.result", results: [], duration_ms: durationMsOf(span) },
            parentEventIndex,
            // Retrieved documents have no GenAI span attribute at all.
            [...attrLoss, "attributes-dropped"],
          );
          break;
        }

        push(
          span, emission, "custom",
          {
            type: "custom",
            data: {
              otel: {
                operation: cls.kind === "opaque" ? cls.operation : "unknown",
                phase: "end",
                spanName: span.input.name,
                durationMs: durationMsOf(span),
                status: span.status,
                ...(span.status === "error" ? { error: errorOf(span) } : {}),
              },
            },
          },
          parentEventIndex,
          [...attrLoss, "status-approximated"],
        );
        break;
      }
    }
  }

  // --- RULING 3 self-check ------------------------------------------------
  const conservation = verifySpanConservation(accepted, events);
  if (!conservation.ok) {
    diagnostics.push(
      fatal(
        "span-dropped",
        conservation.missingSpanIds,
        `${conservation.missingSpanIds.length} accepted span(s) produced NO event. This is a mapper bug: every accepted span must be mapped or recorded as otel.span.unmapped. Refusing the batch rather than ingesting a trace with a silent hole.`,
      ),
    );
  }

  return {
    ok: !diagnostics.some((d) => d.fatal),
    traceId,
    events,
    runOpen: !emitTerminal,
    terminalType: emitTerminal ? (boundarySpan.status === "error" ? "run.failed" : "run.completed") : null,
    unmapped,
    rejected,
    diagnostics,
    stats: {
      spansIn,
      spansAccepted: accepted.length,
      spansMapped,
      spansUnmapped,
      spansRejected: rejected.length,
      eventsOut: events.length,
      clockSkewClamps: tree.skewClampedSpanIds.length,
    },
  };
}

/** Single-object form of {@link mapOtelSpansToEvents}'s arguments. */
export interface MapTraceInput extends MapOptions {
  spans: readonly OtelSpanInput[];
  /** Accepted as an alternative home for the prior-run state. */
  prior?: PriorRunState;
}

/**
 * Canonical entry point. Accepts EITHER shape:
 *
 *   mapTraceToEvents({ spans, receivedAt, lastSequenceNumber, knownSpanIds })
 *   mapTraceToEvents(spans, { receivedAt, lastSequenceNumber, knownSpanIds })
 *
 * Two shapes rather than one because the prior-run state is not optional
 * decoration — it is the parameter that makes multi-batch ingest possible at
 * all (see PART 3) — and a caller that has it should not have to guess which
 * arity carries it.
 */
export function mapTraceToEvents(
  inputOrSpans: MapTraceInput | readonly OtelSpanInput[],
  options: MapOptions = {},
): MapResult {
  if (Array.isArray(inputOrSpans)) {
    return mapOtelSpansToEvents(inputOrSpans as readonly OtelSpanInput[], options);
  }
  const input = inputOrSpans as MapTraceInput;
  const prior = input.prior;
  const resolved: MapOptions = {
    ...(input.receivedAt !== undefined ? { receivedAt: input.receivedAt } : {}),
    ...(input.lastSequenceNumber ?? prior?.lastSequenceNumber) !== undefined
      ? { lastSequenceNumber: input.lastSequenceNumber ?? prior?.lastSequenceNumber }
      : {},
    ...((input.knownSpanIds ?? prior?.knownSpanIds) !== undefined
      ? { knownSpanIds: input.knownSpanIds ?? prior?.knownSpanIds }
      : {}),
  };
  return mapOtelSpansToEvents(input.spans ?? [], resolved);
}

/**
 * RULING 3's enforcement mechanism, exported so it can be asserted in tests
 * AND run by the mapper on its own output.
 *
 * Every ACCEPTED span id must appear in at least one emitted event's
 * provenance. (Rejected spans — foreign trace, already known, duplicate — are
 * deliberately not covered: they are reported in `MapResult.rejected`, which
 * is a different claim.) This is what makes "a span vanished" a self-detected
 * failure rather than something a reviewer has to notice.
 */
export function verifySpanConservation(
  spans: readonly OtelSpanInput[],
  events: readonly DerivedEventWrite[],
): { ok: boolean; missingSpanIds: string[] } {
  const covered = new Set(events.map((e) => e.provenance.spanId));
  const missing = [...new Set(spans.map((s) => s.spanId))].filter((id) => !covered.has(id)).sort();
  return { ok: missing.length === 0, missingSpanIds: missing };
}

// ---------------------------------------------------------------------------
// FINDINGS — things this module CANNOT fix, recorded here rather than left
// for the next person to rediscover.
// ---------------------------------------------------------------------------
//
// F1. DETERMINISM and STABILITY are jointly unsatisfiable WITHOUT prior state.
//     Proved in PART 6, and it is the reason `MapOptions` exists. Given prior
//     state both hold: DETERMINISM within the batch (canonical order over the
//     span set) and STABILITY across batches (already-written spans are
//     REJECTED rather than re-emitted, and new spans are numbered from the
//     run's existing maximum). Without it, a mapper must choose, and this one
//     chooses DETERMINISM. Any ingest path that calls this without supplying
//     `lastSequenceNumber`/`knownSpanIds` on a continuation batch will produce
//     `SEQUENCE_CONFLICT` at `sdkCreateEvents` and lose the trace's tail
//     permanently.
//
// F2. `tests/unit/otel_ordering_adversarial.test.ts` remains the conformance
//     gate for this module. It carries a self-retiring meta-assertion
//     (`prior-run-state support is present, or the four dependent cases are
//     pinned as gaps`) that FAILS BY DESIGN once prior-state support lands —
//     which it now has. Retiring it is a deletion of the
//     `AWAITING_PRIOR_STATE` set in that file, and belongs to the suite's
//     owner, not here.
//
// F3. The suite's `replay/timestamp-non-decreasing-along-sequence` case names
//     a loss reason `inferred_timestamp`. No such member exists in
//     `OtelMappingLossReason`; the corresponding member is
//     `timing-approximated`, which is what this mapper sets. One of the two
//     should be renamed.
//
// F4. `convex/stale_runs.ts` flips a run to `timed_out` after
//     `STALE_RUN_TIMEOUT_MS` (24h) WITHOUT appending a terminal event, after
//     which every further append is rejected with `RUN_NOT_ACTIVE`. A slow or
//     long-running trace therefore loses its tail permanently, and an OTLP
//     exporter has no channel to learn it happened. This module does not
//     assume a trace can always be completed (`runOpen` exists precisely for
//     that), but the ceiling is a real constraint on the ingest path.
//
// F5. `sequenceNumber` no longer means temporal order on this path. Replay and
//     diff currently assume it does. `temporalOrder` +
//     `compareTemporalOrder` are the fix, but applying them is a change in
//     `apps/web/src/lib/replay/projection.ts` and the diff engine, which are
//     not this module's to make.
// ---------------------------------------------------------------------------
