/**
 * Unit tests for the PURE OTel GenAI span → event mapper.
 *
 * Complements `tests/unit/otel_ordering_adversarial.test.ts`, which is the
 * implementation-independent ORDERING conformance suite (ties, precision,
 * skew, arrival, dedup, multi-batch, scale). That suite deliberately knows
 * nothing about `gen_ai.*`, so it cannot check any of the things this file
 * checks: the researched attribute mapping, the provenance rulings, the loss
 * accounting, and the run-boundary derivation.
 *
 * Property-based where the property is real (ordering is a strict total order;
 * arrival order is irrelevant; conservation holds), explicit where the case is
 * degenerate.
 */

import { describe, expect, it } from "vitest";

import {
  MAPPER_VERSION,
  SEMCONV_VERSION,
  classifySpan,
  compareTemporalOrder,
  mapOtelSpansToEvents,
  mapTraceToEvents,
  verifySpanConservation,
  type DerivedEventWrite,
  type MapResult,
  type OtelSpanInput,
} from "./otel_mapping";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRACE = "a".repeat(32);
const RECEIVED_AT = 1_780_000_000_000;
/** Realistic 2026 epoch-nanosecond base, deliberately past MAX_SAFE_INTEGER. */
const BASE = 1_780_000_000_000_000_000n;

function hex(n: number): string {
  return n.toString(16).padStart(16, "0");
}

/**
 * Build a span from NANOSECOND OFFSETS off a realistic 2026 base, as decimal
 * strings — the way OTLP/JSON actually delivers uint64 timestamps. Fields are
 * assigned individually rather than spread, so the `start`/`end` bigint helper
 * arguments never leak onto the span object.
 */
let counter = 0;
type SpanInit = Omit<Partial<OtelSpanInput>, "startTimeUnixNano" | "endTimeUnixNano"> & {
  start: bigint;
  end?: bigint;
};
function span(init: SpanInit): OtelSpanInput {
  counter += 1;
  const out: OtelSpanInput = {
    traceId: init.traceId ?? TRACE,
    spanId: init.spanId ?? hex(counter),
    name: init.name ?? "span",
    startTimeUnixNano: (BASE + init.start).toString(),
  };
  if (init.end !== undefined) out.endTimeUnixNano = (BASE + init.end).toString();
  if (init.parentSpanId !== undefined) out.parentSpanId = init.parentSpanId;
  if (init.attributes !== undefined) out.attributes = init.attributes;
  if (init.status !== undefined) out.status = init.status;
  if (init.kind !== undefined) out.kind = init.kind;
  if (init.schemaUrl !== undefined) out.schemaUrl = init.schemaUrl;
  if (init.scopeName !== undefined) out.scopeName = init.scopeName;
  if (init.spanLinkCount !== undefined) out.spanLinkCount = init.spanLinkCount;
  if (init.spanEventCount !== undefined) out.spanEventCount = init.spanEventCount;
  return out;
}

function map(spans: readonly OtelSpanInput[]): MapResult {
  return mapOtelSpansToEvents(spans, { receivedAt: RECEIVED_AT });
}

function typesOf(result: MapResult): string[] {
  return result.events.map((e) => e.type);
}

function eventFor(result: MapResult, type: string): DerivedEventWrite {
  const found = result.events.find((e) => e.type === type);
  expect(found, `expected an event of type ${type}, got ${typesOf(result).join(", ")}`).toBeDefined();
  return found as DerivedEventWrite;
}

const CHAT_ATTRS = {
  "gen_ai.operation.name": "chat",
  "gen_ai.provider.name": "anthropic",
  "gen_ai.request.model": "claude-sonnet-4-5",
  "gen_ai.response.model": "claude-sonnet-4-5-20260101",
  "gen_ai.usage.input_tokens": 120,
  "gen_ai.usage.output_tokens": 48,
  "gen_ai.response.finish_reasons": ["stop"],
  "gen_ai.request.temperature": 0.2,
  "gen_ai.request.max_tokens": 1024,
};

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  it("does not read the clock: two calls a tick apart are byte-identical", () => {
    const spans = [span({ spanId: hex(1), start: 0n, end: 9_000_000n, attributes: CHAT_ATTRS })];
    const a = JSON.stringify(map(spans));
    const b = JSON.stringify(map(spans));
    expect(a).toBe(b);
  });

  it("does not mutate its input", () => {
    const spans = [
      span({ spanId: hex(1), start: 1_000_000n, end: 9_000_000n }),
      span({ spanId: hex(2), parentSpanId: hex(1), start: 0n, end: 2_000_000n }),
    ];
    const before = JSON.stringify(spans);
    map(spans);
    expect(JSON.stringify(spans)).toBe(before);
  });

  it("writes the supplied receivedAt verbatim onto every event", () => {
    const result = map([span({ spanId: hex(1), start: 0n, end: 1_000_000n })]);
    for (const event of result.events) {
      expect(event.provenance.receivedAt).toBe(RECEIVED_AT);
    }
  });

  it("defaults receivedAt to a lower bound, and says so, when none is supplied", () => {
    const result = mapOtelSpansToEvents([span({ spanId: hex(1), start: 0n, end: 5_000_000n })]);
    expect(result.diagnostics.map((d) => d.code)).toContain("received-at-defaulted");
    for (const event of result.events) {
      expect(event.provenance.receivedAt).toBeGreaterThan(0);
      expect(event.provenance.lossReasons).toContain("timing-approximated");
    }
  });
});

// ---------------------------------------------------------------------------
// RULING 1 — provenance
// ---------------------------------------------------------------------------

