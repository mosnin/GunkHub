// ---------------------------------------------------------------------------
// REPLAY DIVERGENCE ENGINE
//
// Answers exactly one question: "I have a new AgentVersion. Against this run's
// recorded history, where would it have DIVERGED?" — and its fleet form.
//
// PURE. Deterministic. No `ctx`, no `ctx.db`, no I/O, no `Date.now()`, no
// randomness, no recursion into unbounded structures. Same posture as
// convex/helpers/{otel_mapping,analytics,evals,pricing,failure_summary}.ts —
// a function from (recorded facts, two config snapshots) to a report, testable
// with plain arrays. `analyzedAt` is an INPUT for exactly the reason
// `otel_mapping.ts` takes `receivedAt` as one: it is the single genuinely
// wall-clock-dependent field, and taking it as a parameter is what lets this
// module stay pure while still emitting a complete report.
//
// ===========================================================================
// PART 0 — NO EXECUTION
// ===========================================================================
//
// We do not run agent code, call a model, or simulate. This is a STRUCTURAL
// analysis over (recorded events, baseline configSnapshot, target
// configSnapshot). That is what makes it deterministic, cheap and honest, and
// it is what Temporal's replay test does: check new code against old history
// for non-determinism, do not re-execute the world.
//
// ===========================================================================
// PART 1 — THE CONTRACT THIS MIRRORS
// ===========================================================================
//
// The vocabulary below MIRRORS `packages/contracts/src/divergence.ts`, which
// is canonical. `convex/` has no dependency on the contracts package by design
// (convex/package.json), so this is a permitted copy in the same sense as
// `TemporalOrderKey` in convex/helpers/replay_projection.ts and
// `VALID_EVENT_TYPES` in convex/events.ts. KEEP IN SYNC: the kind unions, the
// coverage rules, and `computeDivergenceVerdict` must agree exactly, because
// `FlightReader` re-derives the verdict client-side and treats a server whose
// verdict disagrees with its own contents as untrustworthy.
//
// The contract's central design decision, which this engine implements rather
// than reinterprets: PROVEN and SPECULATIVE are two structurally separate
// types, not one shape with a `severity` field. There is no exported union of
// them here either. A proof must carry its proof (`provenBy` is a non-empty
// tuple); a speculation must state why it cannot be proven
// (`speculativeBecause` is required).
//
// ===========================================================================
// PART 2 — WHY EVERY DIMENSION IS TRI-STATE, NOT BOOLEAN
// ===========================================================================
//
// `agent_versions.configSnapshot` is `v.optional(v.any())` and, per
// docs/adrs/0019_agent_version_identity.md Decision 2, is DELIBERATELY
// unstructured: "No schema validation occurs beyond 'it must be a
// JSON-serializable value.'" There is no canonical shape and no required key.
// Every reader of it is guessing, and this module's job is to guess OUT LOUD.
//
// So each dimension resolves to `read` / `absent` / `malformed` INDEPENDENTLY
// on each side, and:
//
//   * absent on the TARGET  -> `target_dimension_absent`. Emphatically NOT a
//                              removal. A target with no `tools` key does not
//                              have zero tools; it has an uncaptured tool
//                              list. Emitting `tool_removed` there would
//                              fabricate a PROOF out of missing metadata —
//                              the single most dangerous bug possible here.
//   * absent on the BASELINE-> `baseline_config_missing` for SPECULATIVE
//                              dimensions only. Proven kinds need only the
//                              target, so a run with no recorded baseline is
//                              still fully analysable for proof.
//   * `tools: []` PRESENT   -> readable, genuinely empty, and a real proof
//                              that every recorded call was removed.
//
// The distinction between "the key is absent" and "the key is present and
// empty" is load-bearing, and is tested.
//
// SILENT-EMPTY-AS-SUCCESS IS THE FAILURE MODE THIS MODULE IS BUILT AGAINST.
// `verdict: "compatible"` is reachable ONLY when every dimension was assessed
// AND the event history was read to the end AND nothing was found. There is no
// code path that turns "we could not look" into "we looked and it was fine".
// ---------------------------------------------------------------------------

// ===========================================================================
// PART 3 — THE CONTRACT VOCABULARY, IMPORTED (not mirrored)
// ===========================================================================
//
// These types and functions are IMPORTED from
// `packages/contracts/src/divergence.ts`, which is canonical. There is no copy
// of them in this file.
//
// WHY THIS FILE DOES NOT FOLLOW THE `convex/` MIRROR PRECEDENT. Two other
// mirrors exist here — `TemporalOrderKey` in helpers/replay_projection.ts and
// `VALID_EVENT_TYPES` in events.ts — both justified by "convex/ has no
// dependency on the contracts package by design". That justification was
// TESTED rather than inherited, and it does not hold: adding the workspace
// dependency to convex/package.json makes both the TYPES and the RUNTIME
// functions (`computeDivergenceVerdict`, `isFleetScanComplete`,
// `isDivergenceCoverageComplete`) resolve and EXECUTE inside the Convex
// isolate. Verified end to end through the convex-test harness before this
// import was written.
//
// It matters more here than for a comparator: this feature's entire
// credibility is the PROVEN/SPECULATIVE boundary, and a mirror is two
// definitions of that boundary that can silently disagree. A drifted
// comparator sorts wrong; a drifted certainty boundary green-lights a deploy.
//
// THE ONE COST, STATED: `@agent-flight-recorder/contracts` resolves through
// `dist/`, which is a gitignored build artifact. `convex typecheck` and
// `convex deploy` now require `packages/contracts` to be BUILT first. That is a
// real build-ordering coupling and it needs a turbo pipeline edge
// (platform-owned) — see the report accompanying this change.

export type {
  DivergenceCoverage,
  DivergenceDimension,
  DivergenceEventCitation,
  DivergenceProof,
  DivergenceScanWindow,
  DivergenceUnassessedDimension,
  DivergenceUnassessedReason,
  DivergenceVerdict,
  DivergenceVerdictInput,
  IndeterminateDivergence,
  IndeterminateDivergenceKind,
  IndeterminateDivergenceReason,
  ProvenDivergence,
  ProvenDivergenceKind,
  ProvenDivergenceReason,
  SpeculativeDivergence,
  SpeculativeDivergenceKind,
  SpeculativeDivergenceReason,
} from "@agent-flight-recorder/contracts";

export {
  computeDivergenceVerdict,
  DIVERGENCE_DIMENSIONS,
  isDivergenceCoverageComplete,
  isFleetScanComplete,
  MAX_DIVERGENCE_REPRESENTATIVE_RUNS,
} from "@agent-flight-recorder/contracts";

import {
  readAgentConfigSnapshot,
  supportsProof,
  computeDivergenceVerdict,
  DIVERGENCE_DIMENSIONS,
  isDivergenceCoverageComplete,
  isFleetScanComplete,
  MAX_DIVERGENCE_REPRESENTATIVE_RUNS,
} from "@agent-flight-recorder/contracts";

import type {
  AgentConfigSnapshot,
  IndeterminateDivergenceReason,
  DivergenceCoverage,
  DivergenceDimension,
  DivergenceEventCitation,
  DivergenceProof,
  DivergenceScanWindow,
  DivergenceUnassessedDimension,
  DivergenceVerdict,
  IndeterminateDivergence,
  ProvenDivergence,
  ProvenDivergenceReason,
  SpeculativeDivergence,
  SpeculativeDivergenceReason,
} from "@agent-flight-recorder/contracts";

/** Cap on proofs carried per proven finding: a reason, not an exhaustive transcript. */
export const MAX_PROOFS_PER_FINDING = 10;

/** Cap on navigation hints carried per speculative finding. */
export const MAX_AFFECTED_SEQ_HINTS = 10;

/** Every dimension, in report order. Re-exported name kept for this module's callers. */
export const ALL_DIVERGENCE_DIMENSIONS: readonly DivergenceDimension[] = DIVERGENCE_DIMENSIONS;

/** Single-run report, shaped as contracts `DivergenceReport` minus the ids the ctx layer owns. */
export interface RunDivergenceAnalysis {
  verdict: DivergenceVerdict;
  proven: ProvenDivergence[];
  speculative: SpeculativeDivergence[];
  /**
   * Questions this analysis COULD NOT ANSWER — a first-class array, not the
   * absence of findings and not a boolean on `coverage`.
   *
   * SCOPE, and why it is narrower than `coverage.unassessed`: a dimension the
   * target NEVER DECLARED is `undeclared`, which the coverage record and
   * `divergenceByDimension`'s `DimensionState` already carry, and which is
   * fixed by declaring it. This array carries the questions that were ASKED and
   * came back unanswerable — an unreadable shape, a history we could not read
   * to the end, evidence that went to blob storage. `IndeterminateDivergenceKind`
   * has no "never declared" member for exactly that reason.
   */
  indeterminate: IndeterminateDivergence[];
  coverage: DivergenceCoverage;
}

// ===========================================================================
// PART 4 — READING AN UNSTRUCTURED configSnapshot
// ===========================================================================

export type FacetStatus = "read" | "absent" | "malformed";

export interface Facet<T> {
  status: FacetStatus;
  /**
   * May an ABSENCE from this facet's value carry a PROOF?
   *
   * True only for a COMPLETE claim. A `partial` declaration ("these tools
   * exist; there may be others") is readable and perfectly usable for
   * speculation, but an absence from it proves nothing — treating it as
   * complete is precisely how a half-captured snapshot condemns a healthy
   * version. Contracts' `supportsProof` is the authority; this field carries
   * its answer to the analysis stage.
   *
   * The legacy free-form path sets this true for any readable facet, which
   * preserves exactly the behaviour that shipped before structured snapshots
   * existed.
   */
  proofCapable?: boolean;
  value?: T;
  /** The config path matched, or why it could not be read. Surfaces in `unassessed[].detail`. */
  note?: string;
  /** The config path this facet was read from, for `targetConfigPath` / `changedConfigPath`. */
  path?: string;
}

export interface ToolParamSpec {
  name: string;
  required: boolean;
}

export interface ToolSpec {
  name: string;
  /** `null` = declared by NAME ONLY; its parameter contract is unknown, so no argument claim is possible. */
  params: ToolParamSpec[] | null;
  /** `true` only on an explicit `additionalProperties: false`. `null` = unknown. */
  closed: boolean | null;
  description?: string;
}

