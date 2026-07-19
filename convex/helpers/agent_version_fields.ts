// Cycle 2 (docs/design/action_layer.md) — eval auto-run. Runtime validation
// for agent_versions.evalRules, which is stored as `v.array(v.any())` in the
// schema (the EvalRule discriminated union from helpers/evals.ts cannot be
// expressed in the Convex validator DSL — same justified exception as
// events.payload). This module is the actual gate: createAgentVersion calls
// it before insert, so a malformed rule can never be persisted even though
// the schema-level validator would accept it.

import { afrError } from "./errors.js";
import { MAX_EVAL_RULES_PER_VERSION } from "./pagination.js";

import type { EvalRule } from "./evals.js";

const KNOWN_RULE_KINDS = new Set<EvalRule["kind"]>([
  "terminal_status",
  "max_duration_ms",
  "max_tokens",
  "event_count",
  "payload_match",
  "no_event",
]);

/**
 * Validate the SHAPE of a caller-supplied evalRules array well enough that a
 * garbage value cannot be persisted, without re-implementing every field
 * constraint from helpers/evals.ts (evaluateRules already fails safe — never
 * throws — on a malformed individual rule at evaluation time; this gate is
 * about bounding the write, not perfecting the read).
 */
export function validateEvalRules(rules: unknown[] | undefined): void {
  if (rules === undefined) return;
  if (rules.length > MAX_EVAL_RULES_PER_VERSION) {
    throw afrError(
      "INVALID_ARGUMENT",
      `At most ${MAX_EVAL_RULES_PER_VERSION} evalRules are allowed per agent version`,
    );
  }
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      throw afrError("INVALID_ARGUMENT", "Each evalRules entry must be an object");
    }
    const kind = (rule as Record<string, unknown>)["kind"];
    if (typeof kind !== "string" || !KNOWN_RULE_KINDS.has(kind as EvalRule["kind"])) {
      throw afrError(
        "INVALID_ARGUMENT",
        `Unknown evalRules rule kind "${String(kind)}". Must be one of: ${[...KNOWN_RULE_KINDS].join(", ")}`,
      );
    }
  }
}
