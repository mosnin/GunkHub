import { describe, it, expect } from "vitest";

import {
  evaluateRules,
  runLlmJudge,
  type EvalRule,
  type EvalRunLike,
  type EvalEventLike,
} from "./evals";

function baseRun(overrides: Partial<EvalRunLike> = {}): EvalRunLike {
  return { status: "completed", startedAt: 0, endedAt: 1000, ...overrides };
}

describe("evaluateRules — terminal_status", () => {
  it("passes when status is in the expected set", () => {
    const result = evaluateRules(
      [{ kind: "terminal_status", expect: ["completed", "failed"] }],
      baseRun({ status: "completed" }),
      [],
    );
    expect(result.overallPassed).toBe(true);
    expect(result.results[0].passed).toBe(true);
  });

  it("fails when status is not in the expected set", () => {
    const result = evaluateRules(
      [{ kind: "terminal_status", expect: ["completed"] }],
      baseRun({ status: "failed" }),
      [],
    );
    expect(result.overallPassed).toBe(false);
    expect(result.results[0].explanation).toMatch(/not one of/);
  });
});

describe("evaluateRules — max_duration_ms", () => {
  it("passes when duration is under the limit", () => {
    const result = evaluateRules(
      [{ kind: "max_duration_ms", limit: 5000 }],
      baseRun({ startedAt: 0, endedAt: 1000 }),
      [],
    );
    expect(result.overallPassed).toBe(true);
  });

  it("fails when duration exceeds the limit", () => {
    const result = evaluateRules(
      [{ kind: "max_duration_ms", limit: 500 }],
      baseRun({ startedAt: 0, endedAt: 1000 }),
      [],
    );
    expect(result.overallPassed).toBe(false);
  });

  it("fails safely when the run has no endedAt", () => {
    const result = evaluateRules(
      [{ kind: "max_duration_ms", limit: 500 }],
      baseRun({ endedAt: undefined }),
      [],
    );
    expect(result.results[0].passed).toBe(false);
    expect(result.results[0].explanation).toMatch(/has not ended/);
  });
});

describe("evaluateRules — max_tokens", () => {
  it("passes within both limits", () => {
    const result = evaluateRules(
      [{ kind: "max_tokens", limitIn: 1000, limitOut: 1000 }],
      baseRun({ tokensIn: 500, tokensOut: 500 }),
      [],
    );
    expect(result.overallPassed).toBe(true);
  });

  it("fails when only tokensOut exceeds its limit", () => {
    const result = evaluateRules(
      [{ kind: "max_tokens", limitOut: 100 }],
      baseRun({ tokensIn: 10, tokensOut: 200 }),
      [],
    );
    expect(result.overallPassed).toBe(false);
    expect(result.results[0].explanation).toMatch(/tokensOut/);
  });

  it("treats missing token fields as zero", () => {
    const result = evaluateRules(
      [{ kind: "max_tokens", limitIn: 10 }],
      baseRun({}),
      [],
    );
    expect(result.overallPassed).toBe(true);
  });
});