export interface ReadConfig {
  snapshotStatus: "object" | "absent" | "not-an-object";
  /** True when this came from a structured `AgentConfigSnapshot` rather than the free-form reader. */
  structured: boolean;
  tools: Facet<ToolSpec[]>;
  /** Enumerated allowed models when the snapshot lists several; a single `model` string reads as a one-element list. */
  models: Facet<{ list: string[]; enumerated: boolean }>;
  prompt: Facet<string>;
  /** Hard structural ceilings: max_tokens, maxToolCalls, maxSteps. */
  budgets: Facet<Record<string, number>>;
  /** Decoding parameters: temperature, top_p, top_k, seed, penalties. */
  decoding: Facet<Record<string, number>>;
  capabilities: Facet<string[]>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick(obj: Record<string, unknown>, keys: string[]): { key: string; value: unknown } | undefined {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) return { key: k, value: obj[k] };
  }
  return undefined;
}

/**
 * Container keys agent configs conventionally nest under. Lookup is
 * deliberately SHALLOW (one level): a deep search starts matching keys that
 * mean something else and manufactures confident findings out of coincidence.
 */
const NESTED_CONTAINERS = ["config", "llm", "model_config", "modelConfig", "params", "parameters", "generation", "budgets", "limits"];

function pickNested(root: Record<string, unknown>, keys: string[]): { key: string; value: unknown } | undefined {
  const direct = pick(root, keys);
  if (direct) return direct;
  for (const container of NESTED_CONTAINERS) {
    const inner = root[container];
    if (isPlainObject(inner)) {
      const hit = pick(inner, keys);
      if (hit) return { key: `${container}.${hit.key}`, value: hit.value };
    }
  }
  return undefined;
}

const TOOL_KEYS = ["tools", "toolNames", "tool_names", "availableTools", "available_tools", "allowedTools", "allowed_tools", "functions"];
const MODEL_LIST_KEYS = ["models", "allowedModels", "allowed_models", "permittedModels"];
const MODEL_KEYS = ["model", "modelId", "model_id", "modelName", "model_name"];
const PROMPT_KEYS = ["systemPrompt", "system_prompt", "system", "instructions", "prompt"];
const CAPABILITY_KEYS = ["capabilities", "integrations", "mcpServers", "mcp_servers", "retrievalSources", "retrieval_sources"];

const BUDGET_KEYS = ["max_tokens", "maxTokens", "max_output_tokens", "maxOutputTokens", "maxToolCalls", "max_tool_calls", "maxSteps", "max_steps"];
const DECODING_KEYS = ["temperature", "top_p", "topP", "top_k", "topK", "seed", "frequency_penalty", "presence_penalty"];

/** Canonical spelling, so a rename between snapshots is not reported as drift. */
const PARAM_ALIAS: Record<string, string> = {
  maxTokens: "max_tokens",
  maxOutputTokens: "max_tokens",
  max_output_tokens: "max_tokens",
  max_tool_calls: "maxToolCalls",
  max_steps: "maxSteps",
  topP: "top_p",
  topK: "top_k",
};

function canonicalParamName(name: string): string {
  return PARAM_ALIAS[name] ?? name;
}

function parseToolEntry(entry: unknown, fallbackName?: string): ToolSpec | undefined {
  if (typeof entry === "string") {
    // WHOSE NAME IS THIS STRING? It depends entirely on which branch called us,
    // and conflating the two produced a FALSE PROOF:
    //
    //   ARRAY form  `tools: ["search_web"]`            -> the string IS the name.
    //   MAP form    `tools: { search_web: "Search…" }` -> the KEY is the name and
    //                                                    the string is a DESCRIPTION.
    //
    // Discarding `fallbackName` here made `{search_web: "Search the web"}` parse
    // as a tool literally named "Search the web", so a run calling `search_web`
    // was proven `tool_removed` — "the target declares no such tool" — about a
    // tool the target plainly declares. A `{name: description}` map is an
    // entirely ordinary way to write a tool list, and a false proof is the
    // catastrophic direction for this feature.
    if (fallbackName !== undefined) {
      const description = entry.trim();
      return { name: fallbackName, params: null, closed: null, ...(description.length > 0 ? { description } : {}) };
    }
    const name = entry.trim();
    return name.length > 0 ? { name, params: null, closed: null } : undefined;
  }
  if (!isPlainObject(entry)) return undefined;

  const fn = isPlainObject(entry["function"]) ? (entry["function"]) : entry;

  const rawName = pick(fn, ["name", "toolName", "tool_name"])?.value;
  const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : fallbackName;
  if (!name) return undefined;

  const rawDescription = pick(fn, ["description", "doc", "docstring"])?.value;
  const description = typeof rawDescription === "string" ? rawDescription : undefined;

  const schema = pick(fn, ["parameters", "input_schema", "inputSchema", "schema"])?.value;
  if (!isPlainObject(schema)) return { name, params: null, closed: null, ...(description ? { description } : {}) };

  const properties = schema["properties"];
  if (!isPlainObject(properties)) return { name, params: null, closed: null, ...(description ? { description } : {}) };

  const requiredRaw = schema["required"];
  const required = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter((r): r is string => typeof r === "string") : [],
  );
  // UNION of `properties` and `required`, not just `properties`. JSON Schema
  // permits a name in `required` with no matching `properties` entry, and such
  // a name IS still required. Reading only `properties` silently drops exactly
  // the constraint most likely to break a recorded call — a newly-added
  // mandatory parameter — which is a FALSE CLEAN, the worst direction for this
  // engine to be wrong in. Caught by a test, not by review.
  const names = new Set<string>([...Object.keys(properties), ...required]);
  const params: ToolParamSpec[] = [...names].map((p) => ({ name: p, required: required.has(p) }));

  // ONLY an explicit `false` closes the schema. `undefined` is not "closed" —
  // JSON Schema's default is open, and treating unknown as closed would
  // manufacture PROOFS out of a missing key.
  const closed = schema["additionalProperties"] === false ? true : schema["additionalProperties"] === undefined ? null : false;

  return { name, params, closed, ...(description ? { description } : {}) };
}

function readTools(root: Record<string, unknown>): Facet<ToolSpec[]> {
  const hit = pickNested(root, TOOL_KEYS);
  if (!hit) {
    return { status: "absent", note: `no tool list under any of: ${TOOL_KEYS.join(", ")} (absent is NOT an empty tool list)` };
  }
  const { key, value } = hit;

  const collect = (entries: Array<[unknown, string | undefined]>): Facet<ToolSpec[]> => {
    const specs: ToolSpec[] = [];
    let unreadable = 0;
    for (const [entry, fallback] of entries) {
      const spec = parseToolEntry(entry, fallback) ?? (fallback && (isPlainObject(entry) || entry === null) ? { name: fallback, params: null, closed: null } : undefined);
      if (spec) specs.push(spec);
      else unreadable += 1;
    }
    // Any unreadable entry means the target's true capability set is a
    // SUPERSET of what we parsed, which would make `tool_removed` unsound.
    // Refuse the whole dimension rather than prove something from a partial list.
    if (unreadable > 0) {
      return { status: "malformed", path: key, note: `"${key}" has ${unreadable} unparseable entr${unreadable === 1 ? "y" : "ies"}; refusing a partial tool list rather than risk a false proof` };
    }
    return { status: "read", value: specs, path: key, note: `${specs.length} tool(s) from "${key}"` };
  };

  if (Array.isArray(value)) return collect(value.map((e) => [e, undefined]));
  if (isPlainObject(value)) return collect(Object.entries(value).map(([name, def]) => [def, name]));
  return { status: "malformed", path: key, note: `"${key}" is ${value === null ? "null" : typeof value}, expected an array or object` };
}

function readModels(root: Record<string, unknown>): Facet<{ list: string[]; enumerated: boolean }> {
  const listHit = pickNested(root, MODEL_LIST_KEYS);
  if (listHit) {
    if (!Array.isArray(listHit.value)) {
      return { status: "malformed", path: listHit.key, note: `"${listHit.key}" is not an array` };
    }
    const list: string[] = [];
    for (const m of listHit.value) {
      if (typeof m === "string" && m.trim().length > 0) list.push(m.trim());
      else if (isPlainObject(m) && typeof m["name"] === "string") list.push((m["name"]).trim());
      else return { status: "malformed", path: listHit.key, note: `"${listHit.key}" has an unparseable entry` };
    }
    return { status: "read", value: { list, enumerated: true }, path: listHit.key, note: `${list.length} allowed model(s) from "${listHit.key}"` };
  }

  const hit = pickNested(root, MODEL_KEYS);
  if (!hit) return { status: "absent", note: `no model under any of: ${[...MODEL_LIST_KEYS, ...MODEL_KEYS].join(", ")}` };
  if (isPlainObject(hit.value)) {
    const inner = pick(hit.value, ["name", "id"])?.value;
    if (typeof inner === "string" && inner.trim().length > 0) {
      return { status: "read", value: { list: [inner.trim()], enumerated: true }, path: `${hit.key}.name` };
    }
    return { status: "malformed", path: hit.key, note: `"${hit.key}" is an object with no readable name/id` };
  }
  if (typeof hit.value !== "string" || hit.value.trim().length === 0) {
    return { status: "malformed", path: hit.key, note: `"${hit.key}" is ${hit.value === null ? "null" : typeof hit.value}, expected a non-empty string` };
  }
  return { status: "read", value: { list: [hit.value.trim()], enumerated: true }, path: hit.key };
}

function readPrompt(root: Record<string, unknown>): Facet<string> {
  const hit = pickNested(root, PROMPT_KEYS);
  if (!hit) return { status: "absent", note: `no system prompt under any of: ${PROMPT_KEYS.join(", ")}` };
  if (typeof hit.value === "string") return { status: "read", value: hit.value, path: hit.key };
  // Message-array prompts: joined for EQUALITY comparison only. This text is
  // never interpreted, diffed, summarised, or scored — see the note on
  // `system_prompt_changed`.
  if (Array.isArray(hit.value)) {
    const parts: string[] = [];
    for (const m of hit.value) {
      if (typeof m === "string") parts.push(m);
      else if (isPlainObject(m) && typeof m["content"] === "string") parts.push(m["content"]);
      else return { status: "malformed", path: hit.key, note: `"${hit.key}" is an array with non-textual entries` };
    }
    return { status: "read", value: parts.join("\n"), path: hit.key };
  }
  return { status: "malformed", path: hit.key, note: `"${hit.key}" is ${hit.value === null ? "null" : typeof hit.value}, expected a string` };
}

