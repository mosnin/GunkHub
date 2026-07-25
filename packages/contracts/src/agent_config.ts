// ---------------------------------------------------------------------------
// AgentConfigSnapshot — giving `AgentVersion.configSnapshot` a shape the
// divergence engine can actually reason over, WITHOUT invalidating a single
// stored snapshot.
//
// ---------------------------------------------------------------------------
// THE PROBLEM THIS SOLVES
// ---------------------------------------------------------------------------
//
// `agent_versions.configSnapshot` is `v.optional(v.any())` and free-form by
// deliberate decision (ADR-0019). The divergence engine
// (`packages/contracts/src/divergence.ts`) can only PROVE something when the
// target version makes an enumerable claim — "these are my tools" — and a
// free-form blob makes no claims at all. The correct behaviour on a blob is
// therefore `indeterminate`, and that is exactly what the engine does.
//
// Which means that on real data today, the flagship replay test answers "I
// cannot tell" for almost every run. A replay test that says `indeterminate`
// most of the time is not a cautious product, it is an unusable one — and
// worse, it trains operators to click past the verdict, which is precisely how
// a real breaking change gets shipped. The fix is NOT to weaken the
// anti-false-clean rule. It is to make it possible for a snapshot to say
// something checkable.
//
// ---------------------------------------------------------------------------
// THE FOUR RULES THIS TYPE IS BUILT ON
// ---------------------------------------------------------------------------
//
// 1. FREE-FORM STAYS LEGAL. This is additive and opt-in. A snapshot that is
//    not in this shape is not invalid — it is UNDECLARED, and reads exactly as
//    it does today. Nothing stored needs migrating, which matters because
//    `AgentVersion` is immutable once created (CLAUDE.md): there is no
//    rewriting a snapshot, ever. {@link readAgentConfigSnapshot} is the single
//    tolerant reader, and it returns `null` for anything that is not
//    self-describing rather than guessing at a blob's meaning.
//
// 2. SELF-DESCRIBING, PER DIMENSION. Declaration is per-dimension, not
//    per-snapshot. A snapshot that declares its tools and says nothing about
//    budgets must yield real proofs about tools and `indeterminate` about
//    budgets — not a global shrug, and never a global clean. Presence of the
//    field IS the declaration; see {@link declaredDimensions}.
//
// 3. "NONE" AND "UNKNOWN" ARE DIFFERENT ANSWERS, AND BOTH ARE SAYABLE. This
//    is the highest-leverage part of the design. An agent that legitimately
//    has no tools can say so (`{ declared: 'none' }`), and that is a COMPLETE,
//    ANALYSABLE claim: every recorded tool call contradicts it. Today that
//    same agent is indistinguishable from one whose tool list was never
//    captured. Being able to declare emptiness turns a permanent
//    `indeterminate` into a real verdict at zero cost.
//
// 4. AN INCOMPLETE LIST CAN NEVER PRODUCE A PROOF. The catastrophic failure
//    mode of this whole feature is a snapshot whose `tools: []` means "the
//    capture failed" rather than "there are no tools" — every recorded tool
//    call then looks like a call to a removed tool, and the engine reports
//    proven breakage for a version that is fine. So completeness is not
//    inferred from an array being present: a producer must SAY
//    `declared: 'enumerated'` (a complete list) or `declared: 'partial'`
//    (these exist, absence proves nothing). Only `enumerated` and `none` can
//    carry a proof. A producer that cannot honestly claim completeness cannot
//    accidentally claim it.
// ---------------------------------------------------------------------------

import type { DivergenceDimension } from "./divergence.js";

/**
 * The self-describing marker. Its presence — and only its presence — is what
 * makes a `configSnapshot` structured. A free-form blob that happens to have a
 * `tools` key is still free-form, because it never claimed otherwise.
 */
export const AGENT_CONFIG_SNAPSHOT_SCHEMA = "afr.agent-config/1";

/**
 * How a list-shaped dimension was captured. THE COMPLETENESS CLAIM, and the
 * single gate on whether the engine may derive a proof from an absence.
 */
export type DeclarationCompleteness =
  /** A COMPLETE list. Absence of a name from it is a fact, and can carry a proof. */
  | "enumerated"
  /** These exist; there may be others. Absence proves NOTHING and can never carry a proof. */
  | "partial";

