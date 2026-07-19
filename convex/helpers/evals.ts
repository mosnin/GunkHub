/**
 * Rule-based eval engine. Pure — no Convex `ctx`, no schema imports. Rules are
 * evaluated against a minimal run/event shape so this module stays usable
 * before Team A's cycle-2 schema lands (attachment model + `evals` table are
 * described in docs/design/insight_engine.md).
 *
 * Threat model for this file: rules and their `value`/`path` fields may
 * ultimately be authored by any org member and stored per AgentVersion. That
 * means this engine treats rule content as UNTRUSTED INPUT — dot-paths must
 * not allow prototype pollution, regexes must not allow ReDoS-by-construction
 * (length-capped, wrapped in try/catch), and string comparisons must not allow
 * unbounded memory blowup (bounded slices). No rule, however malformed, is
 * allowed to throw out of `evaluateRules` — a bad rule fails with an
 * explanation, it never crashes the caller.
 */

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

export type EvalRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface EvalRunLike {
  status: EvalRunStatus;
  startedAt: number;
  endedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface EvalEventLike {
  type: string;
  sequenceNumber?: number;
  timestamp?: number;
  payload?: unknown;
}

export interface TerminalStatusRule {
  kind: "terminal_status";
  expect: EvalRunStatus[];
}

export interface MaxDurationRule {
  kind: "max_duration_ms";
  limit: number;
}

export interface MaxTokensRule {
  kind: "max_tokens";
  limitIn?: number;
  limitOut?: number;
}

export interface EventCountRule {
  kind: "event_count";
  min?: number;
  max?: number;
  eventType?: string;
}

export type PayloadMatchOp = "contains" | "equals" | "regex" | "not_contains";

export interface PayloadMatchRule {
  kind: "payload_match";
  eventType: string;
  /** Dot-separated path into the event's payload, e.g. "error.message" or "usage.total_tokens". */
  path: string;
  op: PayloadMatchOp;
  value: string;
}

export interface NoEventRule {
  kind: "no_event";
  eventType: string;
}

export type EvalRule =
  | TerminalStatusRule
  | MaxDurationRule
  | MaxTokensRule
  | EventCountRule
  | PayloadMatchRule
  | NoEventRule;

export interface RuleResult {
  rule: EvalRule;
  passed: boolean;
  actual: string;
  expected: string;
  explanation: string;
}

export interface EvalResult {
  overallPassed: boolean;
  results: RuleResult[];
}

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

/** Segments that would reach into the prototype chain — always rejected. */
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Hard cap on regex source length, to keep pathological patterns cheap to reject/compile. */
const MAX_REGEX_LENGTH = 500;

/** Any value converted to a string for comparison is truncated to this many characters. */
const MAX_COMPARISON_LENGTH = 10 * 1024; // 10 KB

/**
 * Safely resolve a dot-path into a value, WITHOUT ever touching
 * `__proto__`/`constructor`/`prototype` segments (prototype-pollution guard).
 * Returns `{ found: false }` if the path is empty, contains a forbidden
 * segment, or does not resolve (missing key at any level, or a non-object
 * encountered mid-path).
 */
function resolveDotPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  if (!path) return { found: false };
  const segments = path.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) return { found: false };

  let current: unknown = root;
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      return { found: false };
    }
    if (current === null || current === undefined) {
      return { found: false };
    }
    if (typeof current !== "object") {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/** Stringify a value for bounded string comparison. Never throws. */
function stringifyBounded(value: unknown): string {
  let s: string;
  if (value === undefined) {
    s = "";
  } else if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > MAX_COMPARISON_LENGTH ? s.slice(0, MAX_COMPARISON_LENGTH) : s;
}

function durationMs(run: EvalRunLike): number | undefined {
  return run.endedAt !== undefined && run.endedAt >= run.startedAt
    ? run.endedAt - run.startedAt
    : undefined;
}

// ---------------------------------------------------------------------------
// Per-rule evaluation
// ---------------------------------------------------------------------------

function evaluateTerminalStatus(rule: TerminalStatusRule, run: EvalRunLike): RuleResult {
  const passed = rule.expect.includes(run.status);
  return {
    rule,
    passed,
    actual: run.status,
    expected: rule.expect.join(" | "),
    explanation: passed
      ? `Run status "${run.status}" is in the expected set.`
      : `Run status "${run.status}" is not one of [${rule.expect.join(", ")}].`,
  };
}

function evaluateMaxDuration(rule: MaxDurationRule, run: EvalRunLike): RuleResult {
  const dur = durationMs(run);
  if (dur === undefined) {
    return {
      rule,
      passed: false,
      actual: "unknown (run has no endedAt)",
      expected: `<= ${rule.limit}ms`,
      explanation: "Run has not ended yet (no endedAt), so duration cannot be checked.",
    };
  }
  const passed = dur <= rule.limit;
  return {
    rule,
    passed,
    actual: `${dur}ms`,
    expected: `<= ${rule.limit}ms`,
    explanation: passed
      ? `Duration ${dur}ms is within the ${rule.limit}ms limit.`
      : `Duration ${dur}ms exceeds the ${rule.limit}ms limit.`,
  };
}

function evaluateMaxTokens(rule: MaxTokensRule, run: EvalRunLike): RuleResult {
  const failures: string[] = [];
  if (rule.limitIn !== undefined && (run.tokensIn ?? 0) > rule.limitIn) {
    failures.push(`tokensIn ${run.tokensIn} > ${rule.limitIn}`);
  }
  if (rule.limitOut !== undefined && (run.tokensOut ?? 0) > rule.limitOut) {
    failures.push(`tokensOut ${run.tokensOut} > ${rule.limitOut}`);
  }
  const passed = failures.length === 0;
  return {
    rule,
    passed,
    actual: `tokensIn=${run.tokensIn ?? 0}, tokensOut=${run.tokensOut ?? 0}`,
    expected: `tokensIn<=${rule.limitIn ?? "∞"}, tokensOut<=${rule.limitOut ?? "∞"}`,
    explanation: passed ? "Token usage is within limits." : `Exceeded: ${failures.join("; ")}.`,
  };
}

function evaluateEventCount(rule: EventCountRule, events: EvalEventLike[]): RuleResult {
  const matching = rule.eventType
    ? events.filter((e) => e.type === rule.eventType)
    : events;
  const count = matching.length;

  const failures: string[] = [];
  if (rule.min !== undefined && count < rule.min) failures.push(`count ${count} < min ${rule.min}`);
  if (rule.max !== undefined && count > rule.max) failures.push(`count ${count} > max ${rule.max}`);
  const passed = failures.length === 0;

  const label = rule.eventType ? `event type "${rule.eventType}"` : "all events";
  return {
    rule,
    passed,
    actual: `${count}`,
    expected: `min=${rule.min ?? "-"}, max=${rule.max ?? "-"}`,
    explanation: passed
      ? `Count of ${label} (${count}) satisfies the configured bounds.`
      : `Count of ${label} (${count}) violates bounds: ${failures.join("; ")}.`,
  };
}

/**
 * AUDIT FIX (cycle 5): reject regex patterns with a nested/overlapping
 * quantifier ("evil regex") shape — the classic ReDoS construction where a
 * quantified group's body can match the same substring in more than one way
 * and the group is itself repeated, e.g. `(a+)+`, `(a*)*`, `(a|a)+`,
 * `(a+)*b`. MAX_REGEX_LENGTH bounds pattern SOURCE length but says nothing
 * about evaluation COST: a 6-char pattern like `(a+)+$` run against a
 * crafted non-matching string (e.g. "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!") is
 * exponential in the input length, so the length cap alone does not bound
 * the work `re.test()` can do.
 *
 * GUARANTEE (what this function actually provides): a conservative static
 * scan of the pattern source that flags any parenthesized group whose body
 * contains a quantifier metacharacter (`+`, `*`, or `{m,n}`) AND which is
 * itself immediately followed by another quantifier. This is the necessary
 * shape for catastrophic backtracking in a backtracking regex engine (which
 * is what JS `RegExp` is). It is intentionally over-inclusive — some
 * patterns matching this shape are in fact safe (e.g. quantifiers over
 * mutually-exclusive character classes) — because false rejections of an
 * admin-authored rule are cheap (the rule just fails safely with an
 * explanation) whereas a false negative is a live availability incident.
 * It is NOT a full regex parser/analyzer and does not prove linear-time
 * evaluation for everything it allows through (e.g. it does not reason
 * about backreferences or cross-group ambiguity), so it is defense-in-depth
 * layered on top of the length cap and the bounded MAX_COMPARISON_LENGTH
 * input, not a formal safety proof. Combined, the three bounds are: pattern
 * source length (compile-time cost), rejected nested-quantifier shape
 * (catastrophic-backtracking shape), and input string length (per-match
 * work for any pattern that does get through).
 */
function hasDangerousQuantifierNesting(source: string): boolean {
  const groupStarts: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++; // skip the escaped character (e.g. "\(" is not a group boundary)
      continue;
    }
    if (ch === "(") {
      groupStarts.push(i + 1);
    } else if (ch === ")") {
      const start = groupStarts.pop();
      if (start === undefined) continue; // unbalanced — let RegExp compilation reject it
      const body = source.slice(start, i);
      const bodyHasQuantifier = /[+*]|\{\d*,?\d*\}/.test(body);
      const after = source.slice(i + 1);
      const followedByQuantifier = /^([+*]|\{\d*,?\d*\})/.test(after);
      if (bodyHasQuantifier && followedByQuantifier) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compile a rule-supplied regex source safely. Never throws — returns
 * undefined on any failure, including a rejected nested-quantifier shape
 * (see hasDangerousQuantifierNesting above).
 */
function safeCompileRegex(source: string): RegExp | undefined {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_REGEX_LENGTH) {
    return undefined;
  }
  if (hasDangerousQuantifierNesting(source)) {
    return undefined;
  }
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

function evaluatePayloadMatch(rule: PayloadMatchRule, events: EvalEventLike[]): RuleResult {
  const candidates = events.filter((e) => e.type === rule.eventType);
  if (candidates.length === 0) {
    return {
      rule,
      passed: false,
      actual: "no matching events",
      expected: `${rule.op} "${rule.value}" at path "${rule.path}"`,
      explanation: `No events of type "${rule.eventType}" were found to check.`,
    };
  }

  if (rule.op === "regex") {
    const re = safeCompileRegex(rule.value);
    if (!re) {
      return {
        rule,
        passed: false,
        actual: "n/a",
        expected: `valid regex "${rule.value}"`,
        explanation: `Rule regex "${rule.value}" is invalid, exceeds the ${MAX_REGEX_LENGTH}-char cap, or has an unsafe nested-quantifier (ReDoS) shape; rule fails safely rather than throwing or hanging.`,
      };
    }

    for (const event of candidates) {
      const resolved = resolveDotPath(event.payload, rule.path);
      if (!resolved.found) continue;
      const actualStr = stringifyBounded(resolved.value);
      let matched: boolean;
      try {
        matched = re.test(actualStr);
      } catch {
        matched = false;
      }
      if (matched) {
        return {
          rule,
          passed: true,
          actual: actualStr,
          expected: `matches /${rule.value}/`,
          explanation: `Found "${rule.eventType}" event whose "${rule.path}" matches /${rule.value}/.`,
        };
      }
    }
    return {
      rule,
      passed: false,
      actual: `${candidates.length} matching event(s), none satisfied the regex`,
      expected: `matches /${rule.value}/`,
      explanation: `No "${rule.eventType}" event had a "${rule.path}" value matching /${rule.value}/.`,
    };
  }

  // contains / not_contains / equals
  for (const event of candidates) {
    const resolved = resolveDotPath(event.payload, rule.path);
    if (!resolved.found) continue;
    const actualStr = stringifyBounded(resolved.value);
    const expectedStr = stringifyBounded(rule.value);

    let hit: boolean;
    if (rule.op === "equals") hit = actualStr === expectedStr;
    else if (rule.op === "contains") hit = actualStr.includes(expectedStr);
    else hit = !actualStr.includes(expectedStr); // not_contains

    if (rule.op === "not_contains") {
      // For not_contains, a single violation fails the rule outright.
      if (!hit) {
        return {
          rule,
          passed: false,
          actual: actualStr,
          expected: `not_contains "${rule.value}"`,
          explanation: `Event "${rule.eventType}" field "${rule.path}" unexpectedly contains "${rule.value}".`,
        };
      }
    } else if (hit) {
      return {
        rule,
        passed: true,
        actual: actualStr,
        expected: `${rule.op} "${rule.value}"`,
        explanation: `Found "${rule.eventType}" event whose "${rule.path}" ${rule.op === "equals" ? "equals" : "contains"} "${rule.value}".`,
      };
    }
  }

  if (rule.op === "not_contains") {
    return {
      rule,
      passed: true,
      actual: `checked ${candidates.length} matching event(s)`,
      expected: `not_contains "${rule.value}"`,
      explanation: `No "${rule.eventType}" event's "${rule.path}" contains "${rule.value}".`,
    };
  }

  return {
    rule,
    passed: false,
    actual: `checked ${candidates.length} matching event(s), no match`,
    expected: `${rule.op} "${rule.value}" at path "${rule.path}"`,
    explanation: `No "${rule.eventType}" event had a "${rule.path}" value that ${rule.op === "equals" ? "equals" : "contains"} "${rule.value}".`,
  };
}

function evaluateNoEvent(rule: NoEventRule, events: EvalEventLike[]): RuleResult {
  const found = events.some((e) => e.type === rule.eventType);
  return {
    rule,
    passed: !found,
    actual: found ? "present" : "absent",
    expected: "absent",
    explanation: found
      ? `Found at least one "${rule.eventType}" event, which is disallowed.`
      : `No "${rule.eventType}" event was present, as required.`,
  };
}

/**
 * Evaluate a list of eval rules against a run + its events. Never throws:
 * every rule kind (including malformed/hostile `payload_match` rules) is
 * evaluated defensively and reports `passed: false` with an explanation
 * rather than propagating an exception.
 */
export function evaluateRules(
  rules: EvalRule[],
  run: EvalRunLike,
  events: EvalEventLike[],
): EvalResult {
  const results: RuleResult[] = rules.map((rule) => {
    try {
      switch (rule.kind) {
        case "terminal_status":
          return evaluateTerminalStatus(rule, run);
        case "max_duration_ms":
          return evaluateMaxDuration(rule, run);
        case "max_tokens":
          return evaluateMaxTokens(rule, run);
        case "event_count":
          return evaluateEventCount(rule, events);
        case "payload_match":
          return evaluatePayloadMatch(rule, events);
        case "no_event":
          return evaluateNoEvent(rule, events);
        default: {
          // Exhaustiveness guard for future rule kinds added without updating this switch.
          const _exhaustive: never = rule;
          return {
            rule: _exhaustive as EvalRule,
            passed: false,
            actual: "unknown",
            expected: "unknown",
            explanation: "Unrecognized rule kind.",
          };
        }
      }
    } catch (err) {
      // Defense in depth: no single rule may ever throw out of evaluateRules.
      return {
        rule,
        passed: false,
        actual: "error",
        expected: "n/a",
        explanation: `Rule evaluation threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  return {
    overallPassed: results.every((r) => r.passed),
    results,
  };
}

// ---------------------------------------------------------------------------
// LLM judge — interface finalized now, execution deferred to a later cycle.
// ---------------------------------------------------------------------------

export interface LlmJudgeSpec {
  /** The judge prompt template. May reference run/event data — templating is a cycle-2+ concern. */
  prompt: string;
  /** Optional judge model override; defaults to an operator-configured default judge model. */
  model?: string;
  /** Score threshold (0-1) at or above which the judge's verdict counts as "pass". */
  passThreshold: number;
}

export type LlmJudgeResultStatus = "passed" | "failed" | "not_configured" | "error";

export interface LlmJudgeResult {
  status: LlmJudgeResultStatus;
  /** Present only when status is "passed" or "failed". */
  score?: number;
  /** Present only when status is "passed" or "failed". */
  rationale?: string;
  /** Present only when status is "not_configured" or "error". */
  message?: string;
}

/**
 * Stub — real execution requires a live Convex deployment with an LLM API
 * key configured (a cycle-2+ concern; see docs/design/insight_engine.md).
 * Always returns `{ status: "not_configured" }` today. The interface
 * (`LlmJudgeSpec` / `LlmJudgeResult`) is final now so callers (eval storage,
 * UI) can be built against it without waiting for the real implementation.
 */
export function runLlmJudge(
  _spec: LlmJudgeSpec,
  _run: EvalRunLike,
  _events: EvalEventLike[],
): Promise<LlmJudgeResult> {
  return Promise.resolve({
    status: "not_configured",
    message: "LLM judge execution is not yet wired to a live model deployment.",
  });
}
