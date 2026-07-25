// ===========================================================================
// ADR-007 — closing an OTel-derived run.
//
// THE PROBLEM THIS EXISTS TO SOLVE, stated as the counterexample that forced
// it. Take a root span A (t=0..100) with one child B (t=10..20). The mapper
// used to emit a terminal event whenever a batch contained a closed true root
// AND every span in that batch was closed. Partition the trace three ways:
//
//   {A,B} in one batch -> run.started, B's events, run.completed.
//   {A} then {B}       -> batch 1 sees a closed root in a fully-closed batch,
//                         so it emits run.started AND run.completed. B then
//                         arrives against a CLOSED run and is refused. B is
//                         lost permanently, and no update mutation exists to
//                         put it back.
//   {B} then {A}       -> no terminal in batch 1, a terminal in batch 2.
//
// Three different outcomes — different event SETS, not merely different
// sequence numbers — from one trace, decided by how the exporter's batch
// processor happened to flush. And one of them silently loses a span.
//
// THE DEFECT IS THE PREMISE, NOT THE CODE: "every span is closed" is a fact
// about a BATCH. It says nothing about a TRACE. OTel defines no
// trace-completion signal at all, so trace completion is not knowable — it can
// only be ESTIMATED, and the honest estimator is a quiet period.
//
// THE RULING:
//   1. The mapper never emits a terminal on the ingest path
//      (`terminalPolicy: "defer"`). Every batch is a pure append.
//   2. The first time a CLOSED TRUE ROOT is observed, the ingest records it on
//      the run (`otelRoot`) and schedules this settle mutation.
//   3. This mutation appends the terminal ONCE, only after
//      OTEL_TRACE_SETTLE_MS has passed with no further appends. If spans
//      arrived in the meantime it reschedules itself instead.
//
// The result converges: the set of span-derived events is identical under
// every partition and every permutation of the batches, and exactly one
// terminal is appended after the trace goes quiet.
//
// WHAT STILL DOES NOT CONVERGE, stated rather than hidden: the SYNTHESIZED
// `run.started` is anchored to the earliest span in the FIRST batch, so its
// timestamp and `provenance.spanId` depend on which spans arrived first. That
// is not fixable — see the mapper's FINDINGS F1, where determinism and
// stability over an append-only log are proved jointly unsatisfiable without
// prior state, and prior state is exactly what "which batch came first" is. The
// event is flagged `identity-synthesized` when it is not anchored on a true
// root, so the weakness is recorded on the row itself.
//
// A ROOT THAT NEVER CLOSES never schedules a settle, so the run stays
// `running` — which Event Log Rule 5 already defines as in-progress — until
// the 24h stale sweep (convex/stale_runs.ts) flips it to `timed_out`. That is
// the honest outcome: the trace's outcome is genuinely unknown.
// ===========================================================================

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalMutation } from "./_generated/server.js";
import {
  MAPPER_VERSION,
  SEMCONV_VERSION,
  type OtelMappingLossReason,
} from "./helpers/otel_mapping.js";
import { MAX_EVENTS_PER_RUN, OTEL_TRACE_SETTLE_MS } from "./helpers/pagination.js";
import {
  buildSearchText,
  extractErrorMessage,
  tallyDerivedOrdering,
} from "./helpers/run_fields.js";

import type { Id } from "./_generated/dataModel.js";

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(["run.completed", "run.failed"]);
const NANOS_PER_MS = 1_000_000n;

const _runEvalsThenEvaluateAlertsRef = makeFunctionReference<"action">(
  "alert_engine:runEvalsThenEvaluateAlerts",
);
const _generateRunExplanationRef = makeFunctionReference<"action">(
  "run_explanations:generateRunExplanation",
);
const _settleRef = makeFunctionReference<"mutation">("otel_settle:settleOtelTrace");

