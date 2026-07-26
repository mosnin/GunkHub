// ---------------------------------------------------------------------------
// Service layer for OTLP trace ingest.
//
// ===========================================================================
// SEAM STATUS: SETTLED, AND IT AGREES WITH RULING 1 BELOW.
// ===========================================================================
//
// `convex/otel_ingest.ts` `otelIngestSpans` (Team A) landed while this route
// was being built. Its args are
// `{ apiKeyHash, traceId, agentId, agentVersion?, spans }` — it takes
// NORMALIZED SPANS and runs the mapper itself, which is exactly what RULING 1
// argued for below, arrived at independently on the other side of the
// boundary. This module forwards to it and nothing here re-derives events.
//
// ---------------------------------------------------------------------------
// RULING 1 — THE MAPPER RUNS IN CONVEX, NOT HERE. THIS ROUTE FORWARDS SPANS.
// ---------------------------------------------------------------------------
//
// `packages/contracts/src/api.ts`'s `IngestOtelSpansRequest` takes
// `OtelDerivedEventWrite[]` — events that have ALREADY been mapped and already
// carry an assigned `sequenceNumber`. Implementing that literally means the web
// layer calls the mapper. It cannot, safely, for three independent reasons:
//
//   (a) CORRECTNESS. `mapTraceToEvents` requires `PriorRunState`
//       (`lastSequenceNumber`, `knownSpanIds`) to extend an append-only log
//       across batches — the mapper's own FINDING F1 says a caller that omits
//       it "will produce SEQUENCE_CONFLICT at sdkCreateEvents and lose the
//       trace's tail permanently." Reading that state from the web layer means
//       read-then-write ACROSS A TRANSACTION BOUNDARY. Two concurrent OTLP
//       batches for one trace — which is the NORMAL case, since exporters ship
//       batches concurrently — both read the same `lastSequenceNumber` and both
//       compute the same numbers. On an append-only log that is not a lost
//       update; it is permanent corruption. Only a Convex mutation can read the
//       prior state and append in one transaction.
//
//   (b) BOUNDARY. `apps/web` may not import from `convex/` (CLAUDE.md file
//       ownership map). The mapper lives in `convex/helpers/`.
//
//   (c) TRUST. `provenance.mapperVersion` is the field that later identifies
//       which stored events a discovered mapper bug contaminated. If the
//       version is stamped by whichever web instance happened to serve the
//       request, that claim is about the web deployment, not about the code
//       that did the mapping. It has to be stamped where the mapping happens.
//
// So `IngestOtelSpansRequest` in `packages/contracts/src/api.ts` — which takes
// pre-mapped `OtelDerivedEventWrite[]` — describes a design NEITHER side
// implements. It is now stale contract, and correcting it is Team A's; this
// module targets the real mutation. Written up in the report.
//
// ---------------------------------------------------------------------------
// RULING 2 — ONE CALL PER TRACE.
// ---------------------------------------------------------------------------
//
// One OTLP export request may carry spans from many traces; the mapper is
// per-trace (`MapResult.traceId` is singular, and it REJECTS spans whose trace
// id does not match with reason `foreign-trace`). The route therefore groups by
// `traceId` and calls this once per group. Grouping in the route rather than in
// Convex keeps the mutation's unit of work equal to its unit of transaction:
// one trace, one run, one contiguous sequence range.
//
// ---------------------------------------------------------------------------
// THE SEAM WARNING APPLIES IN FULL.
// ---------------------------------------------------------------------------
//
// `convexFunctions.ts` refs are hand-maintained strings with NO structural
// typecheck against the real handler args; seven runtime bugs have shipped
// through this seam. Two defences are in place here:
//
//   * Every param this module declares is forwarded in ONE inline object
//     literal, and `tests/unit/otlp_route_ingest_params.test.ts` is table-driven
//     over `keyof OtelIngestSpansParams` — adding a param to the interface
//     without adding it to the spread fails that test, in the same style as
//     `tests/unit/api_v1_failure_patterns_params.test.ts`.
//   * The ref is used DIRECTLY — `convex.otel_ingest.otelIngestSpans` — with
//     the args as one inline object literal, which is what makes
//     `scripts/check-convex-refs.ts` able to kind-check and arg-check this
//     call site at all. An earlier draft probed the ref through
//     `convex.otel_ingest?.otelIngestSpans` to fail soft if the ref were ever
//     deleted; that indirection made the usage UNRESOLVABLE to the checker and
//     tripped `tests/unit/convex_function_refs.test.ts`, which forbids
//     residual gaps outright. The repo's ruling is the right one: a ref that
//     can be statically checked is worth more than a runtime guard against a
//     deletion that `./scripts/validate.sh` already blocks.
// ---------------------------------------------------------------------------