describe("evaluateRules — event_count", () => {
  const events: EvalEventLike[] = [
    { type: "llm.request" },
    { type: "llm.request" },
    { type: "tool.call" },
  ];

  it("passes within min/max bounds for a specific event type", () => {
    const result = evaluateRules(
      [{ kind: "event_count", eventType: "llm.request", min: 1, max: 5 }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(true);
  });

  it("fails when count is below min", () => {
    const result = evaluateRules(
      [{ kind: "event_count", eventType: "tool.error", min: 1 }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
    expect(result.results[0].actual).toBe("0");
  });

  it("fails when count exceeds max", () => {
    const result = evaluateRules(
      [{ kind: "event_count", eventType: "llm.request", max: 1 }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
  });

  it("counts all events when eventType is omitted", () => {
    const result = evaluateRules(
      [{ kind: "event_count", min: 3, max: 3 }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(true);
  });
});

describe("evaluateRules — payload_match", () => {
  const events: EvalEventLike[] = [
    { type: "llm.error", payload: { error: { message: "rate limit exceeded", code: "429" } } },
    { type: "tool.result", payload: { output: { ok: true } } },
  ];

  it("contains: passes when substring is present", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.message", op: "contains", value: "rate limit" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(true);
  });

  it("contains: fails when substring is absent", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.message", op: "contains", value: "timeout" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
  });

  it("equals: passes on exact match", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.code", op: "equals", value: "429" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(true);
  });

  it("equals: fails on partial match", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.code", op: "equals", value: "42" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
  });

  it("not_contains: passes when the forbidden substring is absent", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.message", op: "not_contains", value: "secret-key" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(true);
  });

  it("not_contains: fails when the forbidden substring is present", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.message", op: "not_contains", value: "rate limit" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
  });

  it("regex: passes on a matching pattern", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.code", op: "regex", value: "^4\\d{2}$" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(true);
  });

  it("regex: fails safely (never throws) on an invalid pattern", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.code", op: "regex", value: "(unterminated" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
    expect(result.results[0].explanation).toMatch(/invalid/);
  });

  it("regex: rejects patterns beyond the length cap without throwing", () => {
    const hugePattern = "a".repeat(10_000);
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.message", op: "regex", value: hugePattern }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
  });

  it("AUDIT FIX (cycle 5): rejects a known ReDoS (nested-quantifier) pattern without hanging", () => {
    // Classic catastrophic-backtracking shape: (a+)+ against a string with no
    // trailing match forces the backtracking engine through exponentially
    // many ways to partition the "a" run. This must be rejected statically
    // (never even reach re.test()), not merely "eventually return false".
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.message", op: "regex", value: "^(a+)+$" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
    expect(result.results[0].explanation).toMatch(/unsafe|ReDoS/i);
  });

  it("AUDIT FIX (cycle 5): rejects other known nested/overlapping-quantifier shapes", () => {
    for (const pattern of ["(a*)*", "(a+)*b", "(a{2,})+"]) {
      const result = evaluateRules(
        [{ kind: "payload_match", eventType: "llm.error", path: "error.message", op: "regex", value: pattern }],
        baseRun(),
        events,
      );
      expect(result.overallPassed).toBe(false);
      expect(result.results[0].explanation).toMatch(/unsafe|ReDoS/i);
    }
  });

  it("AUDIT FIX (cycle 5): normal, non-dangerous regex patterns still work", () => {
    // A quantifier inside a group that is NOT itself repeated is fine (no
    // nested repetition ambiguity) — must not be caught by the new guard.
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.code", op: "regex", value: "^(4\\d{2})$" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(true);

    // Alternation with a trailing quantifier but no inner quantifier is safe.
    const result2 = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.message", op: "regex", value: "(rate|timeout)+" }],
      baseRun(),
      events,
    );
    expect(result2.overallPassed).toBe(true);
  });

  it("fails cleanly when no events of the given type exist", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "no.such.type", path: "x", op: "contains", value: "y" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
    expect(result.results[0].actual).toBe("no matching events");
  });

  it("fails cleanly when the path does not resolve", () => {
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "llm.error", path: "error.nonexistent.deeper", op: "contains", value: "x" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
  });
});

describe("evaluateRules — payload_match hostile inputs", () => {
  it("rejects __proto__ path segments (prototype pollution attempt)", () => {
    const events: EvalEventLike[] = [
      { type: "custom", payload: { a: 1 } },
    ];
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "custom", path: "__proto__.polluted", op: "equals", value: "x" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
    // Prove no pollution actually occurred.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects constructor.prototype path segments", () => {
    const events: EvalEventLike[] = [
      { type: "custom", payload: { a: { b: 1 } } },
    ];
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "custom", path: "a.constructor.prototype.polluted", op: "equals", value: "x" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bounds an enormous payload string instead of blowing up memory", () => {
    const huge = "x".repeat(1_000_000);
    const events: EvalEventLike[] = [{ type: "custom", payload: { data: huge } }];
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "custom", path: "data", op: "contains", value: "x" }],
      baseRun(),
      events,
    );
    // Should still evaluate (bounded slice contains 'x') without throwing or hanging.
    expect(result.overallPassed).toBe(true);
  });

  it("handles a payload that is not an object gracefully", () => {
    const events: EvalEventLike[] = [{ type: "custom", payload: "just a string" }];
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "custom", path: "a.b", op: "contains", value: "x" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
  });

  it("handles a null payload gracefully", () => {
    const events: EvalEventLike[] = [{ type: "custom", payload: null }];
    const result = evaluateRules(
      [{ kind: "payload_match", eventType: "custom", path: "a.b", op: "contains", value: "x" }],
      baseRun(),
      events,
    );
    expect(result.overallPassed).toBe(false);
  });
});