/**
 * Append the terminal event for a derived run whose trace has gone quiet.
 *
 * INTERNAL. There is no external caller and there must not be one: this writes
 * a `run.completed`/`run.failed` that no instrumented process reported, and
 * exposing it would let a caller close somebody's run out from under an
 * in-flight trace.
 *
 * IDEMPOTENT AND SELF-RESCHEDULING. Every exit path is safe to run twice, and
 * the Convex scheduler is at-least-once, so that is a requirement rather than
 * a nicety.
 */
export const settleOtelTrace = internalMutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);

    // Not a derived run, gone (retention/erasure), or already closed by any
    // route. All three are ordinary no-ops, not errors — a scheduled job that
    // throws on a deleted run just retries forever.
    if (!run || run.otelTraceId === undefined) return { settled: false, reason: "not-derived" };
    if (run.status !== "running") return { settled: false, reason: "already-closed" };

    const root = run.otelRoot;
    if (root === undefined) {
      // The root was never observed closed, so the trace's outcome is unknown.
      // Inventing a terminal here would be asserting an outcome we do not have.
      return { settled: false, reason: "no-closed-root" };
    }

    // THE QUIET-PERIOD TEST. Spans arriving after the settle was scheduled push
    // this forward, so an actively-arriving trace is never closed underneath
    // itself. Rescheduling rather than closing is what makes the settle window
    // "quiet for N", not "N since the root closed".
    const lastAppend = run.otelLastAppendAt ?? run.startedAt;
    const quietFor = Date.now() - lastAppend;
    if (quietFor < OTEL_TRACE_SETTLE_MS) {
      await ctx.scheduler.runAfter(OTEL_TRACE_SETTLE_MS - quietFor, _settleRef, {
        runId: args.runId,
      });
      return { settled: false, reason: "still-arriving" };
    }

    const latest = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .order("desc")
      .first();

    // Already terminal (a concurrent settle, or a redelivery that raced).
    if (latest !== null && TERMINAL_EVENT_TYPES.has(latest.type)) {
      return { settled: false, reason: "already-terminal" };
    }
    const sequenceNumber = (latest?.sequenceNumber ?? 0) + 1;
    if (sequenceNumber > MAX_EVENTS_PER_RUN) {
      // The run filled up. Close the status without a terminal event rather
      // than throwing forever; the run is honestly marked, and the absent
      // terminal is itself the signal that the log was truncated by the cap.
      await ctx.db.patch(args.runId, { status: "timed_out", endedAt: Date.now() });
      return { settled: false, reason: "event-limit" };
    }

    // TIMESTAMP. The root's own end, but never earlier than the LATEST INSTANT
    // ANYWHERE IN THE RUN — Event Log Rule 5 requires the terminal to be last,
    // and under the temporal ordering this path introduces "last" means last by
    // instant, not last by sequence number.
    //
    // THE MAX MUST BE OVER ALL EVENTS, NOT THE LAST-APPENDED ONE. Taking
    // `latest.temporalOrder` — where `latest` is the highest SEQUENCE NUMBER,
    // i.e. the event appended most recently — made the terminal's instant
    // depend on how the exporter partitioned the trace. Two true roots
    // r(0-10ms) and s(20-30ms): delivered together the terminal lands at 30ms;
    // delivered as {s} then {r} the last-appended event is r's close at 10ms
    // and the terminal landed at 10ms, BEFORE the s events already in the log.
    // The terminal then sorts before the events it terminates and replay
    // renders a negative elapsed span — the exact defect this `max` was added
    // to prevent, defeated by maxing against the wrong event.
    //
    // `runs.otelMaxInstantNano` is a running max over every appended event, so
    // it is a function of the event SET, which converges. The scan-free
    // alternative it replaces is not available at the MAX_EVENTS_PER_RUN
    // ceiling.
    const rootEndNs = BigInt(root.endUnixNano);
    const maxEventNs =
      run.otelMaxInstantNano !== undefined
        ? BigInt(run.otelMaxInstantNano)
        : latest?.temporalOrder !== undefined
          ? BigInt(latest.temporalOrder.instantUnixNano)
          : BigInt(Math.trunc(latest?.timestamp ?? run.startedAt)) * NANOS_PER_MS;
    const instantNs = rootEndNs > maxEventNs ? rootEndNs : maxEventNs;
    const timestamp = Number(instantNs / NANOS_PER_MS);

    const failed = root.status === "error";
    const type = failed ? "run.failed" : "run.completed";
    const duration_ms = Math.max(0, timestamp - run.startedAt);

    const payload = failed
      ? {
          type: "run.failed" as const,
          error: {
            message: `Trace root span "${root.spanName}" reported status ERROR`,
            code: "otel.root.error",
          },
          duration_ms,
        }
      : { type: "run.completed" as const, output: null, duration_ms };

    // LOSS ACCOUNTING. This event is SYNTHESIZED — no span reported it. OTel
    // has no run concept, so the terminal is our inference from the root span's
    // status plus a quiet period, and both facts are recorded on the row:
    // `identity-synthesized` (we invented the event) and `timing-approximated`
    // (its instant is a bound, not a measurement).
    const lossReasons: OtelMappingLossReason[] = ["identity-synthesized", "timing-approximated"];

    const terminalEvent = {
      runId: args.runId,
      orgId: run.orgId,
      type,
      sequenceNumber,
      timestamp,
      payload,
      provenance: {
        source: "otel" as const,
        traceId: run.otelTraceId,
        spanId: root.spanId,
        spanName: root.spanName,
        semconvVersion: SEMCONV_VERSION,
        mapperVersion: MAPPER_VERSION,
        lossy: true,
        lossReasons,
        receivedAt: Date.now(),
      },
      // depth -1 and phase "close" put this outside every span's close at the
      // same instant, exactly as the mapper's own run boundary would have.
      temporalOrder: {
        instantUnixNano: instantNs.toString(),
        rawInstantUnixNano: root.endUnixNano,
        phase: "close" as const,
        depth: -1,
        spanId: root.spanId,
      },
    };
    await ctx.db.insert("events", terminalEvent);

    const patch: {
      status: "completed" | "failed";
      endedAt: number;
      searchText?: string;
      derivedEventCount?: number;
      otelUnkeyedDerivedCount?: number;
    } = { status: failed ? "failed" : "completed", endedAt: timestamp };

    // THE SECOND WRITE SITE. This is a derived event like any other, so it must
    // be counted like any other — through the SAME shared tally the ingest
    // batch uses. A hand-rolled `+ 1` here is the mirroring failure that makes
    // a denormalized counter untrustworthy: it would silently stop matching
    // the log the first time either side changed.
    const tally = tallyDerivedOrdering([terminalEvent]);
    if (tally.derived > 0) {
      patch.derivedEventCount = (run.derivedEventCount ?? 0) + tally.derived;
    }
    if (tally.unkeyed > 0) {
      patch.otelUnkeyedDerivedCount = (run.otelUnkeyedDerivedCount ?? 0) + tally.unkeyed;
    }
    if (failed) {
      const errorMessage = extractErrorMessage(payload);
      if (errorMessage) patch.searchText = buildSearchText([run.searchText, errorMessage]);
    }
    await ctx.db.patch(args.runId, patch);

    // Same downstream wiring as the SDK terminal path, so a derived run is not
    // second-class: evals + alerts always, explanations for failures only.
    await ctx.scheduler.runAfter(0, _runEvalsThenEvaluateAlertsRef, { runId: args.runId });
    if (failed) {
      await ctx.scheduler.runAfter(0, _generateRunExplanationRef, { runId: args.runId });
    }

    return { settled: true, reason: type, sequenceNumber };
  },
});

/** Exposed for the ingest path, which schedules the first settle. */
export const SETTLE_FUNCTION_REF = _settleRef;

export type SettleRunId = Id<"runs">;