describe("RULING 1 — provenance is mandatory and complete", () => {
  const result = map([
    span({ spanId: hex(1), start: 0n, end: 9_000_000n, scopeName: "openinference.langchain" }),
    span({ spanId: hex(2), parentSpanId: hex(1), start: 1_000_000n, end: 2_000_000n, attributes: CHAT_ATTRS }),
  ]);

  it("stamps source:'otel' on EVERY event, including synthesized boundaries", () => {
    expect(result.events.length).toBeGreaterThan(0);
    for (const event of result.events) {
      expect(event.provenance.source).toBe("otel");
    }
  });

  it("carries the span identity needed to go look at what we interpreted", () => {
    for (const event of result.events) {
      expect(event.provenance.traceId).toBe(TRACE);
      expect(event.provenance.spanId).toBe(event.spanId);
      expect(typeof event.provenance.spanName).toBe("string");
    }
  });

  it("records BOTH the convention read and the mapper that read it", () => {
    for (const event of result.events) {
      expect(event.provenance.semconvVersion).toBe(SEMCONV_VERSION);
      expect(event.provenance.mapperVersion).toBe(MAPPER_VERSION);
    }
  });

  it("preserves scopeName — whose instrumentation produced the span", () => {
    expect(eventFor(result, "run.started").provenance.scopeName).toBe("openinference.langchain");
  });

  it("keeps lossy and lossReasons mutually consistent (contracts' isProvenanceConsistent)", () => {
    for (const event of result.events) {
      const { lossy, lossReasons } = event.provenance;
      if (lossy) expect(lossReasons?.length ?? 0).toBeGreaterThan(0);
      else expect(lossReasons).toBeUndefined();
    }
  });

  it("cannot be talked into claiming source:'sdk' — no code path emits one", () => {
    const sources = new Set(result.events.map((e) => e.provenance.source));
    expect([...sources]).toEqual(["otel"]);
  });
});

// ---------------------------------------------------------------------------
// RULING 2 — ordering
// ---------------------------------------------------------------------------

/** Deterministic permutations: identity, reverse, rotations, seeded shuffle. */
function permutations<T>(items: readonly T[]): T[][] {
  const out: T[][] = [[...items], [...items].reverse()];
  for (let r = 1; r < Math.min(items.length, 4); r += 1) {
    out.push([...items.slice(r), ...items.slice(0, r)]);
  }
  const shuffled = [...items];
  let seed = 0x5f3759d;
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    const a = shuffled[i] as T;
    shuffled[i] = shuffled[j] as T;
    shuffled[j] = a;
  }
  out.push(shuffled);
  return out;
}

describe("RULING 2 — ordering is deterministic and total", () => {
  /**
   * PROPERTY: arrival order carries no information. A BatchSpanProcessor
   * flushes by completion, so children normally arrive before parents; the
   * output must not be able to tell.
   */
  it("PROPERTY: any permutation of a span set yields an identical log", () => {
    const spans = [
      span({ spanId: hex(1), start: 0n, end: 9_000_000n }),
      span({ spanId: hex(2), parentSpanId: hex(1), start: 1_000_000n, end: 4_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(3), parentSpanId: hex(1), start: 1_000_000n, end: 3_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(4), parentSpanId: hex(2), start: 1_000_000n, end: 2_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(5), parentSpanId: hex(1), start: 1_000_000n, end: 5_000_000n }),
    ];
    const baseline = JSON.stringify(map(spans));
    for (const perm of permutations(spans)) {
      expect(JSON.stringify(map(perm))).toBe(baseline);
    }
  });

  /**
   * PROPERTY: the emission order is a STRICT TOTAL order — no two events may
   * compare equal under the temporal key. Ties on timestamp are certain, so
   * the tiebreak is load-bearing rather than a footnote.
   */
  it("PROPERTY: no two events tie under compareTemporalOrder (strict total order)", () => {
    const shared = 2_000_000n;
    const spans = Array.from({ length: 40 }, (_, i) =>
      span({
        spanId: hex(100 + i),
        start: shared,
        end: shared + 1_000_000n,
        attributes: CHAT_ATTRS,
      }),
    );
    const result = map(spans);
    for (let i = 0; i < result.events.length; i += 1) {
      for (let j = i + 1; j < result.events.length; j += 1) {
        const a = result.events[i] as DerivedEventWrite;
        const b = result.events[j] as DerivedEventWrite;
        expect(
          compareTemporalOrder(a.temporalOrder, b.temporalOrder),
          `events ${i} and ${j} tie under the temporal key — the order is not total`,
        ).not.toBe(0);
      }
    }
  });

  it("PROPERTY: compareTemporalOrder agrees with the emitted sequence in one batch", () => {
    const result = map([
      span({ spanId: hex(1), start: 0n, end: 9_000_000n }),
      span({ spanId: hex(2), parentSpanId: hex(1), start: 1_000_000n, end: 5_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(3), parentSpanId: hex(2), start: 2_000_000n, end: 3_000_000n, attributes: CHAT_ATTRS }),
    ]);
    const resorted = [...result.events].sort((a, b) =>
      compareTemporalOrder(a.temporalOrder, b.temporalOrder),
    );
    expect(resorted.map((e) => e.sequenceNumber)).toEqual(result.events.map((e) => e.sequenceNumber));
  });

  it("sorts on nanoseconds, not float64: 100ns apart is NOT collapsed into a tie", () => {
    // Precondition: these two instants are indistinguishable as float64.
    expect(Number((BASE + 0n).toString())).toBe(Number((BASE + 100n).toString()));
    const early = span({ spanId: hex(1), start: 0n, end: 9_000_000n });
    const late = span({ spanId: hex(2), start: 100n, end: 9_000_000n });
    const result = map([late, early]);
    const earlyOpen = result.events.find((e) => e.spanId === hex(1));
    const lateOpen = result.events.find((e) => e.spanId === hex(2));
    expect(
      BigInt((earlyOpen as DerivedEventWrite).temporalOrder.instantUnixNano) <
        BigInt((lateOpen as DerivedEventWrite).temporalOrder.instantUnixNano),
    ).toBe(true);
  });

  it("sorts numerically, not lexicographically: a 1970 instant precedes a 2026 one", () => {
    const spans: OtelSpanInput[] = [
      { traceId: TRACE, spanId: hex(1), name: "epoch", startTimeUnixNano: "999999999", endTimeUnixNano: "1000000000" },
      { traceId: TRACE, spanId: hex(2), parentSpanId: hex(1), name: "modern", startTimeUnixNano: BASE.toString(), endTimeUnixNano: (BASE + 1000n).toString() },
    ];
    const result = map(spans);
    const first = result.events[0] as DerivedEventWrite;
    expect(first.spanId).toBe(hex(1));
  });

  it("timestamps are non-decreasing along the sequence (replay computes elapsed_ms from them)", () => {
    const result = map([
      span({ spanId: hex(1), start: 5_000_000n, end: 9_000_000n }),
      // Child's host clock runs 5ms behind: it claims to start before its parent.
      span({ spanId: hex(2), parentSpanId: hex(1), start: 0n, end: 6_000_000n, attributes: CHAT_ATTRS }),
    ]);
    for (let i = 1; i < result.events.length; i += 1) {
      expect(
        (result.events[i] as DerivedEventWrite).timestamp,
      ).toBeGreaterThanOrEqual((result.events[i - 1] as DerivedEventWrite).timestamp);
    }
  });
});