function readNumericGroup(root: Record<string, unknown>, keys: string[], label: string): Facet<Record<string, number>> {
  const out: Record<string, number> = {};
  /** Which source spelling supplied each canonical name, for conflict detection. */
  const sourceOf: Record<string, string> = {};
  let sawKey = false;
  let firstPath: string | undefined;
  let malformed: string | undefined;
  for (const key of keys) {
    const hit = pickNested(root, [key]);
    if (!hit) continue;
    sawKey = true;
    firstPath = firstPath ?? hit.key;
    if (typeof hit.value === "number" && Number.isFinite(hit.value)) {
      const canonical = canonicalParamName(key);
      const existing = out[canonical];
      if (existing !== undefined && existing !== hit.value) {
        // TWO DECLARED ALIASES THAT DISAGREE. `PARAM_ALIAS` collapses four
        // spellings onto `max_tokens`, and plain assignment made this
        // LAST-WRITE-WINS in key-list order: `{max_tokens: 4000,
        // max_output_tokens: 100}` silently resolved to 100, turning an
        // ordinary 500-token generation into a PROVEN `budget_exceeded`.
        //
        // There is no honest tie-break. We cannot know which spelling the
        // runtime actually honoured, so the config is AMBIGUOUS, not
        // decidable — and a proof must never rest on a coin flip. Refusing
        // the whole dimension routes this to `unsupported_config_shape`
        // coverage and an `indeterminate` verdict, which is the correct
        // answer to an ambiguous config.
        return {
          status: "malformed",
          ...(firstPath ? { path: firstPath } : {}),
          note: `conflicting aliases for "${canonical}": "${sourceOf[canonical]}" is ${existing} but "${hit.key}" is ${hit.value}. The config is ambiguous — which spelling the runtime honoured is not knowable from the snapshot, so no claim is made about ${label}.`,
        };
      }
      out[canonical] = hit.value;
      sourceOf[canonical] = hit.key;
    } else if (hit.value !== undefined && hit.value !== null) {
      malformed = malformed ?? `"${hit.key}" is ${typeof hit.value}, expected a finite number`;
    }
  }
  if (!sawKey) return { status: "absent", note: `no recognised ${label} under any of: ${keys.join(", ")}` };
  if (malformed && Object.keys(out).length === 0) return { status: "malformed", note: malformed, ...(firstPath ? { path: firstPath } : {}) };
  return { status: "read", value: out, ...(firstPath ? { path: firstPath } : {}), ...(malformed ? { note: `partially readable: ${malformed}` } : {}) };
}

function readCapabilities(root: Record<string, unknown>): Facet<string[]> {
  const hit = pickNested(root, CAPABILITY_KEYS);
  if (!hit) return { status: "absent", note: `no capability list under any of: ${CAPABILITY_KEYS.join(", ")}` };
  const names: string[] = [];
  if (Array.isArray(hit.value)) {
    for (const c of hit.value) {
      if (typeof c === "string" && c.trim().length > 0) names.push(c.trim());
      else if (isPlainObject(c) && typeof c["name"] === "string") names.push((c["name"]).trim());
      else return { status: "malformed", path: hit.key, note: `"${hit.key}" has an unparseable entry` };
    }
  } else if (isPlainObject(hit.value)) {
    names.push(...Object.keys(hit.value));
  } else {
    return { status: "malformed", path: hit.key, note: `"${hit.key}" is ${typeof hit.value}, expected an array or object` };
  }
  return { status: "read", value: names, path: hit.key };
}

/**
 * Read a STRUCTURED snapshot (`$schema: "afr.agent-config/1"`).
 *
 * THIS IS WHAT STOPS THE FEATURE SHRUGGING ON REAL DATA. Under the free-form
 * path, an absent dimension is indistinguishable from an unmade claim, so the
 * honest answer is always `indeterminate` — correct, and useless. A structured
 * snapshot lets a producer say the thing that could not previously be said:
 *
 *   `tools: { declared: "none" }`      — "this version has NO tools." A
 *                                        COMPLETE claim, so every recorded
 *                                        tool call is a provable removal.
 *   `budgets: { declared: "unbounded" }` — "no ceilings." Also complete:
 *                                        nothing can exceed no ceiling, so the
 *                                        dimension is assessed AND clean,
 *                                        rather than permanently unanswered.
 *   `tools: { declared: "partial" }`   — "these exist; there may be others."
 *                                        Readable, comparable, and NEVER
 *                                        proof-bearing.
 *
 * The prompt arrives as a DIGEST, never text. Equality of digests answers the
 * only question this engine asks of a prompt ("did it change?") without
 * copying the most sensitive string in the system into a second place.
 */
function readStructuredSnapshot(cfg: AgentConfigSnapshot): ReadConfig {
  const absent = <T>(what: string): Facet<T> => ({
    status: "absent",
    note: `this version's structured snapshot makes no claim about ${what}`,
  });

  const tools: Facet<ToolSpec[]> =
    cfg.tools === undefined || cfg.tools.declared === "unknown"
      ? absent("its tool set")
      : {
          status: "read",
          value:
            cfg.tools.declared === "none"
              ? []
              : cfg.tools.tools.map((t) => ({
                  name: t.name,
                  params:
                    t.parameters?.properties === undefined && t.parameters?.required === undefined
                      ? null
                      : [
                          ...new Set([
                            ...Object.keys(t.parameters?.properties ?? {}),
                            ...(t.parameters?.required ?? []),
                          ]),
                        ].map((n) => ({ name: n, required: (t.parameters?.required ?? []).includes(n) })),
                  closed:
                    t.parameters?.additionalProperties === false
                      ? true
                      : t.parameters?.additionalProperties === undefined
                        ? null
                        : false,
                  ...(t.description !== undefined ? { description: t.description } : {}),
                })),
          path: "tools",
          proofCapable: supportsProof(cfg.tools),
          note: `declared: ${cfg.tools.declared}`,
        };

  const models: Facet<{ list: string[]; enumerated: boolean }> =
    cfg.model === undefined || cfg.model.declared === "unknown"
      ? absent("which models it may call")
      : {
          status: "read",
          value: { list: cfg.model.models, enumerated: cfg.model.declared === "enumerated" },
          path: "model",
          proofCapable: supportsProof(cfg.model),
          note: `declared: ${cfg.model.declared}`,
        };

  const prompt: Facet<string> =
    cfg.systemPrompt === undefined || cfg.systemPrompt.declared === "unknown"
      ? absent("its system prompt")
      : {
          status: "read",
          // The digest IS the comparable value. Length rides along so a change
          // can be described without ever holding the text.
          value:
            cfg.systemPrompt.declared === "none"
              ? ""
              : `sha256:${cfg.systemPrompt.sha256}:${cfg.systemPrompt.length}`,
          path: "systemPrompt",
          proofCapable: false,
          note: `declared: ${cfg.systemPrompt.declared}`,
        };

  const budgets: Facet<Record<string, number>> =
    cfg.budgets === undefined || cfg.budgets.declared === "unknown"
      ? absent("its hard budgets")
      : {
          status: "read",
          // `unbounded` reads as an EMPTY set of ceilings — a complete claim
          // that yields no proof and, correctly, no unanswered question.
          value:
            cfg.budgets.declared === "unbounded"
              ? {}
              : {
                  ...(cfg.budgets.maxSteps !== undefined ? { maxSteps: cfg.budgets.maxSteps } : {}),
                  ...(cfg.budgets.maxToolCalls !== undefined ? { maxToolCalls: cfg.budgets.maxToolCalls } : {}),
                  ...(cfg.budgets.maxTokensOut !== undefined ? { max_tokens: cfg.budgets.maxTokensOut } : {}),
                  ...(cfg.budgets.maxTokensIn !== undefined ? { maxTokensIn: cfg.budgets.maxTokensIn } : {}),
                },
          path: "budgets",
          proofCapable: supportsProof(cfg.budgets),
          note: `declared: ${cfg.budgets.declared}`,
        };

  const decoding: Facet<Record<string, number>> =
    cfg.decodingParams === undefined || cfg.decodingParams.declared === "unknown"
      ? absent("its decoding parameters")
      : {
          status: "read",
          value:
            cfg.decodingParams.declared === "defaults"
              ? {}
              : {
                  ...(cfg.decodingParams.temperature !== undefined ? { temperature: cfg.decodingParams.temperature } : {}),
                  ...(cfg.decodingParams.topP !== undefined ? { top_p: cfg.decodingParams.topP } : {}),
                  ...(cfg.decodingParams.seed !== undefined ? { seed: cfg.decodingParams.seed } : {}),
                },
          path: "decodingParams",
          proofCapable: false,
          note: `declared: ${cfg.decodingParams.declared}`,
        };

  const capabilities: Facet<string[]> =
    cfg.capabilities === undefined || cfg.capabilities.declared === "unknown"
      ? absent("its capabilities")
      : {
          status: "read",
          value: cfg.capabilities.declared === "none" ? [] : cfg.capabilities.capabilities,
          path: "capabilities",
          proofCapable: supportsProof(cfg.capabilities),
          note: `declared: ${cfg.capabilities.declared}`,
        };

  return { snapshotStatus: "object", structured: true, tools, models, prompt, budgets, decoding, capabilities };
}

/**
 * Tolerantly read a free-form configSnapshot into tri-state dimensions.
 *
 * NEVER throws and NEVER guesses a default. An unreadable input produces an
 * explicit `absent`/`malformed`/`not-an-object` status, which becomes an
 * `unassessed` dimension — not an empty config that compares equal to
 * everything.
 */
export function readConfigSnapshot(snapshot: unknown): ReadConfig {
  // MARKER-GATED, not heuristic. `readAgentConfigSnapshot` returns non-null
  // only for a snapshot that explicitly declares the schema, so a producer opts
  // in and nothing is ever reinterpreted underneath one that did not. Everything
  // else falls through to the free-form reader below, unchanged.
  const structured = readAgentConfigSnapshot(snapshot);
  if (structured !== null) return readStructuredSnapshot(structured);

  if (snapshot === undefined || snapshot === null) {
    const absent = <T>(what: string): Facet<T> => ({ status: "absent", note: `configSnapshot is absent, so ${what} is unknown` });
    return {
      snapshotStatus: "absent",
      structured: false,
      tools: absent("the tool list"),
      models: absent("the model"),
      prompt: absent("the system prompt"),
      budgets: absent("hard budgets"),
      decoding: absent("decoding parameters"),
      capabilities: absent("declared capabilities"),
    };
  }
  if (!isPlainObject(snapshot)) {
    const shape = Array.isArray(snapshot) ? "an array" : typeof snapshot;
    const bad = <T>(what: string): Facet<T> => ({ status: "malformed", note: `configSnapshot is ${shape}, not an object, so ${what} is unreadable` });
    return {
      snapshotStatus: "not-an-object",
      structured: false,
      tools: bad("the tool list"),
      models: bad("the model"),
      prompt: bad("the system prompt"),
      budgets: bad("hard budgets"),
      decoding: bad("decoding parameters"),
      capabilities: bad("declared capabilities"),
    };
  }
  return {
    snapshotStatus: "object",
    structured: false,
    tools: readTools(snapshot),
    models: readModels(snapshot),
    prompt: readPrompt(snapshot),
    budgets: readNumericGroup(snapshot, BUDGET_KEYS, "hard budgets"),
    decoding: readNumericGroup(snapshot, DECODING_KEYS, "decoding parameters"),
    capabilities: readCapabilities(snapshot),
  };
}