/** One tool the version declares. */
export interface DeclaredTool {
  name: string;
  /**
   * JSON-Schema-shaped argument spec, when the producer has one. Optional:
   * naming a tool is useful on its own, and a missing schema simply means
   * `tool_call_rejected_by_schema` is not decidable for it (which the engine
   * reports as an unanswered question, not as a pass).
   */
  parameters?: {
    properties?: Record<string, { type?: string }>;
    required?: string[];
    /** When `false`, an argument key outside `properties` is a REJECTION, and therefore provable. */
    additionalProperties?: boolean;
  };
  /** Free text. Changes here are speculative by construction — a description steers selection and nothing more can be said. */
  description?: string;
}

/**
 * The tool-set claim.
 *
 * `none` is deliberately its own variant rather than `enumerated` with an
 * empty array: they mean the same thing to the engine, but only one of them is
 * a sentence a producer can write by accident.
 */
export type DeclaredToolset =
  | { declared: "enumerated"; tools: DeclaredTool[] }
  | { declared: "partial"; tools: DeclaredTool[] }
  | { declared: "none" }
  /** Explicitly unknown. Distinct from ABSENT only in that it is on the record; both read as undeclared. */
  | { declared: "unknown"; why?: string };

/** The model claim: which models this version may call. */
export type DeclaredModels =
  /** The COMPLETE permitted set. A recorded model outside it is provable. */
  | { declared: "enumerated"; models: string[] }
  | { declared: "partial"; models: string[] }
  | { declared: "unknown"; why?: string };

/**
 * Hard, countable ceilings — the only kind of budget the event log can
 * contradict. A wall-clock timeout is deliberately absent: the log does not
 * measure it, so it could never be proven and would only add a dimension that
 * is permanently unanswerable.
 *
 * `unbounded` is a real, analysable claim: nothing can exceed no ceiling, so
 * the dimension is assessed and clean.
 */
export type DeclaredBudgets =
  | {
      declared: "values";
      maxSteps?: number;
      maxToolCalls?: number;
      maxTokensIn?: number;
      maxTokensOut?: number;
    }
  | { declared: "unbounded" }
  | { declared: "unknown"; why?: string };

/** Decoding parameters. Only ever a source of speculative findings — a distribution change is not a contradiction. */
export type DeclaredDecodingParams =
  | { declared: "values"; temperature?: number; topP?: number; seed?: number; stop?: string[] }
  | { declared: "defaults" }
  | { declared: "unknown"; why?: string };

/**
 * The system prompt, as a DIGEST rather than text.
 *
 * The engine only ever asks "did this change?", and a digest answers that
 * exactly. Carrying the text instead would duplicate it into every snapshot,
 * inflate a document store this repo works hard to keep lean (Event Log Rule
 * 3), and put prompt content — routinely the most sensitive string in the
 * system — into a second place it has to be redacted from.
 */
export type DeclaredPrompt =
  | { declared: "digest"; sha256: string; length: number }
  | { declared: "none" }
  | { declared: "unknown"; why?: string };

/** Named capabilities: retrieval sources, MCP servers, integrations. Same completeness rules as tools. */
export type DeclaredCapabilities =
  | { declared: "enumerated"; capabilities: string[] }
  | { declared: "partial"; capabilities: string[] }
  | { declared: "none" }
  | { declared: "unknown"; why?: string };

/**
 * A structured `AgentVersion.configSnapshot`.
 *
 * EVERY DIMENSION IS OPTIONAL, and that is the whole point: partial
 * declaration must be honestly partial. Omitting `budgets` is not a claim that
 * there are none — it is the absence of a claim, and the engine reports it as
 * an unanswered question about budgets while still proving whatever it can
 * about the dimensions that WERE declared.
 *
 * Stored as the `configSnapshot` value itself (it is `v.any()`, so no Convex
 * schema change is required to start writing one — which is what makes this
 * adoptable version by version instead of all at once).
 */
export interface AgentConfigSnapshot {
  /** Must equal {@link AGENT_CONFIG_SNAPSHOT_SCHEMA}. The marker that makes this readable at all. */
  $schema: string;
  tools?: DeclaredToolset;
  model?: DeclaredModels;
  budgets?: DeclaredBudgets;
  decodingParams?: DeclaredDecodingParams;
  systemPrompt?: DeclaredPrompt;
  capabilities?: DeclaredCapabilities;
  /**
   * Anything else the producer wants to keep. PRESERVED VERBATIM AND NEVER
   * INTERPRETED — this is what lets a team adopt the structured form without
   * dropping the free-form fields their own tooling already reads.
   */
  extra?: Record<string, unknown>;
}