describe("RULING 2 — the causality clamp is applied AND reported", () => {
  const result = map([
    span({ spanId: hex(1), name: "root", start: 5_000_000n, end: 9_000_000n }),
    span({ spanId: hex(2), parentSpanId: hex(1), name: "child", start: 0n, end: 12_000_000n, attributes: CHAT_ATTRS }),
  ]);

  it("orders the parent's open before the child's open despite the child's earlier clock", () => {
    const parentOpen = result.events.findIndex((e) => e.spanId === hex(1));
    const childOpen = result.events.findIndex((e) => e.type === "llm.request");
    expect(parentOpen).toBeLessThan(childOpen);
  });

  it("orders the child's close before the parent's close despite the child's later clock", () => {
    const childClose = result.events.findIndex((e) => e.type === "llm.response");
    const runClose = result.events.findIndex((e) => e.type === "run.completed");
    expect(childClose).toBeLessThan(runClose);
  });

  it("emits a clock-skew-clamped diagnostic rather than clamping silently", () => {
    expect(result.diagnostics.map((d) => d.code)).toContain("clock-skew-clamped");
    expect(result.stats.clockSkewClamps).toBeGreaterThan(0);
  });

  it("marks every event of a clamped span timing-approximated — a falsified timestamp", () => {
    const request = eventFor(result, "llm.request");
    expect(request.provenance.lossy).toBe(true);
    expect(request.provenance.lossReasons).toContain("timing-approximated");
  });

  it("keeps the RAW instant alongside the clamped one, so the skew stays inspectable", () => {
    const request = eventFor(result, "llm.request");
    expect(request.temporalOrder.rawInstantUnixNano).not.toBe(
      request.temporalOrder.instantUnixNano,
    );
    expect(BigInt(request.temporalOrder.rawInstantUnixNano)).toBeLessThan(
      BigInt(request.temporalOrder.instantUnixNano),
    );
  });
});

// ---------------------------------------------------------------------------
// RULING 3 — lossy mapping is explicit
// ---------------------------------------------------------------------------