// ===========================================================================
// PART 5 — THE VERSION-PAIR DELTA (computed ONCE, not once per run)
// ===========================================================================

/**
 * Everything about (baseline, target) that does NOT depend on any run.
 *
 * THIS SPLIT IS THE WHOLE FLEET-SCALE STRATEGY. Every SPECULATIVE finding, and
 * every unassessed-dimension record, is a property of the config pair alone —
 * identical for all 10,000 runs, so it is computed once and costs nothing per
 * run. Only PROVEN kinds need recorded evidence, and therefore only they
 * require reading events.
 */
export interface ConfigDelta {
  baseline: ReadConfig;
  target: ReadConfig;
  speculative: SpeculativeDivergence[];
  /** Questions the CONFIG PAIR alone leaves unanswered — e.g. a partial declaration. Run-independent. */
  indeterminate: IndeterminateDivergence[];
  unassessed: DivergenceUnassessedDimension[];
  assessed: DivergenceDimension[];
  /** Target tools by name, or `null` when the target list is not readable — in which case NO tool proof may be made. */
  targetToolsByName: Map<string, ToolSpec> | null;
  /** Target allowed models, or `null` when not enumerable. */
  targetModels: Set<string> | null;
  /** Readable numeric ceilings on the target: max_tokens, maxToolCalls, ... */
  targetBudgets: Record<string, number>;
  /** Config path each budget was read from, for `targetConfigPath`. */
  targetBudgetPath: string;
  /** True when at least one dimension was assessed. False means nothing can be said at all. */
  anyDimensionAssessed: boolean;
}

function unassessedFor(
  dimension: DivergenceDimension,
  baselineFacet: Facet<unknown>,
  targetFacet: Facet<unknown>,
  targetSnapshotStatus: ReadConfig["snapshotStatus"],
  needsBaseline: boolean,
): DivergenceUnassessedDimension | null {
  if (targetSnapshotStatus === "absent") {
    return { dimension, reason: "target_config_missing", detail: "the target agent version has no configSnapshot, so there is nothing to compare against" };
  }
  if (targetSnapshotStatus === "not-an-object") {
    return { dimension, reason: "unsupported_config_shape", detail: targetFacet.note ?? "the target configSnapshot is not an object" };
  }
  if (targetFacet.status === "absent") {
    // The trailing clause is ALWAYS appended, never replaced by the facet's own
    // note. It is the single most important sentence in the whole coverage
    // record — the difference between "the target has none" and "we do not know
    // what the target has" — and a reader must not have to infer it from a
    // key-list message.
    return {
      dimension,
      reason: "target_dimension_absent",
      detail: `${targetFacet.note ?? `the target snapshot does not describe "${dimension}"`} — its absence is unknown, not empty`,
    };
  }
  if (targetFacet.status === "malformed") {
    return { dimension, reason: "unsupported_config_shape", detail: targetFacet.note ?? `the target snapshot describes "${dimension}" in a shape this engine does not understand` };
  }
  // Target is readable. A missing BASELINE only blocks the SPECULATIVE half —
  // "changed" is not establishable — while proven kinds need only the target.
  if (needsBaseline && baselineFacet.status !== "read") {
    return {
      dimension,
      reason: "baseline_config_missing",
      detail: baselineFacet.note ?? `the run's own version does not describe "${dimension}", so "changed" cannot be established`,
    };
  }
  return null;
}

function toolSignature(spec: ToolSpec): string {
  if (spec.params === null) return "params:unknown";
  const params = [...spec.params].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `${p.name}${p.required ? "!" : "?"}`);
  return `params:[${params.join(",")}]closed:${spec.closed === null ? "unknown" : String(spec.closed)}`;
}

/**
 * Is `after` strictly MORE PERMISSIVE than `before`? Every argument object the
 * old schema accepted, the new one also accepts.
 *
 * Conservative by construction: `null` params (unknown contract) on either side
 * disqualifies, and so does closing a previously-open schema. Returning `true`
 * here downgrades a finding to `tool_schema_widened`, which promises that
 * recorded calls still validate — so a wrong `true` is a false clean.
 */
function isWidened(before: ToolSpec, after: ToolSpec): boolean {
  if (before.params === null || after.params === null) return false;
  if (before.closed !== true && after.closed === true) return false;
  const afterByName = new Map(after.params.map((p) => [p.name, p]));
  for (const p of before.params) {
    const a = afterByName.get(p.name);
    if (!a) return false; // a declared property disappeared
  }
  for (const a of after.params) {
    // A newly-required parameter narrows, it does not widen.
    if (a.required && !before.params.some((p) => p.name === a.name && p.required)) return false;
  }
  return true;
}

/** Compare two configSnapshots. PURE, run-independent, cheap — called ONCE for 10,000 runs. */
/**
 * May this facet's absences carry a proof?
 *
 * The `?? true` default is what preserves the FREE-FORM path byte for byte: a
 * legacy `tools: [...]` was always treated as a complete list, and still is.
 * Only a structured snapshot can say `partial` and thereby switch it off.
 */
function isProofCapable(facet: Facet<unknown>): boolean {
  return facet.status === "read" && (facet.proofCapable ?? true);
}

/** A dimension that is readable but NOT complete: comparable, never proof-bearing. */
function partialDeclarationFinding(
  dimension: DivergenceDimension,
  facet: Facet<unknown>,
): IndeterminateDivergence {
  return {
    certainty: "indeterminate",
    kind: "target_config_unreadable",
    dimension,
    reasonKey: `partial_declaration:${dimension}`,
    undecidedQuestion: `whether anything this run recorded uses a "${dimension}" the target no longer has`,
    unknownBecause: `the target declares "${dimension}" as PARTIAL (${facet.note ?? "declared: partial"}) — "these exist; there may be others" — so an absence from the list proves nothing. Treating a partial list as complete is how a half-captured snapshot condemns a healthy version.`,
    remedy: `re-publish this version declaring "${dimension}" as enumerated (or none), which makes absences meaningful and lets this dimension carry a verdict`,
  };
}