import type { NormalizedSpan } from '@/lib/otel/types'

import { convex } from '@/lib/convexFunctions'
import { getPublicClient, withConvexTimeout } from '@/lib/convexServer'


/**
 * Args for the mutation this route needs: `otel_ingest:otelIngestSpans`.
 *
 * Every field is load-bearing:
 *
 *  - `apiKeyHash` — the ONLY authentication input. Convex resolves the key,
 *    checks it is not revoked/expired, checks the `ingest:write` scope, and
 *    derives the org from it. The web layer never learns the org, which is
 *    what makes cross-org ingest structurally impossible rather than
 *    carefully avoided: there is no org parameter to get wrong.
 *
 *  - `traceId` — the trace all `spans` belong to. Convex resolves it to a run
 *    WITHIN the key's org (creating one on first sight), so the same trace id
 *    sent under two different orgs' keys yields two unrelated runs and neither
 *    can observe the other.
 *
 *  - `spans` — normalized spans, NOT mapped events. See RULING 1.
 *
 * There is deliberately NO `receivedAt` param. The mutation takes the ingest
 * clock itself (`Date.now()` inside the transaction) and stamps it onto every
 * derived event's `provenance.receivedAt`. Passing a web-layer clock would let
 * a value from a differently-skewed machine masquerade as the backend's own
 * observation — the exact confusion `receivedAt` exists to prevent.
 */
export interface OtelIngestSpansParams {
  traceId: string
  /**
   * The Convex `agents` document id this trace's run belongs to.
   *
   * REQUIRED, and deliberately NOT derived from span attributes. The mutation's
   * RULING 5 refuses to invent it: deriving an agent from `gen_ai.agent.name`
   * would spray a new Agent row per distinct agent string into the org's
   * namespace, keyed on a Development-stability attribute most instrumentation
   * omits. The transport knows which agent an exporter is configured for; the
   * span does not.
   *
   * The route reads it from the `x-afr-agent-id` request header, which is the
   * only channel an OTLP exporter offers — `OTEL_EXPORTER_OTLP_HEADERS` sets
   * arbitrary headers and nothing else about the request is ours to shape.
   */
  agentId: string
  /** Optional. Absent means the run has no version — never synthesized. */
  agentVersion?: string
  spans: NormalizedSpan[]
}

/**
 * What the mutation returns.
 *
 * `rejected` is spans NOT recorded — never conflated with spans recorded as
 * `otel.span.unmapped`, which ARE in `eventIds` and counted in
 * `unmappedCount`. The route sums `rejected.length` into the OTLP
 * `partial_success.rejected_spans`; an unmapped span is a SUCCESS and must not
 * be counted there, or every export of a span we do not have a rule for looks
 * to the operator like data loss.
 */
export interface OtelIngestSpansResult {
  runId: string
  runCreated: boolean
  eventIds: string[]
  unmappedCount: number
  rejected: Array<{ spanId: string; reason: string }>
  diagnostics: Array<{ code: string; fatal: boolean; spanIds: string[]; message: string }>
  runOpen: boolean
  terminalType: string | null
  firstSequenceNumber: number | null
  lastSequenceNumber: number | null
  stats: {
    spansIn: number
    spansAccepted: number
    spansMapped: number
    spansUnmapped: number
    spansRejected: number
    eventsOut: number
    clockSkewClamps: number
  }
}

/**
 * Forward one trace's spans to Convex.
 *
 * Throws whatever the mutation throws. The route classifies those: named AFR
 * codes are permanent and become non-retryable statuses, anything unrecognized
 * becomes a retryable 503 — see `statusForBackendError` in
 * apps/web/app/api/v1/traces/route.ts.
 */
export async function ingestOtelSpans(
  apiKeyHash: string,
  params: OtelIngestSpansParams,
): Promise<OtelIngestSpansResult> {
  const client = getPublicClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await withConvexTimeout(
    client.mutation(convex.otel_ingest.otelIngestSpans, {
      apiKeyHash,
      traceId: params.traceId,
      agentId: params.agentId,
      spans: params.spans,
      ...(params.agentVersion !== undefined && { agentVersion: params.agentVersion }),
    }),
  )
  return result as OtelIngestSpansResult
}