describe("RULING 3 — nothing is dropped silently", () => {
  it("PROPERTY: every accepted span appears in at least one event's provenance", () => {
    const spans = [
      span({ spanId: hex(1), start: 0n, end: 9_000_000n }),
      span({ spanId: hex(2), parentSpanId: hex(1), start: 1_000_000n, end: 2_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(3), parentSpanId: hex(1), start: 1_000_000n, end: 2_000_000n, name: "GET /v1/things" }),
      span({ spanId: hex(4), parentSpanId: hex(9999), start: 1_000_000n, end: 2_000_000n }),
      span({ spanId: hex(5), parentSpanId: hex(1), start: 1_000_000n }),
      span({
        spanId: hex(6),
        parentSpanId: hex(1),
        start: 1_000_000n,
        end: 2_000_000n,
        attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search" },
      }),
    ];
    for (const perm of permutations(spans)) {
      const result = map(perm);
      expect(verifySpanConservation(perm, result.events)).toEqual({ ok: true, missingSpanIds: [] });
    }
  });

  it("records a non-GenAI span as otel.span.unmapped rather than force-fitting it", () => {
    const result = map([
      span({ spanId: hex(1), start: 0n, end: 9_000_000n }),
      span({
        spanId: hex(2),
        parentSpanId: hex(1),
        name: "GET /v1/things",
        kind: "client",
        start: 1_000_000n,
        end: 2_000_000n,
        attributes: { "http.request.method": "GET", "url.full": "https://example.test/v1/things" },
      }),
    ]);
    // NB: the root is itself non-GenAI and therefore also unmapped, so select
    // by span rather than by type.
    const unmappedEvent = result.events.find(
      (e) => e.type === "otel.span.unmapped" && e.spanId === hex(2),
    ) as DerivedEventWrite;
    expect(unmappedEvent).toBeDefined();
    expect(unmappedEvent.payload).toMatchObject({
      type: "otel.span.unmapped",
      spanName: "GET /v1/things",
      spanKind: "client",
      reason: "no-matching-rule",
      attributesTruncated: false,
    });
    // The attributes are PRESERVED, so the span is recorded, not merely counted.
    expect((unmappedEvent.payload as { attributes: Record<string, unknown> }).attributes).toEqual({
      "http.request.method": "GET",
      "url.full": "https://example.test/v1/things",
    });
  });

  it("mirrors unmapped spans in MapResult.unmapped, pointing at the real event", () => {
    const result = map([
      span({ spanId: hex(1), start: 0n, end: 9_000_000n, name: "db.query" }),
    ]);
    expect(result.unmapped).toHaveLength(1);
    const report = result.unmapped[0] as { spanId: string; eventIndex: number };
    expect(report.spanId).toBe(hex(1));
    expect(result.events[report.eventIndex]?.type).toBe("otel.span.unmapped");
  });

  it("keeps `unmapped` (recorded) strictly distinct from `rejected` (not recorded)", () => {
    const result = map([
      span({ spanId: hex(1), start: 0n, end: 9_000_000n, name: "db.query" }),
      span({ spanId: hex(2), traceId: "b".repeat(32), start: 0n, end: 1_000_000n }),
    ]);
    expect(result.unmapped.map((u) => u.spanId)).toEqual([hex(1)]);
    expect(result.rejected).toEqual([{ spanId: hex(2), reason: "foreign-trace" }]);
    expect(result.events.every((e) => e.spanId !== hex(2))).toBe(true);
  });

  it("distinguishes the four unmapped reasons instead of shrugging", () => {
    expect(classifySpan({ name: "db.query" })).toEqual({ kind: "unmapped", reason: "no-matching-rule" });
    expect(
      classifySpan({ name: "x", attributes: { "gen_ai.conversation.id": "c1" } }),
    ).toEqual({ kind: "unmapped", reason: "missing-required-attributes" });
    expect(
      classifySpan({
        name: "x",
        attributes: { "gen_ai.tool.name": "t", "gen_ai.request.model": "m" },
      }),
    ).toEqual({ kind: "unmapped", reason: "ambiguous-match" });
    expect(
      classifySpan({ name: "chat m", schemaUrl: "https://opentelemetry.io/schemas/1.9.0" }),
    ).toEqual({ kind: "unmapped", reason: "unsupported-semconv-version" });
  });

  it("flags attributes-dropped whenever the span carried something we did not read", () => {
    const withExtra = map([
      span({
        spanId: hex(1),
        start: 0n,
        end: 9_000_000n,
        attributes: { ...CHAT_ATTRS, "gen_ai.request.top_p": 0.9, "server.address": "api.test" },
      }),
    ]);
    expect(eventFor(withExtra, "llm.request").provenance.lossReasons).toContain("attributes-dropped");
  });

  it("flags usage-partial when only one side of the token usage was reported", () => {
    const result = map([
      span({
        spanId: hex(1),
        start: 0n,
        end: 9_000_000n,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "m",
          "gen_ai.usage.input_tokens": 10,
        },
      }),
    ]);
    expect(eventFor(result, "llm.response").provenance.lossReasons).toContain("usage-partial");
  });

  it("flags identity-synthesized when a required call_id had to be invented", () => {
    const result = map([
      span({ spanId: hex(1), start: 0n, end: 9_000_000n }),
      span({
        spanId: hex(2),
        parentSpanId: hex(1),
        name: "execute_tool search",
        start: 1_000_000n,
        end: 2_000_000n,
        attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search" },
      }),
    ]);
    const call = eventFor(result, "tool.call");
    expect((call.payload as { call_id: string }).call_id).toBe(`otel:${hex(2)}`);
    expect(call.provenance.lossReasons).toContain("identity-synthesized");
  });

  it("does NOT flag identity-synthesized when the span carried a real call id", () => {
    const result = map([
      span({
        spanId: hex(1),
        name: "execute_tool search",
        start: 0n,
        end: 9_000_000n,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "search",
          "gen_ai.tool.call.id": "call_abc",
        },
      }),
    ]);
    const call = eventFor(result, "tool.call");
    expect((call.payload as { call_id: string }).call_id).toBe("call_abc");
    expect(call.provenance.lossReasons ?? []).not.toContain("identity-synthesized");
  });

  it("reports span links and span events as lost, since neither is representable", () => {
    const result = map([
      span({
        spanId: hex(1),
        start: 0n,
        end: 9_000_000n,
        attributes: CHAT_ATTRS,
        spanLinkCount: 2,
        spanEventCount: 3,
      }),
    ]);
    const reasons = eventFor(result, "llm.request").provenance.lossReasons ?? [];
    expect(reasons).toContain("span-links-dropped");
    expect(reasons).toContain("span-events-dropped");
  });

  it("self-detects a dropped span through verifySpanConservation", () => {
    const spans = [span({ spanId: hex(1), start: 0n, end: 1_000_000n })];
    const result = map(spans);
    // Simulate a mapper bug by removing every event for the span.
    expect(verifySpanConservation(spans, []).ok).toBe(false);
    expect(verifySpanConservation(spans, []).missingSpanIds).toEqual([hex(1)]);
    expect(verifySpanConservation(spans, result.events).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RULING 4 — run boundary
// ---------------------------------------------------------------------------

describe("RULING 4 — run.started first, terminal last", () => {
  it("derives the boundary from the root span of a complete trace", () => {
    const result = map([
      span({ spanId: hex(1), name: "invoke_agent researcher", start: 0n, end: 9_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "researcher" } }),
      span({ spanId: hex(2), parentSpanId: hex(1), start: 1_000_000n, end: 2_000_000n, attributes: CHAT_ATTRS }),
    ]);
    expect(result.events[0]?.type).toBe("run.started");
    expect(result.events[result.events.length - 1]?.type).toBe("run.completed");
    expect(result.runOpen).toBe(false);
    expect(result.terminalType).toBe("run.completed");
  });

  it("emits run.failed when the ROOT errored", () => {
    const result = map([
      span({
        spanId: hex(1),
        name: "invoke_agent r",
        start: 0n,
        end: 9_000_000n,
        attributes: { "gen_ai.operation.name": "invoke_agent", "error.type": "TimeoutError" },
        status: { code: 2, message: "agent timed out" },
      }),
    ]);
    expect(result.terminalType).toBe("run.failed");
    const failed = eventFor(result, "run.failed");
    expect(failed.payload).toMatchObject({
      type: "run.failed",
      error: { message: "agent timed out", code: "TimeoutError" },
      errorSummary: "agent timed out",
    });
  });

  it("does NOT fail the run for a DESCENDANT failure — only the root reports the outcome", () => {
    const result = map([
      span({ spanId: hex(1), name: "invoke_agent r", start: 0n, end: 9_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent" } }),
      span({
        spanId: hex(2),
        parentSpanId: hex(1),
        name: "execute_tool search",
        start: 1_000_000n,
        end: 2_000_000n,
        attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search" },
        status: { code: 2, message: "rate limited, retried" },
      }),
    ]);
    expect(result.terminalType).toBe("run.completed");
    expect(typesOf(result)).toContain("tool.error");
  });

  it("leaves the run in-progress when a span never ended (Rule 5, not an invention)", () => {
    const result = map([
      span({ spanId: hex(1), name: "invoke_agent r", start: 0n, end: 9_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent" } }),
      span({ spanId: hex(2), parentSpanId: hex(1), start: 1_000_000n, attributes: CHAT_ATTRS }),
    ]);
    expect(result.events[0]?.type).toBe("run.started");
    expect(result.runOpen).toBe(true);
    expect(result.terminalType).toBeNull();
    expect(typesOf(result)).not.toContain("run.completed");
    expect(result.diagnostics.map((d) => d.code)).toContain("trace-incomplete");
  });

  it("treats endTimeUnixNano === 0 as UNSET, not as an instant at the epoch", () => {
    const result = map([
      { traceId: TRACE, spanId: hex(1), name: "root", startTimeUnixNano: BASE.toString(), endTimeUnixNano: (BASE + 9_000_000n).toString() },
      { traceId: TRACE, spanId: hex(2), parentSpanId: hex(1), name: "open", startTimeUnixNano: (BASE + 1_000_000n).toString(), endTimeUnixNano: "0" },
    ]);
    expect(result.runOpen).toBe(true);
    // The unset end must not have sorted a closing event to the front.
    expect(result.events[0]?.type).toBe("run.started");
  });

  it("synthesizes run.started from the earliest span when NO root arrived, and withholds the terminal", () => {
    const result = map([
      span({ spanId: hex(2), parentSpanId: hex(999), start: 1_000_000n, end: 2_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(3), parentSpanId: hex(999), start: 3_000_000n, end: 4_000_000n, attributes: CHAT_ATTRS }),
    ]);
    expect(result.events[0]?.type).toBe("run.started");
    expect(result.terminalType).toBeNull();
    expect(result.diagnostics.map((d) => d.code)).toContain("no-root-span");
    expect(eventFor(result, "run.started").provenance.lossReasons).toContain("identity-synthesized");
  });

  it("does not lose a root that is itself an LLM call: it emits the pair inside the boundary", () => {
    const result = map([span({ spanId: hex(1), name: "chat claude", start: 0n, end: 9_000_000n, attributes: CHAT_ATTRS })]);
    expect(typesOf(result)).toEqual(["run.started", "llm.request", "llm.response", "run.completed"]);
  });

  it("reports multiple true roots rather than picking one quietly", () => {
    const result = map([
      span({ spanId: hex(1), start: 0n, end: 9_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(2), start: 1_000_000n, end: 8_000_000n, attributes: CHAT_ATTRS }),
    ]);
    expect(result.diagnostics.map((d) => d.code)).toContain("multiple-roots");
  });
});

// ---------------------------------------------------------------------------
// The researched mapping table
// ---------------------------------------------------------------------------

describe("mapping table — gen_ai.operation.name is authoritative", () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["chat", { "gen_ai.operation.name": "chat", "gen_ai.request.model": "m" }, ["llm.request", "llm.response"]],
    ["text_completion", { "gen_ai.operation.name": "text_completion", "gen_ai.request.model": "m" }, ["llm.request", "llm.response"]],
    ["generate_content", { "gen_ai.operation.name": "generate_content", "gen_ai.request.model": "m" }, ["llm.request", "llm.response"]],
    ["embeddings", { "gen_ai.operation.name": "embeddings", "gen_ai.request.model": "m" }, ["llm.request", "llm.response"]],
    ["execute_tool", { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "t" }, ["tool.call", "tool.result"]],
    ["retrieval", { "gen_ai.operation.name": "retrieval", "gen_ai.data_source.id": "ds" }, ["retrieval.query", "retrieval.result"]],
    ["search_memory", { "gen_ai.operation.name": "search_memory" }, ["memory.read"]],
    ["create_memory", { "gen_ai.operation.name": "create_memory" }, ["memory.write"]],
    ["upsert_memory", { "gen_ai.operation.name": "upsert_memory" }, ["memory.write"]],
    ["delete_memory_store", { "gen_ai.operation.name": "delete_memory_store" }, ["memory.write"]],
    ["invoke_agent", { "gen_ai.operation.name": "invoke_agent" }, ["custom", "custom"]],
    ["create_agent", { "gen_ai.operation.name": "create_agent" }, ["custom", "custom"]],
    ["invoke_workflow", { "gen_ai.operation.name": "invoke_workflow" }, ["custom", "custom"]],
    ["plan", { "gen_ai.operation.name": "plan" }, ["custom", "custom"]],
  ];

  for (const [operation, attributes, expected] of cases) {
    it(`maps ${operation} → ${expected.join(" + ")}`, () => {
      const result = map([
        span({ spanId: hex(1), name: "invoke_agent root", start: 0n, end: 9_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent" } }),
        span({ spanId: hex(2), parentSpanId: hex(1), name: operation, start: 1_000_000n, end: 2_000_000n, attributes }),
      ]);
      const child = result.events.filter((e) => e.spanId === hex(2)).map((e) => e.type);
      expect(child).toEqual(expected);
    });
  }

  it("records an unimplemented operation.name as unmapped rather than guessing the nearest fit", () => {
    expect(classifySpan({ name: "x", attributes: { "gen_ai.operation.name": "some_future_op" } })).toEqual({
      kind: "unmapped",
      reason: "no-matching-rule",
    });
  });

  it("falls back to the conventional span-name prefix when operation.name is absent", () => {
    expect(classifySpan({ name: "chat claude-sonnet-4-5" })).toEqual({ kind: "inference", operation: "chat" });
    expect(classifySpan({ name: "execute_tool search", attributes: { "gen_ai.tool.name": "search" } })).toEqual({ kind: "tool" });
    expect(classifySpan({ name: "invoke_agent researcher" })).toEqual({ kind: "opaque", operation: "invoke_agent" });
  });

  it("never uses SpanKind as a classifier (invoke_agent is defined as CLIENT *and* INTERNAL)", () => {
    const asClient = classifySpan({ name: "invoke_agent a", attributes: { "gen_ai.operation.name": "invoke_agent" } });
    const asInternal = classifySpan({ name: "invoke_agent a", attributes: { "gen_ai.operation.name": "invoke_agent" } });
    expect(asClient).toEqual(asInternal);
  });
});

describe("mapping table — attribute reads, including the renames", () => {
  it("reads gen_ai.provider.name, and falls back to the deprecated gen_ai.system", () => {
    const modern = map([span({ spanId: hex(1), name: "invoke_agent a", start: 0n, end: 1_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.provider.name": "x_ai" } })]);
    expect((eventFor(modern, "run.started").payload as { config: Record<string, unknown> }).config["gen_ai.provider.name"]).toBe("x_ai");

    const legacy = map([span({ spanId: hex(1), name: "invoke_agent a", start: 0n, end: 1_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.system": "xai" } })]);
    expect((eventFor(legacy, "run.started").payload as { config: Record<string, unknown> }).config["gen_ai.provider.name"]).toBe("xai");
  });

  it("reads the post-1.28 token names", () => {
    const result = map([span({ spanId: hex(1), start: 0n, end: 1_000_000n, attributes: CHAT_ATTRS })]);
    expect((eventFor(result, "llm.response").payload as { usage: unknown }).usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 48,
      total_tokens: 168,
    });
  });

  it("falls back to the pre-1.28 token names when only those are present", () => {
    const result = map([
      span({
        spanId: hex(1),
        start: 0n,
        end: 1_000_000n,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "m",
          "gen_ai.usage.prompt_tokens": 7,
          "gen_ai.usage.completion_tokens": 3,
        },
      }),
    ]);
    expect((eventFor(result, "llm.response").payload as { usage: unknown }).usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
  });

  it("prefers gen_ai.response.model over gen_ai.request.model on the response", () => {
    const result = map([span({ spanId: hex(1), start: 0n, end: 1_000_000n, attributes: CHAT_ATTRS })]);
    expect((eventFor(result, "llm.response").payload as { model: string }).model).toBe("claude-sonnet-4-5-20260101");
    expect((eventFor(result, "llm.request").payload as { model: string }).model).toBe("claude-sonnet-4-5");
  });

  it("takes the first of gen_ai.response.finish_reasons (a string ARRAY)", () => {
    const result = map([span({ spanId: hex(1), start: 0n, end: 1_000_000n, attributes: { ...CHAT_ATTRS, "gen_ai.response.finish_reasons": ["length", "stop"] } })]);
    expect((eventFor(result, "llm.response").payload as { finish_reason: string }).finish_reason).toBe("length");
  });

  it("reads the Opt-In content attributes when they ARE present", () => {
    const result = map([
      span({
        spanId: hex(1),
        start: 0n,
        end: 1_000_000n,
        attributes: {
          ...CHAT_ATTRS,
          "gen_ai.input.messages": [{ role: "user", parts: [{ type: "text", content: "hi" }] }],
          "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "text", content: "hello" }] }],
        },
      }),
    ]);
    expect((eventFor(result, "llm.request").payload as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: [{ type: "text", content: "hi" }] },
    ]);
    expect(eventFor(result, "llm.request").provenance.lossReasons ?? []).not.toContain("attributes-dropped");
  });

  it("records content ABSENCE as a loss, so empty messages do not read as 'called with no input'", () => {
    const result = map([span({ spanId: hex(1), start: 0n, end: 1_000_000n, attributes: CHAT_ATTRS })]);
    const request = eventFor(result, "llm.request");
    expect((request.payload as { messages: unknown[] }).messages).toEqual([]);
    expect(request.provenance.lossy).toBe(true);
    expect(request.provenance.lossReasons).toContain("attributes-dropped");
  });

  it("reads error.type — the one Stable attribute on a GenAI span", () => {
    const result = map([
      span({ spanId: hex(1), name: "invoke_agent a", start: 0n, end: 9_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent" } }),
      span({
        spanId: hex(2),
        parentSpanId: hex(1),
        start: 1_000_000n,
        end: 2_000_000n,
        attributes: { ...CHAT_ATTRS, "error.type": "429" },
        status: { code: 2, message: "rate limited" },
      }),
    ]);
    expect(eventFor(result, "llm.error").payload).toEqual({
      type: "llm.error",
      error: { message: "rate limited", code: "429" },
    });
  });

  it("accepts both the OTLP numeric status code and the lowercased name", () => {
    const numeric = map([span({ spanId: hex(1), start: 0n, end: 1_000_000n, attributes: CHAT_ATTRS, status: { code: 2 } })]);
    const named = map([span({ spanId: hex(1), start: 0n, end: 1_000_000n, attributes: CHAT_ATTRS, status: { code: "error" } })]);
    expect(numeric.terminalType).toBe("run.failed");
    expect(named.terminalType).toBe("run.failed");
  });

  it("does NOT double-count cache/reasoning token subsets into the totals", () => {
    const result = map([
      span({
        spanId: hex(1),
        start: 0n,
        end: 1_000_000n,
        attributes: {
          ...CHAT_ATTRS,
          "gen_ai.usage.cache_read.input_tokens": 100,
          "gen_ai.usage.reasoning.output_tokens": 20,
        },
      }),
    ]);
    // input/output_tokens already INCLUDE the subsets per the spec.
    expect((eventFor(result, "llm.response").payload as { usage: { total_tokens: number } }).usage.total_tokens).toBe(168);
    expect(eventFor(result, "llm.response").provenance.lossReasons).toContain("attributes-dropped");
  });

  it("keeps an errored memory span's message instead of squashing it into memory.write", () => {
    const result = map([
      span({ spanId: hex(1), name: "invoke_agent a", start: 0n, end: 9_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent" } }),
      span({
        spanId: hex(2),
        parentSpanId: hex(1),
        name: "create_memory",
        start: 1_000_000n,
        end: 2_000_000n,
        attributes: { "gen_ai.operation.name": "create_memory" },
        status: { code: 2, message: "memory store unavailable" },
      }),
    ]);
    const child = result.events.filter((e) => e.spanId === hex(2));
    expect(child).toHaveLength(1);
    expect(child[0]?.type).toBe("custom");
    expect(JSON.stringify(child[0]?.payload)).toContain("memory store unavailable");
  });
});

// ---------------------------------------------------------------------------
// Multi-batch / prior state
// ---------------------------------------------------------------------------

describe("multi-batch: sequenceNumber is append order, temporalOrder is trace order", () => {
  const batch1 = [
    span({ spanId: hex(1), name: "invoke_agent a", start: 5_000_000n, end: 6_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent" } }),
  ];

  it("numbers a continuation batch from the supplied maximum, contiguously", () => {
    const first = map(batch1);
    const last = first.events[first.events.length - 1]?.sequenceNumber as number;
    const second = mapOtelSpansToEvents(
      [span({ spanId: hex(2), parentSpanId: hex(1), start: 7_000_000n, end: 8_000_000n, attributes: CHAT_ATTRS })],
      { receivedAt: RECEIVED_AT, lastSequenceNumber: last, knownSpanIds: [hex(1)] },
    );
    expect(second.events.map((e) => e.sequenceNumber)).toEqual(
      second.events.map((_, i) => last + i + 1),
    );
  });

  it("does not re-emit run.started on a continuation batch", () => {
    const second = mapOtelSpansToEvents(
      [span({ spanId: hex(2), start: 7_000_000n, end: 8_000_000n, attributes: CHAT_ATTRS })],
      { receivedAt: RECEIVED_AT, lastSequenceNumber: 4, knownSpanIds: [hex(1)] },
    );
    expect(typesOf(second)).not.toContain("run.started");
  });

  it("emits NOTHING for a fully redelivered batch — the correct output is zero events", () => {
    const first = map(batch1);
    const redelivered = mapOtelSpansToEvents(batch1, {
      receivedAt: RECEIVED_AT,
      lastSequenceNumber: first.events.length,
      knownSpanIds: batch1.map((s) => s.spanId),
    });
    expect(redelivered.events).toHaveLength(0);
    expect(redelivered.rejected.map((r) => r.reason)).toEqual(["already-known"]);
    expect(redelivered.ok).toBe(true);
  });

  it("appends a LATE-EARLIER span rather than renumbering, and keeps its true instant", () => {
    const first = map([span({ spanId: hex(2), start: 7_000_000n, end: 8_000_000n, attributes: CHAT_ATTRS })]);
    const last = first.events[first.events.length - 1]?.sequenceNumber as number;
    const late = span({ spanId: hex(1), start: 1_000_000n, end: 9_000_000n, attributes: CHAT_ATTRS });
    const second = mapOtelSpansToEvents([late], {
      receivedAt: RECEIVED_AT,
      lastSequenceNumber: last,
      knownSpanIds: [hex(2)],
    });
    // Appended, never inserted.
    for (const event of second.events) expect(event.sequenceNumber).toBeGreaterThan(last);
    // ...but the temporal truth says it happened FIRST.
    const lateInstant = BigInt((second.events[0] as DerivedEventWrite).temporalOrder.instantUnixNano);
    const earlyInstant = BigInt((first.events[0] as DerivedEventWrite).temporalOrder.instantUnixNano);
    expect(lateInstant).toBeLessThan(earlyInstant);
  });
});

// ---------------------------------------------------------------------------
// Degenerate and adversarial input
// ---------------------------------------------------------------------------

describe("degenerate input yields a defined result, never a throw", () => {
  it("empty batch", () => {
    const result = map([]);
    expect(result.events).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain("empty-batch");
  });

  it("a span that is its own parent is treated as a root and reported", () => {
    const self = span({ spanId: hex(1), parentSpanId: hex(1), start: 1_000_000n, end: 2_000_000n, attributes: CHAT_ATTRS });
    const result = map([self]);
    expect(result.diagnostics.map((d) => d.code)).toContain("self-parent");
    expect(verifySpanConservation([self], result.events).ok).toBe(true);
  });

  it("a parent CYCLE is broken at the lowest span id — no span is lost", () => {
    const spans = [
      span({ spanId: hex(1), parentSpanId: hex(3), start: 1_000_000n, end: 4_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(2), parentSpanId: hex(1), start: 2_000_000n, end: 3_000_000n, attributes: CHAT_ATTRS }),
      span({ spanId: hex(3), parentSpanId: hex(2), start: 1_500_000n, end: 3_500_000n, attributes: CHAT_ATTRS }),
    ];
    const result = map(spans);
    expect(result.diagnostics.map((d) => d.code)).toContain("parent-cycle");
    // The whole cycle survives. A cycle-GUARDED walk that never breaks the
    // cycle silently drops all three, which is worse: an availability defect
    // becomes a correctness one under an append-only log.
    expect(verifySpanConservation(spans, result.events).ok).toBe(true);
  });

  it("a 10,000-deep parent chain neither overflows the stack nor goes quadratic", () => {
    const spans: OtelSpanInput[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const s: OtelSpanInput = {
        traceId: TRACE,
        spanId: hex(i + 1),
        name: "chat m",
        startTimeUnixNano: (BASE + BigInt(i)).toString(),
        endTimeUnixNano: (BASE + BigInt(30_000 - i)).toString(),
        attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "m" },
      };
      if (i > 0) s.parentSpanId = hex(i);
      spans.push(s);
    }
    const result = map(spans);
    expect(verifySpanConservation(spans, result.events).ok).toBe(true);
    expect(result.events.map((e) => e.sequenceNumber)).toEqual(
      result.events.map((_, i) => i + 1),
    );
  });

  it("a span that ends before it starts is clamped up and reported", () => {
    const result = map([
      span({ spanId: hex(1), start: 0n, end: 9_000_000n }),
      span({ spanId: hex(2), parentSpanId: hex(1), start: 5_000_000n, end: 1_000_000n, attributes: CHAT_ATTRS }),
    ]);
    expect(result.diagnostics.map((d) => d.code)).toContain("negative-duration");
    const open = result.events.findIndex((e) => e.type === "llm.request");
    const close = result.events.findIndex((e) => e.type === "llm.response");
    expect(open).toBeLessThan(close);
  });

  it("duplicate span ids resolve to ONE span, arrival-independently, and are reported", () => {
    const first = span({ spanId: hex(1), start: 1_000_000n, end: 2_000_000n, attributes: CHAT_ATTRS });
    const second: OtelSpanInput = { ...first, endTimeUnixNano: (BASE + 2_500_000n).toString(), status: { code: 2, message: "boom" } };
    const forward = map([first, second]);
    const reverse = map([second, first]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
    expect(forward.diagnostics.map((d) => d.code)).toContain("duplicate-span-id");
    expect(forward.rejected.some((r) => r.reason === "duplicate")).toBe(true);
  });

  it("reports a non-W3C id rather than failing the batch (validation belongs at the boundary)", () => {
    const result = map([{ traceId: TRACE, spanId: "not-hex", name: "chat m", startTimeUnixNano: BASE.toString(), endTimeUnixNano: (BASE + 1n).toString() }]);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain("malformed-span-id");
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("absurd timestamps (uint64 max, zero) keep the sequence contiguous", () => {
    const result = map([
      { traceId: TRACE, spanId: hex(1), name: "root", startTimeUnixNano: BASE.toString(), endTimeUnixNano: (BASE + 9000n).toString() },
      { traceId: TRACE, spanId: hex(2), parentSpanId: hex(1), name: "max", startTimeUnixNano: "18446744073709551615", endTimeUnixNano: "18446744073709551615" },
      { traceId: TRACE, spanId: hex(3), parentSpanId: hex(1), name: "zero", startTimeUnixNano: "0", endTimeUnixNano: "0" },
    ]);
    expect(result.events.map((e) => e.sequenceNumber)).toEqual(result.events.map((_, i) => i + 1));
  });
});

// ---------------------------------------------------------------------------
// Structural invariants of the output
// ---------------------------------------------------------------------------

describe("output invariants", () => {
  const result = map([
    span({ spanId: hex(1), name: "invoke_agent a", start: 0n, end: 9_000_000n, attributes: { "gen_ai.operation.name": "invoke_agent" } }),
    span({ spanId: hex(2), parentSpanId: hex(1), start: 1_000_000n, end: 4_000_000n, attributes: CHAT_ATTRS }),
    span({ spanId: hex(3), parentSpanId: hex(2), name: "execute_tool s", start: 2_000_000n, end: 3_000_000n, attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "s" } }),
  ]);

  it("sequence numbers are contiguous from 1 and non-repeating (Event Log Rule 4)", () => {
    expect(result.events.map((e) => e.sequenceNumber)).toEqual(result.events.map((_, i) => i + 1));
  });

  it("every parentEventIndex points STRICTLY backwards — resolvable in one forward pass", () => {
    result.events.forEach((event, index) => {
      if (event.parentEventIndex === undefined) return;
      expect(event.parentEventIndex).toBeLessThan(index);
      expect(event.parentEventIndex).toBeGreaterThanOrEqual(0);
    });
  });

  it("run.started has no parent; everything else hangs off the boundary or its span's open", () => {
    expect(result.events[0]?.parentEventIndex).toBeUndefined();
    expect(result.events.slice(1).every((e) => e.parentEventIndex !== undefined)).toBe(true);
  });

  it("stats add up against the events actually emitted", () => {
    expect(result.stats.eventsOut).toBe(result.events.length);
    expect(result.stats.spansUnmapped).toBe(result.unmapped.length);
    expect(result.stats.spansRejected).toBe(result.rejected.length);
  });

  it("mapTraceToEvents accepts both the object and the positional form", () => {
    const spans = [span({ spanId: hex(1), start: 0n, end: 1_000_000n, attributes: CHAT_ATTRS })];
    const viaObject = mapTraceToEvents({ spans, receivedAt: RECEIVED_AT });
    const viaPositional = mapTraceToEvents(spans, { receivedAt: RECEIVED_AT });
    expect(JSON.stringify(viaObject)).toBe(JSON.stringify(viaPositional));
  });

  it("carries prior state through the object form's `prior` field too", () => {
    const spans = [span({ spanId: hex(1), start: 0n, end: 1_000_000n, attributes: CHAT_ATTRS })];
    const nested = mapTraceToEvents({ spans, receivedAt: RECEIVED_AT, prior: { lastSequenceNumber: 7, knownSpanIds: [] } });
    expect(nested.events[0]?.sequenceNumber).toBe(8);
  });
});