export function analyzeConfigPair(baselineSnapshot: unknown, targetSnapshot: unknown): ConfigDelta {
  const baseline = readConfigSnapshot(baselineSnapshot);
  const target = readConfigSnapshot(targetSnapshot);

  const speculative: SpeculativeDivergence[] = [];
  const indeterminate: IndeterminateDivergence[] = [];
  const unassessed: DivergenceUnassessedDimension[] = [];
  const assessed: DivergenceDimension[] = [];

  const record = (
    dimension: DivergenceDimension,
    baselineFacet: Facet<unknown>,
    targetFacet: Facet<unknown>,
    needsBaseline: boolean,
  ): boolean => {
    const gap = unassessedFor(dimension, baselineFacet, targetFacet, target.snapshotStatus, needsBaseline);
    if (gap) {
      unassessed.push(gap);
      return false;
    }
    assessed.push(dimension);
    return true;
  };

  // ---- tools ---------------------------------------------------------------
  // Tools supports BOTH proven and speculative findings. Proof needs only the
  // target; the speculative half needs both. So the dimension is assessed when
  // both are readable, and when only the target is readable we still keep the
  // parsed target list (proof stays available) while recording the gap.
  let targetToolsByName: Map<string, ToolSpec> | null = null;
  if (isProofCapable(target.tools)) {
    targetToolsByName = new Map(target.tools.value!.map((t) => [t.name, t]));
  } else if (target.tools.status === "read") {
    // Readable but PARTIAL. Comparable for speculation below, never a source of
    // `tool_removed`.
    indeterminate.push(partialDeclarationFinding("tools", target.tools));
  }
  if (record("tools", baseline.tools, target.tools, true)) {
    const baselineByName = new Map(baseline.tools.value!.map((t) => [t.name, t]));
    const path = target.tools.path ?? "tools";
    // COMPARISON map, not the PROOF map. A `partial` declaration is perfectly
    // comparable for speculation (a tool that appears in it with a changed
    // schema is still a real change worth reporting) while `targetToolsByName`
    // stays null so no ABSENCE from it can carry a proof. Reusing the proof map
    // here dereferenced null for every partial snapshot.
    const targetToolsForComparison = new Map(target.tools.value!.map((t) => [t.name, t]));
    for (const [name, targetSpec] of targetToolsForComparison) {
      const baselineSpec = baselineByName.get(name);
      if (!baselineSpec) {
        speculative.push({
          certainty: "speculative",
          kind: "tool_added",
          dimension: "tools",
          reasonKey: `tool_added:${name}`,
          speculativeConcern: `Target declares tool "${name}", which the recorded version did not have; tool selection may differ.`,
          speculativeBecause:
            "Nothing recorded can be contradicted by an ADDITION — the run never had this option, so no history can speak to how the target would use it. This is why a clean divergence report means the target would not have BROKEN on old history, never that it would have BEHAVED the same.",
          changedConfigPath: `${path}[name=${name}]`,
        });
        continue;
      }
      if (baselineSpec.description !== targetSpec.description) {
        speculative.push({
          certainty: "speculative",
          kind: "tool_description_changed",
          dimension: "tools",
          reasonKey: `tool_description_changed:${name}`,
          speculativeConcern: `The description of tool "${name}" changed; the model's choice of when to call it may differ.`,
          speculativeBecause: "A description steers tool selection through the model, and nothing about that selection is derivable from a recorded history without executing the model.",
          changedConfigPath: `${path}[name=${name}].description`,
        });
      }
      if (toolSignature(baselineSpec) !== toolSignature(targetSpec)) {
        const widened = isWidened(baselineSpec, targetSpec);
        speculative.push({
          certainty: "speculative",
          kind: widened ? "tool_schema_widened" : "config_changed",
          dimension: "tools",
          reasonKey: `${widened ? "tool_schema_widened" : "config_changed"}:${path}[name=${name}].parameters`,
          speculativeConcern: widened
            ? `Tool "${name}"'s schema became more permissive; every recorded call still validates, but future calls may differ.`
            : `Tool "${name}"'s argument schema changed (${toolSignature(baselineSpec)} -> ${toolSignature(targetSpec)}).`,
          speculativeBecause: widened
            ? "A widened schema cannot reject anything the old one accepted, so no recorded call can be contradicted by it."
            : "Recorded calls are separately checked for PROVABLE rejection; surviving those checks is NECESSARY but not SUFFICIENT for validity — value types, enums, formats and cross-field constraints are not evaluated here, so no claim of validity is made.",
          changedConfigPath: `${path}[name=${name}].parameters`,
        });
      }
    }
    // A tool present in the baseline and absent from the target is NOT reported
    // here. "The target lacks tool X" is only meaningful — and only provable —
    // when a run ACTUALLY CALLED X, which is a per-run fact. Reporting it at
    // pair level would flood a fleet report with reasons no run ever hit.
  }

  // ---- model ---------------------------------------------------------------
  let targetModels: Set<string> | null = null;
  if (isProofCapable(target.models) && target.models.value!.enumerated) {
    targetModels = new Set(target.models.value!.list);
  } else if (target.models.status === "read" && !isProofCapable(target.models)) {
    indeterminate.push(partialDeclarationFinding("model", target.models));
  }
  if (record("model", baseline.models, target.models, true)) {
    const before = baseline.models.value!.list;
    const after = target.models.value!.list;
    const added = after.filter((m) => !before.includes(m));
    const removed = before.filter((m) => !after.includes(m));
    if (added.length > 0 || removed.length > 0) {
      speculative.push({
        certainty: "speculative",
        kind: "model_substituted",
          dimension: "model",
        reasonKey: `model_substituted:${before.slice().sort().join("|")}->${after.slice().sort().join("|")}`,
        speculativeConcern: `Permitted model(s) change from [${before.join(", ")}] to [${after.join(", ")}]; output may differ.`,
        speculativeBecause:
          "No structural claim about a model swap is possible: nothing in the recorded history proves the target model would have produced the same, better, or worse output. A run that called a model the target no longer permits is reported separately, and provably, as `model_removed`.",
        changedConfigPath: target.models.path ?? "model",
      });
    }
  }

  // ---- system prompt -------------------------------------------------------
  if (record("system_prompt", baseline.prompt, target.prompt, true)) {
    if (baseline.prompt.value !== target.prompt.value) {
      const from = baseline.prompt.value!.length;
      const to = target.prompt.value!.length;
      speculative.push({
        certainty: "speculative",
        kind: "system_prompt_changed",
          dimension: "system_prompt",
        // Length-only key: the key travels into aggregate reports and logs, so
        // no prompt text goes in it — and no characterisation of the change is
        // implied by it either.
        reasonKey: `system_prompt_changed:${from}->${to}`,
        speculativeConcern: `The system prompt changed (${from} -> ${to} characters); behaviour and tool selection may differ.`,
        speculativeBecause:
          "WHAT A DIFFERENT SYSTEM PROMPT WOULD HAVE PRODUCED IS NOT DERIVABLE FROM A RECORDED HISTORY. Not approximately, not probabilistically, not 'it only added a sentence'. This engine deliberately does not diff, summarise or score the prompt text, because any such output would be read as an assessment. It reports THAT the prompt changed and makes no claim about consequence — neither safe nor unsafe.",
        changedConfigPath: target.prompt.path ?? "systemPrompt",
      });
    }
  }

  // ---- budgets -------------------------------------------------------------
  // Budgets carry PROVEN findings (`budget_exceeded`) and so, like tools, keep
  // their target values even when the baseline is missing.
  const targetBudgets = isProofCapable(target.budgets) ? target.budgets.value! : {};
  const targetBudgetPath = target.budgets.path ?? "budgets";
  if (record("budgets", baseline.budgets, target.budgets, true)) {
    const before = baseline.budgets.value!;
    for (const key of new Set([...Object.keys(before), ...Object.keys(targetBudgets)])) {
      if (before[key] === targetBudgets[key]) continue;
      speculative.push({
        certainty: "speculative",
        kind: "config_changed",
        dimension: "budgets",
        reasonKey: `config_changed:${targetBudgetPath}.${key}:${before[key] ?? "unset"}->${targetBudgets[key] ?? "unset"}`,
        speculativeConcern: `Budget "${key}" changes from ${before[key] ?? "unset"} to ${targetBudgets[key] ?? "unset"}.`,
        speculativeBecause:
          "A budget change only becomes provable when a RECORDED quantity exceeds the new ceiling, which is reported separately as `budget_exceeded`. Absent that, whether the run would have come near the new limit is a counterfactual.",
        changedConfigPath: `${targetBudgetPath}.${key}`,
      });
    }
  }

  // ---- decoding parameters -------------------------------------------------
  if (record("decoding_params", baseline.decoding, target.decoding, true)) {
    const before = baseline.decoding.value!;
    const after = target.decoding.value!;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
    if (changed.length > 0) {
      speculative.push({
        certainty: "speculative",
        kind: "decoding_params_changed",
          dimension: "decoding_params",
        reasonKey: `decoding_params_changed:${changed.slice().sort().map((k) => `${k}:${before[k] ?? "unset"}->${after[k] ?? "unset"}`).join(",")}`,
        speculativeConcern: `Decoding parameter(s) changed: ${changed.slice().sort().map((k) => `${k} ${before[k] ?? "unset"} -> ${after[k] ?? "unset"}`).join("; ")}. Output may differ.`,
        speculativeBecause:
          "The recorded run was ONE SAMPLE from a distribution these parameters alter. No structural fact can contradict a change to the distribution a sample was drawn from.",
        changedConfigPath: target.decoding.path ?? "decoding_params",
      });
    }
  }

  // ---- capabilities --------------------------------------------------------
  if (target.capabilities.status === "read" && !isProofCapable(target.capabilities)) {
    indeterminate.push(partialDeclarationFinding("capabilities", target.capabilities));
  }
  if (record("capabilities", baseline.capabilities, target.capabilities, true)) {
    const before = baseline.capabilities.value!;
    const after = target.capabilities.value!;
    const path = target.capabilities.path ?? "capabilities";
    const added = after.filter((c) => !before.includes(c));
    const removed = before.filter((c) => !after.includes(c));
    for (const c of [...removed, ...added]) {
      const isRemoval = removed.includes(c);
      speculative.push({
        certainty: "speculative",
        kind: "config_changed",
        dimension: "capabilities",
        reasonKey: `config_changed:${path}:${isRemoval ? "removed" : "added"}:${c}`,
        speculativeConcern: `Capability "${c}" was ${isRemoval ? "removed from" : "added to"} the target's declared capabilities.`,
        speculativeBecause:
          // This is the honest reason `capability_removed` is never emitted.
          "NO EVENT TYPE RECORDS WHICH NAMED CAPABILITY PRODUCED IT — a `retrieval.query` event carries a query string, not the identity of the retrieval source, and an `http.request` carries a URL, not the integration that issued it. With no recorded capability identifier there is no fact to contradict, so a capability removal cannot be proven the way a tool removal can. Closing this would require an event-payload change, not an engine change.",
        changedConfigPath: path,
      });
    }
  }

  return {
    baseline,
    target,
    speculative,
    indeterminate,
    unassessed,
    assessed,
    targetToolsByName,
    targetModels,
    targetBudgets,
    targetBudgetPath,
    anyDimensionAssessed: assessed.length > 0,
  };
}

// ===========================================================================
// PART 6 — OBSERVING A RUN'S RECORDED HISTORY (structural facts only)
// ===========================================================================

/** The minimal event shape this engine reads. Structurally compatible with `Doc<"events">`. */
export interface ObservableEvent {
  _id?: string;
  type: string;
  sequenceNumber: number;
  payload: unknown;
  provenance?: { source?: string; lossy?: boolean } | undefined;
}

export interface ObservedToolCall {
  name: string;
  sequenceNumber: number;
  eventId?: string;
  /** Recorded argument keys, or `null` when `input` was not an inspectable object. */
  argKeys: string[] | null;
}

export interface ObservedModelUse {
  model: string;
  sequenceNumber: number;
  eventId?: string;
  eventType: string;
}

/**
 * Why an observation is incomplete. Any one of these sets
 * `eventHistoryComplete: false`, which is what forbids `compatible`.
 */
export type ObservationGap =
  /** A payload was externalized past the 10 KB ceiling (Event Log Rule 3); the row holds an artifact pointer, not the facts. */
  | "EXTERNALIZED_PAYLOAD"
  /** The event scan stopped before the end of the run (the caller's budget). */
  | "SCAN_TRUNCATED"
  /** An OTel-derived event is flagged lossy; mapped fields may be missing or approximate. */
  | "LOSSY_DERIVED_EVENT"
  /** A `tool.call` event whose payload carried no readable tool name. */
  | "UNNAMED_TOOL_CALL";

export interface RunObservation {
  toolCalls: ObservedToolCall[];
  modelUses: ObservedModelUse[];
  /** Highest single-response output-token count seen, with its citation. */
  maxCompletionTokens: number | null;
  maxCompletionTokensEvent: DivergenceEventCitation | null;
  /** Number of `tool.call` events seen, INCLUDING unnamed ones — a lower bound on the run's true total. */
  toolCallCount: number;
  /**
   * Sequence numbers of `tool.call` events whose tool NAME could not be read
   * (externalized payload, or no name field).
   *
   * KEPT, NOT DISCARDED, because an unreadable name still constrains the
   * answer: nothing whatsoever is a member of the EMPTY SET, so against a
   * target declaring no tools these events prove `tool_removed` without anyone
   * ever learning which tool they were. See analyzeRunAgainstDelta.
   */
  unnamedToolCallSeqs: number[];
  /** Same, for `llm.request`/`llm.response` events whose model string could not be read. */
  unreadableModelUseSeqs: number[];
  eventsExamined: number;
  gaps: ObservationGap[];
  gapCounts: Record<string, number>;
}

function isExternalized(payload: unknown): boolean {
  return isPlainObject(payload) && payload["type"] === "_externalized";
}

/**
 * Reduce a run's events to the structural facts the engine needs.
 *
 * `scanTruncated` MUST be passed truthfully by the caller: it is what turns
 * "we read the first 200 of 50,000 events" into `indeterminate` rather than a
 * false `compatible`.
 */