/**
 * Read a stored `configSnapshot` as a structured snapshot, or `null` when it
 * is free-form.
 *
 * TOLERANT, BUT NEVER CREATIVE. It checks the marker and nothing else: a
 * dimension whose value is malformed is left exactly as it was found, for the
 * engine to report as `target_config_unreadable` (an unanswered question)
 * rather than being silently repaired into a claim nobody made. Repairing a
 * malformed tool list into an empty one would manufacture proofs out of a
 * parsing bug — the single worst thing this file could do.
 *
 * @returns the snapshot, or `null` for absent / non-object / unmarked values.
 */
export function readAgentConfigSnapshot(snapshot: unknown): AgentConfigSnapshot | null {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const marker = (snapshot as { $schema?: unknown }).$schema;
  if (marker !== AGENT_CONFIG_SNAPSHOT_SCHEMA) return null;
  return snapshot as AgentConfigSnapshot;
}

/**
 * Which dimensions this snapshot actually makes a claim about.
 *
 * `declared: 'unknown'` counts as UNDECLARED, deliberately: it is on the
 * record as a non-answer, and a non-answer is not something to reason from.
 * The distinction it does buy is honesty about intent — "we looked and could
 * not capture the tool list" is worth saying, and an engine can surface it as
 * a remedy ("re-publish this version with its tool list") instead of a shrug.
 *
 * A free-form snapshot declares nothing, which is why every run against one is
 * `indeterminate` today.
 */
export function declaredDimensions(snapshot: AgentConfigSnapshot | null): DivergenceDimension[] {
  if (snapshot === null) return [];
  const declared: DivergenceDimension[] = [];
  if (snapshot.tools !== undefined && snapshot.tools.declared !== "unknown") declared.push("tools");
  if (snapshot.model !== undefined && snapshot.model.declared !== "unknown") declared.push("model");
  if (snapshot.budgets !== undefined && snapshot.budgets.declared !== "unknown") declared.push("budgets");
  if (snapshot.decodingParams !== undefined && snapshot.decodingParams.declared !== "unknown") {
    declared.push("decoding_params");
  }
  if (snapshot.systemPrompt !== undefined && snapshot.systemPrompt.declared !== "unknown") {
    declared.push("system_prompt");
  }
  if (snapshot.capabilities !== undefined && snapshot.capabilities.declared !== "unknown") {
    declared.push("capabilities");
  }
  return declared;
}

/**
 * May a divergence PROOF be derived from this dimension's declaration?
 *
 * THE ONE PREDICATE THAT STANDS BETWEEN A CAPTURE BUG AND A FALSE PROVEN
 * FINDING. Only a COMPLETE claim can make an absence meaningful:
 *
 *   - `enumerated` / `none` / `values` / `unbounded` -> yes. The producer
 *     asserted the whole picture, so what is missing from it is missing.
 *   - `partial` -> NO. "These tools exist" says nothing about a tool that is
 *     not in the list, and treating it as a complete list is exactly how a
 *     half-captured snapshot condemns a healthy version.
 *   - `unknown` / absent -> no, obviously.
 *
 * A dimension that fails this check is not a pass and not a failure: the
 * engine must report it as an unanswered question
 * (`IndeterminateDivergence`), which keeps the verdict honest and, unlike a
 * silent skip, tells the operator exactly what to fix.
 */
export function supportsProof(
  declaration:
    | DeclaredToolset
    | DeclaredModels
    | DeclaredBudgets
    | DeclaredCapabilities
    | DeclaredDecodingParams
    | DeclaredPrompt
    | undefined
): boolean {
  if (declaration === undefined) return false;
  switch (declaration.declared) {
    case "enumerated":
    case "none":
    case "values":
    case "unbounded":
      return true;
    default:
      // `partial`, `unknown`, `digest`, `defaults` — none of them makes an
      // absence meaningful. `digest`/`defaults` are complete claims but about
      // dimensions that are speculative by nature; there is no proof to
      // derive from them either way.
      return false;
  }
}