describe("evaluateRules — no_event", () => {
  it("passes when the forbidden event type is absent", () => {
    const result = evaluateRules(
      [{ kind: "no_event", eventType: "tool.error" }],
      baseRun(),
      [{ type: "llm.request" }],
    );
    expect(result.overallPassed).toBe(true);
  });

  it("fails when the forbidden event type is present", () => {
    const result = evaluateRules(
      [{ kind: "no_event", eventType: "tool.error" }],
      baseRun(),
      [{ type: "tool.error" }],
    );
    expect(result.overallPassed).toBe(false);
  });
});

describe("evaluateRules — rule combinations", () => {
  it("overallPassed is true only when every rule passes", () => {
    const rules: EvalRule[] = [
      { kind: "terminal_status", expect: ["completed"] },
      { kind: "max_duration_ms", limit: 10_000 },
      { kind: "no_event", eventType: "tool.error" },
    ];
    const result = evaluateRules(rules, baseRun({ status: "completed", startedAt: 0, endedAt: 500 }), [
      { type: "llm.request" },
    ]);
    expect(result.overallPassed).toBe(true);
    expect(result.results).toHaveLength(3);
  });

  it("overallPassed is false if any single rule fails", () => {
    const rules: EvalRule[] = [
      { kind: "terminal_status", expect: ["completed"] },
      { kind: "no_event", eventType: "tool.error" },
    ];
    const result = evaluateRules(rules, baseRun({ status: "completed" }), [
      { type: "tool.error" },
    ]);
    expect(result.overallPassed).toBe(false);
    expect(result.results[0].passed).toBe(true);
    expect(result.results[1].passed).toBe(false);
  });

  it("does NOT treat an empty rule list as passing", () => {
    // THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE — "handles an empty rule list
    // as vacuously passing" — which is what made the defect look deliberate and
    // kept it alive through review. `overallPassed` is written straight into an
    // `eval_summary` row's `passed` field, so "vacuously passing" meant a
    // version with no rules certified every one of its runs as having passed an
    // evaluation that never ran.
    const result = evaluateRules([], baseRun(), []);
    expect(result.overallPassed).toBe(false);
    expect(result.rulesEvaluated).toBe(0);
    expect(result.results).toEqual([]);
  });
});

describe("runLlmJudge", () => {
  it("returns a not_configured stub result", async () => {
    const result = await runLlmJudge(
      { prompt: "Did the agent succeed?", passThreshold: 0.8 },
      baseRun(),
      [],
    );
    expect(result.status).toBe("not_configured");
    expect(result.message).toBeTruthy();
  });
});

describe("evaluateRules — the empty rule set cannot certify anything", () => {
  it("does NOT report overallPassed on zero rules", () => {
    // `results.every(...)` is vacuously true on an empty array, and this value
    // is written straight into an `eval_summary` row's `passed` field — so a
    // version with no rules certified every one of its runs as having passed an
    // evaluation that never ran. A false PASS is the dangerous direction here.
    const result = evaluateRules([], baseRun(), []);
    expect(result.results).toEqual([]);
    expect(result.rulesEvaluated).toBe(0);
    expect(result.overallPassed).toBe(false);
  });

  it("rulesEvaluated is what distinguishes 'nothing ran' from 'something failed'", () => {
    // Both report `overallPassed: false`, and they are completely different
    // claims. The count is the only thing that separates them, which is why it
    // is a required field rather than something a caller derives.
    const nothingRan = evaluateRules([], baseRun(), []);
    const somethingFailed = evaluateRules(
      [{ kind: "terminal_status", expect: ["completed"] }],
      baseRun({ status: "failed" }),
      [],
    );
    expect(nothingRan.overallPassed).toBe(somethingFailed.overallPassed);
    expect(nothingRan.rulesEvaluated).toBe(0);
    expect(somethingFailed.rulesEvaluated).toBe(1);
  });

  it("a single passing rule still reports overallPassed, so the guard is not blanket", () => {
    const result = evaluateRules(
      [{ kind: "terminal_status", expect: ["completed"] }],
      baseRun({ status: "completed" }),
      [],
    );
    expect(result.overallPassed).toBe(true);
    expect(result.rulesEvaluated).toBe(1);
  });
});