export function extractRunObservation(
  events: ObservableEvent[],
  options?: { scanTruncated?: boolean },
): RunObservation {
  const toolCalls: ObservedToolCall[] = [];
  const modelUses: ObservedModelUse[] = [];
  const unnamedToolCallSeqs: number[] = [];
  const unreadableModelUseSeqs: number[] = [];
  const gapCounts: Record<string, number> = {};
  let maxCompletionTokens: number | null = null;
  let maxCompletionTokensEvent: DivergenceEventCitation | null = null;
  let toolCallCount = 0;

  const addGap = (g: ObservationGap): void => {
    gapCounts[g] = (gapCounts[g] ?? 0) + 1;
  };

  for (const ev of events) {
    if (ev.provenance?.source === "otel" && ev.provenance.lossy === true) addGap("LOSSY_DERIVED_EVENT");

    const cite = (): DivergenceEventCitation => ({
      sequenceNumber: ev.sequenceNumber,
      ...(ev._id ? { eventId: ev._id } : {}),
      eventType: ev.type,
    });

    if (ev.type === "tool.call") {
      toolCallCount += 1;
      if (isExternalized(ev.payload)) {
        // The event row KEEPS `type: "tool.call"` when its payload is
        // externalized, so we know a tool was called and have lost the NAME.
        // A run that called a removed tool is therefore indistinguishable from
        // one that did not — the sharpest instance of why a gap forbids a
        // clean verdict.
        addGap("EXTERNALIZED_PAYLOAD");
        addGap("UNNAMED_TOOL_CALL");
        unnamedToolCallSeqs.push(ev.sequenceNumber);
        continue;
      }
      const p = isPlainObject(ev.payload) ? ev.payload : undefined;
      const rawName = p ? (p["name"] ?? p["tool"] ?? p["tool_name"]) : undefined;
      if (typeof rawName !== "string" || rawName.trim().length === 0) {
        addGap("UNNAMED_TOOL_CALL");
        unnamedToolCallSeqs.push(ev.sequenceNumber);
        continue;
      }
      const input = p?.["input"] ?? p?.["arguments"] ?? p?.["args"];
      toolCalls.push({
        name: rawName.trim(),
        sequenceNumber: ev.sequenceNumber,
        ...(ev._id ? { eventId: ev._id } : {}),
        argKeys: isPlainObject(input) ? Object.keys(input) : null,
      });
      continue;
    }

    if (ev.type === "llm.request" || ev.type === "llm.response") {
      if (isExternalized(ev.payload)) {
        addGap("EXTERNALIZED_PAYLOAD");
        unreadableModelUseSeqs.push(ev.sequenceNumber);
        continue;
      }
      const p = isPlainObject(ev.payload) ? ev.payload : undefined;
      const model = p && typeof p["model"] === "string" ? (p["model"]).trim() : "";
      if (model.length === 0) unreadableModelUseSeqs.push(ev.sequenceNumber);
      if (model.length > 0) {
        modelUses.push({ model, sequenceNumber: ev.sequenceNumber, ...(ev._id ? { eventId: ev._id } : {}), eventType: ev.type });
      }
      if (ev.type === "llm.response") {
        const usage = p && isPlainObject(p["usage"]) ? (p["usage"]) : p;
        const out = usage
          ? [usage["completion_tokens"], usage["output_tokens"], usage["tokensOut"]].find(
              (n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0,
            )
          : undefined;
        if (out !== undefined && (maxCompletionTokens === null || out > maxCompletionTokens)) {
          maxCompletionTokens = out;
          maxCompletionTokensEvent = cite();
        }
      }
      continue;
    }

    if (isExternalized(ev.payload)) addGap("EXTERNALIZED_PAYLOAD");
  }

  if (options?.scanTruncated) addGap("SCAN_TRUNCATED");

  return {
    toolCalls,
    modelUses,
    maxCompletionTokens,
    maxCompletionTokensEvent,
    toolCallCount,
    unnamedToolCallSeqs,
    unreadableModelUseSeqs,
    eventsExamined: events.length,
    gaps: Object.keys(gapCounts) as ObservationGap[],
    gapCounts,
  };
}

// ===========================================================================
// PART 7 — RUN-SCOPED ANALYSIS
// ===========================================================================

function firstProof(proofs: DivergenceProof[]): [DivergenceProof, ...DivergenceProof[]] {
  // The non-empty tuple is a TYPE-LEVEL guarantee in the contract; this is the
  // one place it becomes a runtime one. A caller reaching here with no proof
  // has a proven finding with nothing behind it, which must never ship.
  const [head, ...rest] = proofs;
  if (!head) throw new Error("divergence engine invariant violated: a proven finding was built with no proof");
  return [head, ...rest.slice(0, MAX_PROOFS_PER_FINDING - 1)];
}

/**
 * Analyse ONE run's recorded history against a precomputed {@link ConfigDelta}.
 *
 * The delta's speculative findings and unassessed dimensions are carried into
 * the report (an operator reading one run wants the whole picture) but are NOT
 * recomputed — see PART 5.
 */
export function analyzeRunAgainstDelta(delta: ConfigDelta, observation: RunObservation): RunDivergenceAnalysis {
  const proven: ProvenDivergence[] = [];
  /** Set when the empty-target-toolset rule below already proved the unnamed calls. */
  let provedAgainstEmptyToolset = false;

  // ---- tool_removed --------------------------------------------------------
  // Guarded on a genuinely readable target tool list. An ABSENT list is
  // `target_dimension_absent` coverage, never this finding.
  if (delta.targetToolsByName !== null) {
    const targetTools = delta.targetToolsByName;
    const path = delta.target.tools.path ?? "tools";
    const removedProofs = new Map<string, DivergenceProof[]>();
    // The tool NAME is carried in the entry, never recovered from the key.
    // `key.slice(0, key.indexOf(":"))` truncated any namespaced name at its
    // first colon, so `github:search` rendered as `Called tool "github"` — the
    // reasonKey stayed correct so grouping was unaffected, which confined the
    // damage to the one sentence an operator reads to decide a deploy. That is
    // where a wrong name does the most harm per byte.
    const rejectedProofs = new Map<string, { proofs: DivergenceProof[]; detail: string; toolName: string }>();

    for (const call of observation.toolCalls) {
      const spec = targetTools.get(call.name);
      if (!spec) {
        const list = removedProofs.get(call.name) ?? [];
        list.push({
          citedEvent: { sequenceNumber: call.sequenceNumber, ...(call.eventId ? { eventId: call.eventId } : {}), eventType: "tool.call" },
          targetConfigPath: `${path}[].name`,
          recordedValue: call.name,
          targetValue: null,
        });
        removedProofs.set(call.name, list);
        continue;
      }
      if (spec.params === null) continue; // declared by name only — no contract to violate.
      if (call.argKeys === null) continue; // uninspectable args — see the UNVERIFIED note below.

      const provided = new Set(call.argKeys);
      const declared = new Set(spec.params.map((p) => p.name));
      const missingRequired = spec.params.filter((p) => p.required && !provided.has(p.name)).map((p) => p.name).sort();
      const undeclared = spec.closed === true ? call.argKeys.filter((k) => !declared.has(k)).sort() : [];

      for (const [violation, detail] of [
        ...missingRequired.map((m) => [`missing:${m}`, `omits required parameter "${m}"`] as const),
        ...undeclared.map((u) => [`undeclared:${u}`, `passes undeclared parameter "${u}" under a schema with additionalProperties:false`] as const),
      ]) {
        const key = `${call.name}:${violation}`;
        const entry = rejectedProofs.get(key) ?? { proofs: [], detail, toolName: call.name };
        entry.proofs.push({
          citedEvent: { sequenceNumber: call.sequenceNumber, ...(call.eventId ? { eventId: call.eventId } : {}), eventType: "tool.call" },
          targetConfigPath: `${path}[name=${call.name}].parameters`,
          recordedValue: `{${call.argKeys.slice().sort().join(", ")}}`,
          targetValue: toolSignature(spec),
        });
        rejectedProofs.set(key, entry);
      }
    }

    // THE EMPTY SET. An unreadable tool name normally blocks every tool claim —
    // that limit is real and is reported as `evidence_externalized`. It is
    // FALSE IN EXACTLY ONE CASE: when the target's tool list is readable,
    // complete, and EMPTY. Nothing whatsoever is a member of the empty set, and
    // the event TYPE survives externalization, so knowing THAT a tool was
    // called is already enough — which tool it was cannot change the answer.
    //
    // THE BOUNDARY MATTERS AS MUCH AS THE RULE: against a NON-EMPTY target set
    // this must still decline, because an unnamed call may well have been to a
    // tool the target still declares. The guard is `targetTools.size === 0`,
    // not "some tools were removed".
    if (targetTools.size === 0 && observation.unnamedToolCallSeqs.length > 0) {
      const seqs = observation.unnamedToolCallSeqs;
      proven.push({
        certainty: "proven",
        kind: "tool_removed",
        dimension: "tools",
        reasonKey: "tool_removed:<any>",
        provenClaim: `Made ${seqs.length} tool call(s) whose tool name could not be read, first at sequence ${seqs[0]}; the target version declares NO tools at all. Whichever tools these were, the target could not have called them.`,
        provenBy: firstProof(
          seqs.map((seq) => ({
            citedEvent: { sequenceNumber: seq, eventType: "tool.call" },
            targetConfigPath: `${path}[].name`,
            recordedValue: "<name unreadable — the event type is sufficient against an empty tool set>",
            targetValue: null,
          })),
        ),
      });
      provedAgainstEmptyToolset = true;
    }

    for (const [name, proofs] of removedProofs) {
      proven.push({
        certainty: "proven",
        kind: "tool_removed",
          dimension: "tools",
        reasonKey: `tool_removed:${name}`,
        provenClaim: `Called tool "${name}" ${proofs.length} time(s), first at sequence ${proofs[0]!.citedEvent.sequenceNumber}; the target version declares no such tool. This run could not have happened on that version.`,
        provenBy: firstProof(proofs),
      });
    }
    for (const [key, entry] of rejectedProofs) {
      const name = entry.toolName;
      proven.push({
        certainty: "proven",
        kind: "tool_call_rejected_by_schema",
          dimension: "tools",
        reasonKey: `tool_call_rejected_by_schema:${key}`,
        provenClaim: `Called tool "${name}" with an argument object the target's schema rejects: it ${entry.detail}. That recorded call could not have been made against the target.`,
        provenBy: firstProof(entry.proofs),
      });
    }
  }

  // ---- model_removed -------------------------------------------------------
  if (delta.targetModels !== null) {
    const allowed = delta.targetModels;
    const path = delta.target.models.path ?? "model";
    const byModel = new Map<string, DivergenceProof[]>();
    for (const use of observation.modelUses) {
      if (allowed.has(use.model)) continue;
      const list = byModel.get(use.model) ?? [];
      list.push({
        citedEvent: { sequenceNumber: use.sequenceNumber, ...(use.eventId ? { eventId: use.eventId } : {}), eventType: use.eventType },
        targetConfigPath: path,
        recordedValue: use.model,
        targetValue: [...allowed].sort().join(", ") || null,
      });
      byModel.set(use.model, list);
    }
    // Same reasoning one dimension over: an unreadable model string against a
    // target that permits NO models at all is still a proof.
    if (allowed.size === 0 && observation.unreadableModelUseSeqs.length > 0) {
      const seqs = observation.unreadableModelUseSeqs;
      proven.push({
        certainty: "proven",
        kind: "model_removed",
        dimension: "model",
        reasonKey: "model_removed:<any>",
        provenClaim: `Made ${seqs.length} model call(s) whose model string could not be read, first at sequence ${seqs[0]}; the target version permits NO models. Whichever models these were, the target could not have called them.`,
        provenBy: firstProof(
          seqs.map((seq) => ({
            citedEvent: { sequenceNumber: seq, eventType: "llm.request" },
            targetConfigPath: path,
            recordedValue: "<model unreadable — the event type is sufficient against an empty permitted set>",
            targetValue: null,
          })),
        ),
      });
    }

    for (const [model, proofs] of byModel) {
      proven.push({
        certainty: "proven",
        kind: "model_removed",
          dimension: "model",
        reasonKey: `model_removed:${model}`,
        provenClaim: `Called model "${model}" at sequence ${proofs[0]!.citedEvent.sequenceNumber}; the target version permits only [${[...allowed].sort().join(", ")}]. This run could not have happened on that version.`,
        provenBy: firstProof(proofs),
      });
    }
  }

  // ---- budget_exceeded -----------------------------------------------------
  // Both checks below are MONOTONE IN EVIDENCE: a count read from a truncated
  // history is a LOWER BOUND, and a lower bound that already exceeds the
  // ceiling is still a proof. That is why they are not gated on
  // `eventHistoryComplete`.
  const maxTokens = delta.targetBudgets["max_tokens"];
  if (
    typeof maxTokens === "number" &&
    observation.maxCompletionTokens !== null &&
    observation.maxCompletionTokensEvent !== null &&
    observation.maxCompletionTokens > maxTokens
  ) {
    proven.push({
      certainty: "proven",
      kind: "budget_exceeded",
          dimension: "budgets",
      reasonKey: `budget_exceeded:max_tokens:${maxTokens}`,
      provenClaim: `A recorded generation produced ${observation.maxCompletionTokens} output tokens at sequence ${observation.maxCompletionTokensEvent.sequenceNumber}, above the target's max_tokens of ${maxTokens}. That generation could not have completed on the target. (Reads max_tokens with its standard meaning: a hard cap on generated tokens.)`,
      provenBy: [
        {
          citedEvent: observation.maxCompletionTokensEvent,
          targetConfigPath: `${delta.targetBudgetPath}.max_tokens`,
          recordedValue: String(observation.maxCompletionTokens),
          targetValue: String(maxTokens),
        },
      ],
    });
  }

  const maxToolCalls = delta.targetBudgets["maxToolCalls"];
  if (typeof maxToolCalls === "number" && observation.toolCallCount > maxToolCalls) {
    const last = observation.toolCalls[observation.toolCalls.length - 1];
    proven.push({
      certainty: "proven",
      kind: "budget_exceeded",
          dimension: "budgets",
      reasonKey: `budget_exceeded:maxToolCalls:${maxToolCalls}`,
      provenClaim: `Made ${observation.toolCallCount} tool call(s), above the target's maxToolCalls of ${maxToolCalls}. This run could not have completed on the target.`,
      provenBy: [
        {
          citedEvent: last
            ? { sequenceNumber: last.sequenceNumber, ...(last.eventId ? { eventId: last.eventId } : {}), eventType: "tool.call" }
            : { sequenceNumber: 0, eventType: "tool.call" },
          targetConfigPath: `${delta.targetBudgetPath}.maxToolCalls`,
          recordedValue: String(observation.toolCallCount),
          targetValue: String(maxToolCalls),
        },
      ],
    });
  }

  // ---- coverage ------------------------------------------------------------
  const unassessed: DivergenceUnassessedDimension[] = [...delta.unassessed];

  // An UNINSPECTABLE recorded argument means the tools dimension was not fully
  // checked for this run, even though the config pair was readable. Recording
  // it as `engine_limit` is what stops a run whose arguments we could not read
  // from rendering as `compatible`.
  const unverifiableArgs = observation.toolCalls.filter(
    (c) => c.argKeys === null && delta.targetToolsByName?.get(c.name)?.params != null,
  );
  if (unverifiableArgs.length > 0 && delta.assessed.includes("tools")) {
    unassessed.push({
      dimension: "tools",
      reason: "engine_limit",
      detail: `${unverifiableArgs.length} recorded tool call(s) carry no inspectable argument object (externalized or non-object input), so they could not be checked against the target's schema in either direction`,
    });
  }

  const eventHistoryComplete = observation.gaps.length === 0;
  const coverage: DivergenceCoverage = {
    assessed: delta.assessed.filter((d) => !unassessed.some((u) => u.dimension === d)),
    unassessed,
    eventsExamined: observation.eventsExamined,
    eventHistoryComplete,
  };

  const speculative = [...delta.speculative];

  // ---- indeterminate ------------------------------------------------------
  const indeterminate: IndeterminateDivergence[] = [...delta.indeterminate];

  for (const u of unassessed) {
    // `target_config_missing` / `target_dimension_absent` /
    // `baseline_config_missing` are UNDECLARED, not unanswerable-when-asked.
    // They belong to the coverage record and `DimensionState`, whose remedy is
    // "declare it"; putting them here too would double-count the same fact in
    // two channels and inflate the fleet's distinct-reason count.
    if (u.reason === "unsupported_config_shape") {
      indeterminate.push({
        certainty: "indeterminate",
        kind: "target_config_unreadable",
        dimension: u.dimension,
        reasonKey: `target_config_unreadable:${u.dimension}`,
        undecidedQuestion: `whether this version's "${u.dimension}" differs from the recorded version's`,
        unknownBecause: u.detail ?? `the target declares "${u.dimension}" in a shape this engine cannot read`,
        remedy: `re-publish this version with a structured "${u.dimension}" declaration (AgentConfigSnapshot)`,
      });
    } else if (u.reason === "engine_limit") {
      indeterminate.push({
        certainty: "indeterminate",
        kind: "engine_limit",
        dimension: u.dimension,
        reasonKey: `engine_limit:${u.dimension}`,
        undecidedQuestion: `whether every recorded "${u.dimension}" fact is still permitted by this version`,
        unknownBecause: u.detail ?? "the engine's own ceiling was reached mid-question",
      });
    }
  }

  // Observation gaps become their own questions. THE EXTERNALIZED CASE IS THE
  // ONE THAT MOST NEEDED A ROW: an externalized `tool.call` payload keeps the
  // event type and loses the tool NAME, so a run that called a removed tool is
  // indistinguishable from one that did not. As a boolean on `coverage` that
  // fact was true but invisible; as a finding it is something an operator
  // reads.
  const affectedSeqs = observation.toolCalls.map((c) => c.sequenceNumber).slice(0, MAX_AFFECTED_SEQ_HINTS);
  // Suppressed when the empty-toolset rule above already PROVED these calls:
  // the question is no longer open, so reporting it as unanswered would be
  // false modesty in a report whose whole value is calibration.
  if (
    !provedAgainstEmptyToolset &&
    ((observation.gapCounts["EXTERNALIZED_PAYLOAD"] ?? 0) > 0 || (observation.gapCounts["UNNAMED_TOOL_CALL"] ?? 0) > 0)
  ) {
    const n = observation.gapCounts["UNNAMED_TOOL_CALL"] ?? 0;
    indeterminate.push({
      certainty: "indeterminate",
      kind: "evidence_externalized",
      dimension: "tools",
      reasonKey: "evidence_externalized:tools",
      undecidedQuestion:
        n > 0
          ? `which tools the ${n} recorded call(s) with externalized payloads targeted, and therefore whether any of them targeted a tool this version no longer declares`
          : "whether any externalized payload in this run contradicts the target version",
      unknownBecause:
        "the payload exceeded the 10 KB inline ceiling (Event Log Rule 3) and was replaced by an artifact pointer, so the event survives and the discriminating field does not",
      remedy:
        "keep tool names and arguments under the inline ceiling, or resolve the artifact out of band before relying on a clean verdict for this run",
      ...(affectedSeqs.length > 0 ? { possiblyAffectedSequenceNumbers: affectedSeqs } : {}),
    });
  }
  if ((observation.gapCounts["SCAN_TRUNCATED"] ?? 0) > 0 || (observation.gapCounts["LOSSY_DERIVED_EVENT"] ?? 0) > 0) {
    const lossy = observation.gapCounts["LOSSY_DERIVED_EVENT"] ?? 0;
    indeterminate.push({
      certainty: "indeterminate",
      kind: "recorded_history_incomplete",
      dimension: "tools",
      reasonKey: lossy > 0 ? "recorded_history_incomplete:lossy" : "recorded_history_incomplete:truncated",
      undecidedQuestion: "whether the unread part of this run's history contains a divergence",
      unknownBecause:
        lossy > 0
          ? `${lossy} OTel-derived event(s) are flagged lossy, so mapped fields may be missing or approximate`
          : `the event scan stopped after ${observation.eventsExamined} event(s), before the end of the run`,
      remedy:
        lossy > 0
          ? "re-record this agent through the first-party SDK path, or accept that derived events cannot ground a proof"
          : "page the analysis to completion (follow nextEventCursor) before treating the verdict as final",
    });
  }

  return {
    verdict: computeDivergenceVerdict({
      provenCount: proven.length,
      speculativeCount: speculative.length,
      complete: isDivergenceCoverageComplete(coverage),
    }),
    proven,
    speculative,
    indeterminate,
    coverage,
  };
}

/** One-shot convenience for a single run. Recomputes the delta — do NOT use in a fleet loop. */
export function analyzeRunDivergence(
  baselineSnapshot: unknown,
  targetSnapshot: unknown,
  events: ObservableEvent[],
  options?: { scanTruncated?: boolean },
): RunDivergenceAnalysis {
  return analyzeRunAgainstDelta(
    analyzeConfigPair(baselineSnapshot, targetSnapshot),
    extractRunObservation(events, options),
  );
}

// ===========================================================================
// PART 8 — FLEET AGGREGATION: GROUP BY DISTINCT REASON
// ===========================================================================

export interface FleetDivergenceAnalysis {
  verdict: DivergenceVerdict;
  provenReasons: ProvenDivergenceReason[];
  speculativeReasons: SpeculativeDivergenceReason[];
  /** Distinct UNANSWERED QUESTIONS across the scan. Grouped like the other two, and never merged with them. */
  indeterminateReasons: IndeterminateDivergenceReason[];
  /** Runs with at least one PROVEN divergence. NOT the sum of `provenReasons[].affectedRunCount` — one run can break several ways. */
  runsWithProvenDivergence: number;
  /**
   * Runs that WERE analysed but not COMPLETELY — some dimension unassessed, or
   * the event history cut off. They are counted inside `window.runsUnassessable`
   * (which is what makes the scan incomplete and the verdict honest); this
   * field preserves the distinction the contract's single counter erases, so an
   * operator can tell "we could not read this run at all" from "we read the
   * first 200 events of it".
   */
  runsPartiallyAnalyzed: number;
  window: DivergenceScanWindow;
}

/**
 * Fold per-run analyses into DISTINCT REASONS.
 *
 * The fleet answer leads with reasons rather than runs on purpose: 340 broken
 * runs with 12 root causes is a tractable morning; 340 individual reports is
 * not. `affectedRunCount` is a property OF a reason, never the headline.
 *
 * A run whose coverage assessed NOTHING is counted `runsUnassessable` rather
 * than clean — it is a run we did not look at, and `isFleetScanComplete` treats
 * that as an incomplete scan.
 */
export function foldFleetDivergence(
  analyses: Array<{ runId: string; analysis: RunDivergenceAnalysis }>,
  window: Omit<DivergenceScanWindow, "runsAnalyzed" | "runsUnassessable">,
): FleetDivergenceAnalysis {
  const provenGroups = new Map<string, ProvenDivergenceReason>();
  const speculativeGroups = new Map<string, SpeculativeDivergenceReason>();
  const indeterminateGroups = new Map<string, IndeterminateDivergenceReason>();
  let runsWithProvenDivergence = 0;
  let runsUnassessable = 0;
  let runsPartiallyAnalyzed = 0;

  for (const { runId, analysis } of analyses) {
    if (analysis.proven.length > 0) runsWithProvenDivergence += 1;

    // THE FALSE CLEAN THIS FIX EXISTS TO CLOSE.
    //
    // TWO INDEPENDENT FACTS ABOUT TRUNCATION EXIST, and before this fix only
    // one of them reached the verdict:
    //
    //   POPULATION-level — did we visit every RUN? -> `window.scanTruncated`.
    //   PER-RUN-level    — did we read every EVENT of the runs we did visit?
    //                      -> each run's `coverage.eventHistoryComplete`.
    //
    // The fold used to test only `coverage.assessed.length === 0`, which asks
    // "was ANY dimension examined" and is satisfied by a run whose event
    // history was cut off after 200 rows. So 25 runs each honestly reporting
    // `indeterminate` / `eventHistoryComplete: false` folded to a fleet verdict
    // of `compatible`. The per-run honesty was computed correctly and then
    // discarded one layer up.
    //
    // This is the DEFAULT path, not an edge case: tier 3 reads at most
    // `DIVERGENCE_FLEET_EVENTS_PER_RUN` events per run via `.take()`, so every
    // run longer than that is truncated by construction.
    //
    // A run we could not finish reading is a run we did not fully look at, and
    // `DivergenceScanWindow.runsUnassessable` is the contract's channel for
    // exactly that ("Both are ways of not having looked, and neither may read
    // as clean"). Widening the test to full coverage strictly subsumes the old
    // one — a run with zero assessed dimensions necessarily has a non-empty
    // `unassessed`.
    if (!isDivergenceCoverageComplete(analysis.coverage)) {
      runsUnassessable += 1;
      if (analysis.coverage.assessed.length > 0) runsPartiallyAnalyzed += 1;
    }

    // Distinct reasons WITHIN one run collapse first, so a run that hit the
    // same reason 40 times counts once toward that reason's run count.
    const seen = new Set<string>();
    for (const p of analysis.proven) {
      if (seen.has(p.reasonKey)) continue;
      seen.add(p.reasonKey);
      const existing = provenGroups.get(p.reasonKey);
      if (existing) {
        existing.affectedRunCount += 1;
        if (existing.representativeRunIds.length < MAX_DIVERGENCE_REPRESENTATIVE_RUNS) existing.representativeRunIds.push(runId);
      } else {
        provenGroups.set(p.reasonKey, {
          reasonKey: p.reasonKey,
          kind: p.kind,
          certainty: "proven",
          affectedRunCount: 1,
          representativeRunIds: [runId],
          // A REAL finding from a real run, with its real proof — never a
          // synthesised summary.
          exemplar: p,
        });
      }
    }
    for (const i of analysis.indeterminate) {
      if (seen.has(i.reasonKey)) continue;
      seen.add(i.reasonKey);
      const existing = indeterminateGroups.get(i.reasonKey);
      if (existing) {
        existing.affectedRunCount += 1;
        if (existing.representativeRunIds.length < MAX_DIVERGENCE_REPRESENTATIVE_RUNS) existing.representativeRunIds.push(runId);
      } else {
        indeterminateGroups.set(i.reasonKey, {
          reasonKey: i.reasonKey,
          kind: i.kind,
          certainty: "indeterminate",
          affectedRunCount: 1,
          representativeRunIds: [runId],
          exemplar: i,
        });
      }
    }
    for (const s of analysis.speculative) {
      if (seen.has(s.reasonKey)) continue;
      seen.add(s.reasonKey);
      const existing = speculativeGroups.get(s.reasonKey);
      if (existing) {
        existing.affectedRunCount += 1;
        if (existing.representativeRunIds.length < MAX_DIVERGENCE_REPRESENTATIVE_RUNS) existing.representativeRunIds.push(runId);
      } else {
        speculativeGroups.set(s.reasonKey, {
          reasonKey: s.reasonKey,
          kind: s.kind,
          certainty: "speculative",
          affectedRunCount: 1,
          representativeRunIds: [runId],
          exemplar: s,
        });
      }
    }
  }

  const fullWindow: DivergenceScanWindow = {
    ...window,
    runsAnalyzed: analyses.length,
    runsUnassessable,
  };

  const provenReasons = [...provenGroups.values()].sort(byAffectedThenKey);
  const speculativeReasons = [...speculativeGroups.values()].sort(byAffectedThenKey);
  const indeterminateReasons = [...indeterminateGroups.values()].sort(byAffectedThenKey);

  return {
    verdict: computeDivergenceVerdict({
      provenCount: provenReasons.length,
      speculativeCount: speculativeReasons.length,
      complete: isFleetScanComplete(fullWindow),
    }),
    provenReasons,
    speculativeReasons,
    indeterminateReasons,
    runsWithProvenDivergence,
    runsPartiallyAnalyzed,
    window: fullWindow,
  };
}

function byAffectedThenKey(
  a: { affectedRunCount: number; reasonKey: string },
  b: { affectedRunCount: number; reasonKey: string },
): number {
  if (a.affectedRunCount !== b.affectedRunCount) return b.affectedRunCount - a.affectedRunCount;
  return a.reasonKey.localeCompare(b.reasonKey);
}

/**
 * Merge fleet analyses produced by successive BATCHES into one answer.
 *
 * This is what makes "the last 10,000 runs" reachable at all: Convex permits
 * ONE `.paginate()` per function execution, so the population is walked across
 * several executions and folded here. The merge is EXACT rather than
 * approximate because `reasonKey` is stable and run-independent by
 * construction — a reason computed on page 1 and the same reason computed on
 * page 40 collide on the same key.
 *
 * `representativeRunIds` stays a bounded SAMPLE for navigation;
 * `affectedRunCount` is the authoritative number.
 */
export function mergeFleetAnalyses(pages: FleetDivergenceAnalysis[]): FleetDivergenceAnalysis {
  const provenGroups = new Map<string, ProvenDivergenceReason>();
  const speculativeGroups = new Map<string, SpeculativeDivergenceReason>();
  const indeterminateGroups = new Map<string, IndeterminateDivergenceReason>();
  let runsWithProvenDivergence = 0;
  let runsPartiallyAnalyzed = 0;
  const window: DivergenceScanWindow = {
    runsScanned: 0,
    runsAnalyzed: 0,
    runsUnassessable: 0,
    runsSkippedForBudget: 0,
    scanTruncated: false,
  };

  for (const page of pages) {
    runsWithProvenDivergence += page.runsWithProvenDivergence;
    runsPartiallyAnalyzed += page.runsPartiallyAnalyzed;
    window.runsScanned += page.window.runsScanned;
    window.runsAnalyzed += page.window.runsAnalyzed;
    window.runsUnassessable += page.window.runsUnassessable;
    window.runsSkippedForBudget += page.window.runsSkippedForBudget;
    window.scanTruncated = window.scanTruncated || page.window.scanTruncated;
    // A merged scan is unfinished if ANY page still points onward.
    if (page.window.nextCursor !== undefined) window.nextCursor = page.window.nextCursor;
    if (page.window.since !== undefined) window.since = Math.min(window.since ?? page.window.since, page.window.since);
    if (page.window.until !== undefined) window.until = Math.max(window.until ?? page.window.until, page.window.until);
    if (page.window.scanRowCeiling !== undefined) window.scanRowCeiling = page.window.scanRowCeiling;

    for (const r of page.provenReasons) mergeReason(provenGroups, r);
    for (const r of page.speculativeReasons) mergeReason(speculativeGroups, r);
    for (const r of page.indeterminateReasons) mergeReason(indeterminateGroups, r);
  }

  const provenReasons = [...provenGroups.values()].sort(byAffectedThenKey);
  const speculativeReasons = [...speculativeGroups.values()].sort(byAffectedThenKey);
  const indeterminateReasons = [...indeterminateGroups.values()].sort(byAffectedThenKey);

  return {
    verdict: computeDivergenceVerdict({
      provenCount: provenReasons.length,
      speculativeCount: speculativeReasons.length,
      complete: isFleetScanComplete(window),
    }),
    provenReasons,
    speculativeReasons,
    indeterminateReasons,
    runsWithProvenDivergence,
    runsPartiallyAnalyzed,
    window,
  };
}

function mergeReason<T extends { reasonKey: string; affectedRunCount: number; representativeRunIds: string[] }>(
  into: Map<string, T>,
  reason: T,
): void {
  const existing = into.get(reason.reasonKey);
  if (!existing) {
    into.set(reason.reasonKey, {
      ...reason,
      representativeRunIds: reason.representativeRunIds.slice(0, MAX_DIVERGENCE_REPRESENTATIVE_RUNS),
    });
    return;
  }
  existing.affectedRunCount += reason.affectedRunCount;
  for (const id of reason.representativeRunIds) {
    if (existing.representativeRunIds.length >= MAX_DIVERGENCE_REPRESENTATIVE_RUNS) break;
    if (!existing.representativeRunIds.includes(id)) existing.representativeRunIds.push(id);
  }
}
