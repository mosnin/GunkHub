// ---------------------------------------------------------------------------
// DIVERGENCE — "would this run still have been possible on that version?"
//
// Given a run's RECORDED event history and a TARGET `AgentVersion`'s
// `configSnapshot`, the divergence engine (convex/helpers/, Team A) reports
// where the target version would have diverged from what was recorded. Nothing
// is executed. It is a structural analysis over stored facts, the same shape of
// answer as Temporal's replay test: run new code against old history, fail on
// divergence.
//
// DERIVED, NEVER SOURCE OF TRUTH — the same posture as replay and diff
// (CLAUDE.md Event Log Rule 2). A `DivergenceReport` is computed at query time
// from the event log plus two immutable `configSnapshot`s, and is never stored
// back. Recompute it; do not cache it as a fact.
//
// ---------------------------------------------------------------------------
// THE ONE INVARIANT THIS FILE EXISTS TO ENFORCE
// ---------------------------------------------------------------------------
//
// There are two utterly different claims this analysis can make, and the whole
// credibility of the feature rests on never letting them touch:
//
//   PROVEN      "the run called the tool `search_web` at sequence 42, and the
//                target version declares no such tool. This run COULD NOT have
//                happened on that version." — a statement about the past,
//                checkable against two stored artifacts, with no model,
//                no sampling, and no judgement in it.
//
//   SPECULATIVE "the system prompt changed, so behaviour MAY differ." — an
//                unfalsifiable statement about a counterfactual future. It may
//                well be the most important thing on the page. It is still not
//                evidence, and it can never be checked.
//
// This is NOT modelled as `severity: string` on one shared shape, and that is
// the central design decision here. A severity field is advisory: every
// consumer that forgets to read it — a table renderer, a Slack formatter, a
// `findings.map(f => f.message)`, a CI gate someone wrote in a hurry — silently
// promotes speculation to proof. The output of this feature authorises
// fleet-wide deploys. "The consumer was supposed to check the enum" is not a
// safety property.
//
// So the separation is STRUCTURAL, at four levels:
//
//   1. TWO TYPES, MUTUALLY UNASSIGNABLE. {@link ProvenDivergence} and
//      {@link SpeculativeDivergence} share no assignable shape. Each carries a
//      distinct `certainty` literal AND a required field the other lacks
//      (`provenBy` / `speculativeBecause`), so assignment fails in both
//      directions on a missing required property, not merely on the
//      discriminant. Deleting the discriminant would not open the hole.
//
//   2. NO SHARED "MESSAGE" FIELD. Proof says `provenClaim`; speculation says
//      `speculativeConcern`. There is deliberately no `message`, `summary`, or
//      `description` common to both, so the one-liner that renders "all the
//      findings" cannot be written by accident. It can still be written on
//      purpose — by naming both types — and naming them is the acknowledgement.
//
//   3. NO EXPORTED UNION. There is no `DivergenceFinding = Proven | Speculative`
//      in this file, on purpose. A union is the flattening this design refuses
//      to make convenient. A consumer who genuinely needs to hold both writes
//      `ProvenDivergence | SpeculativeDivergence` locally, and that act of
//      typing both names is exactly the deliberate step that should be
//      required. (This is also why the report keeps two arrays rather than one.)
//
//   4. PROOF MUST CARRY ITS PROOF. `ProvenDivergence.provenBy` is a NON-EMPTY
//      tuple type — `[DivergenceProof, ...DivergenceProof[]]` — so a "proven"
//      finding with nothing behind it does not typecheck. A proven divergence
//      that cannot cite the recorded event it contradicts is not proven; it is
//      speculation wearing the wrong badge, and the compiler now says so.
//
// A negative test asserting all of the above (via `@ts-expect-error`, which
// fails the build if the conflation ever BECOMES legal) lives at
// `tests/unit/compat_type_conflation.test.ts`.
//
// See also: `packages/sdk/src/reader.ts` (`getRunDivergence` /
// `getAgentDivergence`) for the wire-level counterpart — the same segregation
// re-checked at runtime, because a server is not typechecked by us.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dimensions and coverage
// ---------------------------------------------------------------------------

/**
 * A slice of an `AgentVersion.configSnapshot` the analysis can examine.
 *
 * Coverage is reported per dimension because "we found nothing" and "we did not
 * look" are different answers, and only one of them is safe to ship on. A
 * report that assessed no dimensions and found no divergences is not a clean
 * bill of health — see {@link DivergenceCoverage}.
 */
export type DivergenceDimension =
  /** The declared tool set: names, and where present, argument schemas. */
  | "tools"
  /** The model identifier(s) the version is permitted to call. */
  | "model"
  /** The system prompt text. Only ever a source of SPECULATIVE findings. */
  | "system_prompt"
  /** Hard structural budgets: max steps, max tool calls, max tokens, timeouts. */
  | "budgets"
  /** Decoding parameters: temperature, top_p, seed, stop sequences. Speculative only. */
  | "decoding_params"
  /** Named capabilities/integrations the version declares (retrieval sources, MCP servers, ...). */
  | "capabilities";

/** Why a dimension could not be assessed. Each value is a fact about the INPUTS, never a verdict. */
export type DivergenceUnassessedReason =
  /** The target version has no `configSnapshot` at all — nothing to compare against. */
  | "target_config_missing"
  /** The target's snapshot does not describe this dimension, so its absence is unknown, not empty. */
  | "target_dimension_absent"
  /** The run's own version has no snapshot, so "changed" cannot be established for a speculative dimension. */
  | "baseline_config_missing"
  /** The snapshot describes this dimension in a shape the engine does not understand. Never guessed at. */
  | "unsupported_config_shape"
  /** The engine's own bound was hit (event ceiling, tool-count ceiling) before the dimension was finished. */
  | "engine_limit";

/** One dimension the analysis did NOT reach, and why. */
export interface DivergenceUnassessedDimension {
  dimension: DivergenceDimension;
  reason: DivergenceUnassessedReason;
  /** Optional operator-facing elaboration, e.g. the config path that was unreadable. */
  detail?: string;
}

/**
 * What the analysis actually looked at.
 *
 * THIS IS THE ANTI-FALSE-CLEAN FIELD and it is REQUIRED, not optional. An empty
 * `proven` array means one of two entirely different things — "checked, and this
 * run is safe" or "checked nothing" — and without coverage there is no way to
 * tell them apart. Every gate in this repo (`afr compat`, `FlightReader`) treats
 * a missing or incomplete coverage record as INDETERMINATE rather than clean.
 */
export interface DivergenceCoverage {
  /** Dimensions fully examined. Order is not significant. */
  assessed: DivergenceDimension[];
  /** Dimensions skipped, each with the reason. Empty means full coverage. */
  unassessed: DivergenceUnassessedDimension[];
  /** How many recorded events were examined. */
  eventsExamined: number;
  /**
   * False when the engine stopped before the end of the run's event log (its
   * own ceiling, or a truncated history). A proven divergence found in the part
   * that WAS read still stands; the absence of one does not.
   */
  eventHistoryComplete: boolean;
}

/**
 * Full coverage: SOMETHING WAS ACTUALLY EXAMINED, every dimension was
 * assessed, and the whole event history was read.
 *
 * The one place the "did we actually check?" rule is written down, so a gate,
 * the CLI, the web UI and the MCP surface cannot each invent a slightly
 * different version of it.
 *
 * ---------------------------------------------------------------------------
 * THE POSITIVE CLAUSE IS LOAD-BEARING — DO NOT "SIMPLIFY" IT AWAY
 * ---------------------------------------------------------------------------
 *
 * `assessed.length > 0` looks redundant next to `unassessed.length === 0`, and
 * on every non-empty input it is. On the EMPTY input the two disagree, and the
 * disagreement produces a green light:
 *
 *   { assessed: [], unassessed: [], eventsExamined: 0, eventHistoryComplete: true }
 *
 * Nothing was truncated, so the old predicate said `true`; nothing was
 * examined, so the honest answer is that there is no basis for any verdict at
 * all. Fed to {@link computeDivergenceVerdict} with no findings, `true` yields
 * `compatible` — a deploy authorised by an analysis that looked at nothing.
 *
 * The bug is a category error, and it is worth naming because it is the same
 * one that has now produced defects in three layers of this feature: THE
 * PREDICATE WAS ANSWERING "WAS ANYTHING TRUNCATED?" WHEN THE PROPERTY IT MUST
 * EXPRESS IS "DO WE HAVE ENOUGH EVIDENCE TO CONCLUDE?". Those coincide on
 * every input where something was examined, and diverge precisely where a
 * false green is most damaging — the empty one. A predicate built only from
 * negative clauses ("nothing went wrong") is vacuously true on nothing at all;
 * completeness needs at least one positive clause asserting that evidence
 * exists.
 *
 * `eventsExamined > 0` is the second positive clause, and it is sound rather
 * than merely cautious: Event Log Rule 5 guarantees `RUN_STARTED` is the first
 * event of every run, so a run always has at least one event. `eventsExamined:
 * 0` therefore never means "an empty run" — it means nothing was read.
 */
export function isDivergenceCoverageComplete(coverage: DivergenceCoverage): boolean {
  return (
    coverage.assessed.length > 0 &&
    coverage.eventsExamined > 0 &&
    coverage.unassessed.length === 0 &&
    coverage.eventHistoryComplete
  );
}

// ---------------------------------------------------------------------------
// PROVEN divergence
// ---------------------------------------------------------------------------

/**
 * A kind of divergence that is DECIDABLE from stored data alone.
 *
 * CLOSED SET, and it must stay closed. Every member below has a stated proof
 * obligation: a mechanical check over the recorded event log and the target
 * snapshot that admits no judgement call. Adding a member is a contracts change
 * (this file, owned by the SDK/CLI boundary) and requires writing that proof
 * obligation down. If the check you want to add needs a "probably", it is not a
 * member of this union — it belongs in {@link SpeculativeDivergenceKind}.
 */
export type ProvenDivergenceKind =
  /**
   * The run invoked a tool by name; the target's declared tool set does not
   * contain that name. PROOF: a recorded `tool.call` event, plus the absence of
   * the name from an ENUMERATED tool list. Requires the target to actually
   * declare its tools — an absent tool list yields `target_dimension_absent`
   * coverage, never this finding.
   */
  | "tool_removed"
  /**
   * The run invoked a tool with arguments the target's schema for that tool
   * cannot accept. PROOF: a recorded argument key absent from the target
   * schema's properties while the schema forbids additional properties, or a
   * recorded value of the wrong JSON type for a declared property, or a
   * required property never supplied. Anything softer (a widened enum, a
   * changed description) is speculative.
   */
  | "tool_call_rejected_by_schema"
  /**
   * The run called a model the target does not permit. PROOF: a model string
   * recorded on an `llm.request`/`llm.response` payload, plus an enumerated
   * allowed-model list on the target that does not contain it.
   */
  | "model_removed"
  /**
   * The run consumed more of a HARD, RECORDED quantity than the target allows —
   * more steps, more tool calls, more tokens. PROOF: a count derived from the
   * event log compared against a numeric ceiling in the target snapshot. Only
   * counts actually present in the log qualify; a wall-clock timeout the log
   * does not measure does not.
   */
  | "budget_exceeded"
  /**
   * The run used a named capability (retrieval source, MCP server, integration)
   * that the target no longer declares. PROOF: identical in form to
   * `tool_removed`, over an enumerated capability list.
   */
  | "capability_removed";

/**
 * The citation half of a proof: the recorded event that could not have
 * happened.
 *
 * Addressed by `sequenceNumber`, which is the event log's own key within a run
 * (CLAUDE.md Event Log Rule 4) and is what {@link FlightReader.getRunEventWindow}
 * takes — so a reader can go straight from a proof to the surrounding events
 * without paging the log from the start.
 */
export interface DivergenceEventCitation {
  /** Position within the run. Positive, contiguous — the log's real key. */
  sequenceNumber: number;
  /** The event's id, when the engine carried it. Not required: `sequenceNumber` addresses it. */
  eventId?: string;
  /** The recorded event type, e.g. `"tool.call"`. Free-form string: the vocabulary is `EventType`'s to grow. */
  eventType: string;
}

/**
 * One complete proof: a recorded fact, and the place in the target's config
 * that contradicts it.
 *
 * Both halves are required. Half a proof — "the tool list changed", with no
 * event — is a speculative finding, and belongs in the other type.
 */
export interface DivergenceProof {
  /** The recorded event this proof is about. */
  citedEvent: DivergenceEventCitation;
  /** Path into the TARGET `configSnapshot` that decides it, e.g. `"tools[].name"` or `"budgets.maxToolCalls"`. */
  targetConfigPath: string;
  /** The value the RUN actually recorded, rendered for display, e.g. the tool name or the model id. */
  recordedValue: string;
  /**
   * What the target declares at `targetConfigPath`, rendered for display, or
   * `null` when the path is ABSENT — which is itself the proof for every
   * `*_removed` kind. `null` is meaningful; it is not "unknown".
   */
  targetValue: string | null;
}

/**
 * A divergence that is PROVEN: the recorded run could not have occurred on the
 * target version, and here is the recorded event and the config path that say
 * so.
 *
 * Safe to gate a deploy on. Safe to phrase in the past tense. Never assignable
 * to or from {@link SpeculativeDivergence} — see this file's header.
 */
export interface ProvenDivergence {
  /** Discriminant. One of the two structural barriers; the other is `provenBy`. */
  certainty: "proven";
  kind: ProvenDivergenceKind;
  /**
   * Which dimension this finding belongs to.
   *
   * REQUIRED on all three finding types, because per-dimension attribution is
   * what makes a partial analysis useful instead of a shrug: a snapshot that
   * declares its tools and says nothing about budgets should report PROVEN
   * breakage in `tools` and an unanswered question in `budgets`, and an
   * operator should be able to see both at once. See
   * {@link divergenceByDimension}.
   */
  dimension: DivergenceDimension;
  /**
   * Stable identity of the REASON, not of this occurrence — e.g.
   * `"tool_removed:search_web"`. Two runs that broke for the same underlying
   * cause carry the same `reasonKey`, which is what makes the fleet view
   * ("12 distinct reasons") possible at all. Engine-assigned; treat as opaque.
   */
  reasonKey: string;
  /**
   * One line, phrased about WHAT WAS RECORDED, in the past tense: "called tool
   * `search_web` at sequence 42; target declares no such tool."
   *
   * Deliberately NOT named `message`/`summary` — see this file's header, point 2.
   */
  provenClaim: string;
  /**
   * The proof. NON-EMPTY BY TYPE: a `ProvenDivergence` with an empty `provenBy`
   * does not compile. Multiple entries when several recorded events are
   * contradicted by the same config fact; the first is the earliest.
   */
  provenBy: [DivergenceProof, ...DivergenceProof[]];
}

// ---------------------------------------------------------------------------
// SPECULATIVE divergence
// ---------------------------------------------------------------------------

/**
 * A kind of change whose effect on behaviour CANNOT be derived from a recorded
 * history. Every member is a real, useful thing to tell an operator — and none
 * of them is evidence that anything would actually break.
 *
 * Open-ended in spirit but closed in type, for the same reason as
 * {@link ProvenDivergenceKind}: a CI gate may key on these values.
 */
export type SpeculativeDivergenceKind =
  /** The system prompt text differs. The archetypal unprovable change. */
  | "system_prompt_changed"
  /** A model was swapped for another the target DOES permit — different model, not a missing one. */
  | "model_substituted"
  /** Temperature / top_p / seed / stop sequences differ. */
  | "decoding_params_changed"
  /** The target declares a tool the run never had. Nothing recorded can be contradicted by an ADDITION. */
  | "tool_added"
  /** A tool's description or docstring changed — it steers selection, and nothing more can be said. */
  | "tool_description_changed"
  /** A tool's schema became MORE permissive. Every recorded call still validates; future calls may differ. */
  | "tool_schema_widened"
  /** Some other part of the snapshot changed in a way the engine can name but not reason about. */
  | "config_changed";

/**
 * A change that MAY alter behaviour, with no way to prove it from what was
 * recorded.
 *
 * NOT evidence. NOT a gate signal by default (`afr compat --fail-on proven`,
 * the default, ignores these entirely — see that command's help for why a gate
 * that fires on every prompt edit is a gate that gets disabled).
 *
 * Never assignable to or from {@link ProvenDivergence}.
 */
export interface SpeculativeDivergence {
  /** Discriminant. The other structural barrier is `speculativeBecause`. */
  certainty: "speculative";
  kind: SpeculativeDivergenceKind;
  /** Which dimension changed — see {@link ProvenDivergence.dimension}. */
  dimension: DivergenceDimension;
  /** Stable identity of the reason, as on {@link ProvenDivergence.reasonKey}. */
  reasonKey: string;
  /**
   * One line, phrased as a POSSIBILITY: "system prompt changed; tool selection
   * may differ." Never the past tense, never "would have failed".
   *
   * Deliberately NOT named `message`/`summary` — see this file's header, point 2.
   */
  speculativeConcern: string;
  /**
   * REQUIRED: why this cannot be proven from the recorded history. Forcing the
   * engine to state the limit at the point of writing the finding is what keeps
   * speculative findings honest, and it is the second structural reason a
   * `SpeculativeDivergence` can never be passed where proof is expected.
   */
  speculativeBecause: string;
  /** Path into the target `configSnapshot` that changed, e.g. `"systemPrompt"`. */
  changedConfigPath: string;
  /**
   * Events this change might bear on — e.g. every `llm.request` under the
   * changed prompt.
   *
   * NOT PROOF, and named so it cannot be mistaken for it. It is a navigation
   * aid: somewhere to start reading. An empty or absent list says nothing.
   */
  possiblyAffectedSequenceNumbers?: number[];
}

// ---------------------------------------------------------------------------
// INDETERMINATE divergence — the third band, and the reason there are three
//
// Two buckets are not enough, and pretending otherwise is what corrupts them.
// A real engine reading a real `configSnapshot` routinely lands on a specific
// question it cannot answer: the target's tool list is present but malformed,
// so whether `search_web` still exists is UNKNOWN; a `tool.call` payload was
// externalized past the 10 KB limit (Event Log Rule 3), so the event type
// survives but the tool NAME does not, and a call to a removed tool is
// indistinguishable from no call at all.
//
// With only PROVEN and SPECULATIVE available, an engine has exactly two places
// to put that, and both are lies:
//   - file it as PROVEN -> a guess is rendered as evidence. Catastrophic.
//   - file it as SPECULATIVE -> "we could not check" is rendered as "we
//     checked and it is only a maybe". Lies in the safe-looking direction,
//     which is how a false clean ships.
// The third option — drop it — is the worst of the three, and is what a
// two-bucket type actively encourages.
//
// So an unanswerable question gets its own type. It is structurally distinct
// from BOTH others (its own `certainty` literal, its own required
// `unknownBecause`, its own question-shaped text field), and it is
// COMPLETENESS-BEARING: any indeterminate finding makes the analysis
// incomplete, which forces the verdict to `indeterminate` and, in the CLI,
// exit 11. "I could not check the tool list" can therefore never exit 0.
// ---------------------------------------------------------------------------

/** Why a specific question could not be decided. Facts about the INPUTS, never about the agent. */
export type IndeterminateDivergenceKind =
  /** The target declares this dimension but in a shape the engine cannot read. Present-but-unreadable, not absent. */
  | "target_config_unreadable"
  /** The run's recorded history could not be read to the end, so the unread part is unchecked. */
  | "recorded_history_incomplete"
  /**
   * The deciding value was externalized to an artifact (Event Log Rule 3), so
   * the event survives and the discriminating field does not. The archetype: a
   * `tool.call` whose payload went to blob storage keeps its type and loses
   * its tool name.
   */
  | "evidence_externalized"
  /** The engine's own ceiling was reached mid-question. */
  | "engine_limit";

/**
 * A question this analysis COULD NOT ANSWER.
 *
 * Not a divergence, and not the absence of one. Never assignable to or from
 * {@link ProvenDivergence} or {@link SpeculativeDivergence}: distinct
 * `certainty` literal, plus a required `unknownBecause` neither of the others
 * has, plus a text field named for a question rather than a claim or a concern.
 */
export interface IndeterminateDivergence {
  /** Discriminant. The structural barrier is `unknownBecause`. */
  certainty: "indeterminate";
  kind: IndeterminateDivergenceKind;
  /** Stable identity of the reason, as on the other two types. */
  reasonKey: string;
  /**
   * What could not be decided, PHRASED AS THE OPEN QUESTION: "whether the tool
   * calls at sequences 12, 19 target tools this version still declares."
   *
   * Deliberately shares no name with `provenClaim` or `speculativeConcern` —
   * see this file's header, point 2.
   */
  undecidedQuestion: string;
  /**
   * REQUIRED: what specifically stopped the analysis. "The target's `tools`
   * key is a string, not an array." An unexplained "unknown" is
   * indistinguishable from laziness and gets ignored.
   */
  unknownBecause: string;
  /** Which dimension the unanswered question belongs to — see {@link ProvenDivergence.dimension}. */
  dimension: DivergenceDimension;
  /**
   * What would make this answerable, phrased as an action the operator can
   * take: "re-publish this version with a structured `tools` declaration
   * (`AgentConfigSnapshot`)".
   *
   * This is the difference between a product that says "I cannot tell" and one
   * that says "I cannot tell YET, and here is why and what to do". A dimension
   * that is unanswerable because nobody ever declared it is a fixable state,
   * and saying so is what stops operators learning to click past the verdict.
   */
  remedy?: string;
  /** Recorded events the unanswered question bears on. Somewhere to look; not evidence of anything. */
  possiblyAffectedSequenceNumbers?: number[];
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * The operator's actual question — "can I ship this?" — answered in one word.
 *
 * `indeterminate` is not a hedge; it is the answer that stops a false clean.
 * A report that could not examine the tool set has not established that the
 * tool set is fine, and must never render as `compatible`.
 */
export type DivergenceVerdict =
  /** At least one PROVEN divergence. This run could not have happened on the target. */
  | "incompatible"
  /** Nothing proven, full coverage, but speculative changes exist. Shippable with eyes open. */
  | "compatible_with_caveats"
  /** Nothing proven, nothing speculative, full coverage. */
  | "compatible"
  /** Nothing proven, but coverage was incomplete — "nothing found" is not evidence here. */
  | "indeterminate";

/** The inputs {@link computeDivergenceVerdict} needs, from either a single-run or a fleet report. */
export interface DivergenceVerdictInput {
  provenCount: number;
  speculativeCount: number;
  /**
   * Whether the analysis was complete.
   *
   * **Get this from {@link isDivergenceAnalysisComplete} (a run) or
   * {@link isFleetDivergenceAnalysisComplete} (a fleet). Do not hand-roll it.**
   * `complete: true` is the single input that can turn "no findings" into
   * `compatible`, so a locally-invented version of it is a locally-invented
   * green light — and the failure mode is silent, because a hand-rolled
   * predicate built from "nothing went wrong" clauses looks correct and is
   * vacuously true on an empty analysis. That exact bug has now been found in
   * three layers of this feature; the helpers exist so it has one home.
   */
  complete: boolean;
}

/**
 * THE verdict rule, in one place, for every surface that states one.
 *
 * Precedence, and why:
 *
 *  1. `provenCount > 0` -> `incompatible`, EVEN IF COVERAGE IS INCOMPLETE. A
 *     proof does not become less true because something else went unchecked.
 *     Demoting a proven divergence to `indeterminate` on partial coverage would
 *     let an incomplete scan hide a certainty — precisely backwards.
 *  2. `!complete` -> `indeterminate`. Nothing proven and we did not finish
 *     looking: this is the false-clean case, and it gets its own word.
 *  3. `speculativeCount > 0` -> `compatible_with_caveats`.
 *  4. otherwise -> `compatible`.
 *
 * A consumer must not re-derive this. `afr compat` deliberately computes its
 * exit code from these same inputs rather than from a `verdict` string a server
 * handed it, and `FlightReader` cross-checks a server's `verdict` against this
 * function — a response whose verdict disagrees with its own contents is a
 * response that cannot be trusted with a deploy decision.
 */
export function computeDivergenceVerdict(input: DivergenceVerdictInput): DivergenceVerdict {
  if (input.provenCount > 0) return "incompatible";
  if (!input.complete) return "indeterminate";
  if (input.speculativeCount > 0) return "compatible_with_caveats";
  return "compatible";
}

// ---------------------------------------------------------------------------
// Single-run report
// ---------------------------------------------------------------------------

/**
 * "Would this recorded run still have been possible on version X?"
 *
 * Derived at query time; never stored (CLAUDE.md Event Log Rule 2).
 */
export interface DivergenceReport {
  /** The run whose recorded history was analysed. */
  runId: string;
  /**
   * The version the run was actually RECORDED against, or `null` when the run
   * carries no `agentVersionId`. `null` restricts the analysis to dimensions
   * that need only the target (proven kinds), and every speculative dimension
   * reports `baseline_config_missing` coverage rather than silently reporting
   * "no changes".
   */
  baselineVersionId: string | null;
  /**
   * The version asked about. ECHOED BACK DELIBERATELY, and load-bearing: it is
   * how a client proves the server actually analysed the version it named
   * rather than dropping an unknown query parameter and answering about
   * something else. See `FlightReader.getRunDivergence`.
   */
  targetVersionId: string;
  /** Server clock at analysis time. The report is a snapshot; recompute rather than cache. */
  analyzedAt: number;
  /** Must equal `computeDivergenceVerdict(...)` over this report's own contents. Clients verify. */
  verdict: DivergenceVerdict;
  /** Proven divergences. An empty array is only meaningful alongside a COMPLETE analysis — see {@link isDivergenceAnalysisComplete}. */
  proven: ProvenDivergence[];
  /** Speculative changes. Never a gate signal by default. */
  speculative: SpeculativeDivergence[];
  /**
   * Questions the analysis could not answer. Each one makes the analysis
   * incomplete, and therefore makes `verdict: 'compatible'` unreachable.
   */
  indeterminate: IndeterminateDivergence[];
  /** REQUIRED. What was actually examined — see {@link DivergenceCoverage}. */
  coverage: DivergenceCoverage;
}

/**
 * Was this analysis actually finished?
 *
 * TWO WAYS TO NOT HAVE LOOKED, and both count: a dimension never reached
 * (`coverage`) and a specific question reached but unanswerable
 * (`indeterminate`). THE SINGLE DEFINITION — the CLI gate, the web UI, the
 * MCP projection and `FlightReader`'s response verification all call this
 * rather than each deciding what "complete" means. A second opinion on this
 * predicate is how a detail page and a CI gate come to disagree about whether
 * a version ships.
 */
export function isDivergenceAnalysisComplete(report: DivergenceReport): boolean {
  return isDivergenceCoverageComplete(report.coverage) && report.indeterminate.length === 0;
}

/** Convenience: the verdict this report's own contents imply. Use to verify a server's `verdict`. */
export function divergenceReportVerdict(report: DivergenceReport): DivergenceVerdict {
  return computeDivergenceVerdict({
    provenCount: report.proven.length,
    speculativeCount: report.speculative.length,
    complete: isDivergenceAnalysisComplete(report),
  });
}

// ---------------------------------------------------------------------------
// Per-dimension outcome — what makes a PARTIAL analysis useful
// ---------------------------------------------------------------------------

/**
 * The state of one dimension in one analysis.
 *
 * A global verdict is the right thing to gate on and the wrong thing to read.
 * `indeterminate` at the top of a report tells an operator nothing about what
 * WAS established, and a product whose flagship answer is a single shrug
 * teaches people to click past it — which is how a real breaking change gets
 * shipped. These are the same facts, per dimension, so a report can say
 * "tools: BROKEN (2 proofs), model: clean, budgets: never declared" instead of
 * one word.
 */
export type DimensionState =
  /** At least one PROVEN divergence in this dimension. */
  | "incompatible"
  /** Assessed, nothing proven, but speculative changes here. */
  | "changed"
  /** Assessed, nothing found. A real, earned pass — for this dimension only. */
  | "clean"
  /** The target never declared it. Not checked, and fixable — see {@link IndeterminateDivergence.remedy}. */
  | "undeclared"
  /** Declared but unreadable, or a question was reached and left open. */
  | "unanswered";

/** One dimension's outcome, with the counts behind it. */
export interface DimensionOutcome {
  dimension: DivergenceDimension;
  state: DimensionState;
  provenCount: number;
  speculativeCount: number;
  indeterminateCount: number;
}

/** Every dimension the analysis can examine, in report order. */
export const DIVERGENCE_DIMENSIONS: readonly DivergenceDimension[] = [
  "tools",
  "model",
  "budgets",
  "capabilities",
  "system_prompt",
  "decoding_params",
];

/**
 * Fold a report into one outcome per dimension.
 *
 * DERIVED, never stored — same posture as the report itself. Precedence within
 * a dimension mirrors the global verdict rule exactly, and for the same
 * reason: a proof outranks an unanswered question, because a proof does not
 * weaken because something else went unchecked.
 *
 * `undeclared` vs `unanswered` is the distinction that makes this worth
 * having. Both mean "not checked", but only one of them is the operator's to
 * fix by declaring a structured snapshot, and telling them which is the
 * difference between a shrug and a next step.
 */
export function divergenceByDimension(report: DivergenceReport): DimensionOutcome[] {
  const unassessed = new Map(report.coverage.unassessed.map((u) => [u.dimension, u]));
  const assessed = new Set(report.coverage.assessed);

  return DIVERGENCE_DIMENSIONS.map((dimension) => {
    const provenCount = report.proven.filter((f) => f.dimension === dimension).length;
    const speculativeCount = report.speculative.filter((f) => f.dimension === dimension).length;
    const indeterminateCount = report.indeterminate.filter((f) => f.dimension === dimension).length;

    const state: DimensionState =
      provenCount > 0
        ? "incompatible"
        : indeterminateCount > 0
          ? "unanswered"
          : unassessed.has(dimension)
            ? // "the target never said" is reported as undeclared; anything
              // else that stopped the analysis is reported as unanswered.
              unassessed.get(dimension)?.reason === "target_dimension_absent" ||
              unassessed.get(dimension)?.reason === "target_config_missing"
              ? "undeclared"
              : "unanswered"
            : assessed.has(dimension)
              ? speculativeCount > 0
                ? "changed"
                : "clean"
              : // Neither assessed nor explicitly unassessed: the engine did
                // not account for this dimension at all. Never read silence as
                // a pass.
                "undeclared";

    return { dimension, state, provenCount, speculativeCount, indeterminateCount };
  });
}

// ---------------------------------------------------------------------------
// CONFIG-ONLY TIER — comparing two versions with NO run in hand
// ---------------------------------------------------------------------------

/**
 * What can be said by comparing two `configSnapshot`s alone, with zero events
 * read.
 *
 * THIS TYPE HAS NO `verdict` AND NO `proven`, AND BOTH ABSENCES ARE THE POINT.
 *
 * Every proof in this feature is a statement about something a run ACTUALLY
 * DID: "the run called `search_web` at sequence 42, and the target declares no
 * such tool." With no run in hand there is no sequence 42, and "the target
 * removed a tool" is not evidence that anything ever called it — it is a
 * hypothesis awaiting a history. A config-only tier that emitted a verdict
 * would be handing an operator a deploy decision derived from no evidence,
 * dressed in the same word (`incompatible`) the evidence-backed tier uses.
 *
 * Leaving `verdict` optional would not have worked: an optional field that
 * must never be set is a field that gets set. Omitting it from the type makes
 * the mistake unrepresentable — the cheap tier CANNOT state a verdict, so
 * nothing downstream can render one, and a caller who wants one has to go get
 * the runs, which is exactly the work the verdict is supposed to rest on.
 */
export interface ConfigDivergenceReport {
  sourceVersionId: string;
  targetVersionId: string;
  analyzedAt: number;
  /**
   * Changes between the two configs. Speculative by construction: without a
   * history, every difference is a "may".
   */
  speculative: SpeculativeDivergence[];
  /** Questions the two snapshots could not answer between them. */
  indeterminate: IndeterminateDivergence[];
  /**
   * Which dimensions the TARGET declared well enough to be analysable at all —
   * the cheap pre-flight an operator wants before spending a fleet scan: "this
   * version declares tools and model; a scan can prove things about those two
   * and nothing else."
   */
  analysableDimensions: DivergenceDimension[];
  coverage: DivergenceCoverage;
}

// ---------------------------------------------------------------------------
// Fleet report — the same question over an agent's recent history
// ---------------------------------------------------------------------------

/**
 * The scan a fleet report was computed over.
 *
 * `scanTruncated` follows the same posture as `FailurePattern`'s pattern scan
 * (ADR-005): the server states the incompleteness in a field rather than
 * refusing, and the GATE decides that an incomplete scan is not a pass.
 */
export interface DivergenceScanWindow {
  /** Lower bound on `run.startedAt`, when the caller asked for one. Echoed for ignored-parameter detection. */
  since?: number;
  /** Upper bound, if any. */
  until?: number;
  /** Runs the scan visited. */
  runsScanned: number;
  /** Runs actually analysed (a run may be visited and skipped — see `runsUnassessable`). */
  runsAnalyzed: number;
  /**
   * Runs that were visited but could not be analysed at all (no events
   * retained, unreadable snapshot). NOT counted as clean — they are why
   * `isFleetScanComplete` can be false with `scanTruncated: false`.
   */
  runsUnassessable: number;
  /**
   * Runs inside the window that were not analysed because the execution's own
   * budget ran out before reaching them — distinct from `runsUnassessable`
   * (visited and unreadable) and from `scanTruncated` (stopped at the row
   * ceiling). A fleet scan is a BOUNDED BATCH, not a whole-history query: one
   * `.paginate()` per execution, against runs whose event logs run to
   * `MAX_EVENTS_PER_RUN`. Runs the budget never reached are simply unexamined,
   * and unexamined runs are not runs that passed.
   */
  runsSkippedForBudget: number;
  /** True when the scan stopped on the server's row ceiling: the counts are floors, not totals. */
  scanTruncated: boolean;
  /** The ceiling that was hit, when the server reported it. */
  scanRowCeiling?: number;
  /**
   * PAGES REMAIN. Pass it back as `cursor` to continue the scan; merge pages
   * with {@link mergeFleetDivergenceReports}.
   *
   * ITS PRESENCE ALONE MAKES THE SCAN INCOMPLETE, and that is the single most
   * important line in this file for anyone putting `afr compat` in CI. A first
   * page is not a fleet answer: the twelfth reason, on the run that matters,
   * is on page four. A report with a `nextCursor` that read as `compatible`
   * would be a green build over an unscanned fleet — the worst bug this
   * feature can have, and the reason this field is folded into
   * {@link isFleetScanComplete} rather than left to each consumer to remember.
   */
  nextCursor?: string;
}

/**
 * A fleet scan is complete only when it ACTUALLY ANALYSED A RUN, and then
 * truncated nothing, skipped nothing, failed on nothing, and has no pages
 * left.
 *
 * FIVE CONDITIONS, and the FIRST one is the one to protect. Four of them are
 * negative ("nothing went wrong"), and a predicate made only of negative
 * clauses is VACUOUSLY TRUE ON AN EMPTY SCAN:
 *
 *   { runsScanned: 0, runsAnalyzed: 0, runsUnassessable: 0,
 *     runsSkippedForBudget: 0, scanTruncated: false }
 *
 * Nothing truncated, nothing skipped, nothing failed — and nothing examined.
 * Fed to {@link computeDivergenceVerdict} with no reasons, that returned
 * `compatible`: A FLEET-WIDE GREEN LIGHT DERIVED FROM ZERO RUNS. And an empty
 * window is not exotic; it is what ordinary operation produces the moment a
 * version's runs age out of the retention window (ADR-001), which is exactly
 * when an operator is most likely to be asking whether an old version can be
 * replaced.
 *
 * `runsAnalyzed > 0` is the positive clause that fixes it, and it is the right
 * one rather than `runsScanned > 0`: a scan that visited a hundred runs and
 * analysed none of them has established nothing about any of them. (Those
 * hundred are already counted by `runsUnassessable` / `runsSkippedForBudget`,
 * so this clause is not doing their job — it is covering the case where there
 * was nothing to count in the first place.)
 *
 * See {@link isDivergenceCoverageComplete} for the same category error one
 * level down, and for why "was anything truncated?" is not the question this
 * predicate is being asked.
 *
 * HISTORICAL NOTE, KEPT DELIBERATELY: the divergence engine
 * (`convex/helpers/`) carried a local override adding this very condition,
 * because the server had to be right about the empty case while this helper
 * was not. That override is the seam this feature exists to eliminate — an
 * exported contract helper that disagrees with the server about the same facts
 * means every client re-deriving the verdict gets a different answer than the
 * server computed. The override should now be deleted rather than kept in
 * sync.
 */
export function isFleetScanComplete(window: DivergenceScanWindow): boolean {
  return (
    window.runsAnalyzed > 0 &&
    !window.scanTruncated &&
    window.runsUnassessable === 0 &&
    window.runsSkippedForBudget === 0 &&
    window.nextCursor === undefined
  );
}

/**
 * One DISTINCT PROVEN REASON, with the runs it accounts for.
 *
 * The fleet answer leads with these rather than with a run count on purpose:
 * 340 broken runs with 12 root causes is a tractable morning; 340 individual
 * reports is not. `affectedRunCount` is a property OF a reason, never the
 * headline.
 */
export interface ProvenDivergenceReason {
  /** Same `reasonKey` the per-run findings carry — that is what grouped them. */
  reasonKey: string;
  kind: ProvenDivergenceKind;
  /** Redundant with `exemplar.certainty` and kept anyway: a grouped view must not need to dereference the exemplar to know what it is looking at. */
  certainty: "proven";
  /** How many analysed runs carried a proven divergence with this `reasonKey`. */
  affectedRunCount: number;
  /** Bounded (<= 5), most-recent-first sample. Somewhere to start; not the full set. */
  representativeRunIds: string[];
  /** A real finding from one of those runs, with its real proof. Not a synthesised summary. */
  exemplar: ProvenDivergence;
}

/** One distinct SPECULATIVE reason. Structurally separate from {@link ProvenDivergenceReason} for the same reasons the findings are. */
export interface SpeculativeDivergenceReason {
  reasonKey: string;
  kind: SpeculativeDivergenceKind;
  certainty: "speculative";
  affectedRunCount: number;
  representativeRunIds: string[];
  exemplar: SpeculativeDivergence;
}

/**
 * One distinct question the fleet scan could not answer, and how many runs it
 * left unanswered.
 *
 * Grouped like the other two, and reported like them, because "the tool list
 * has been unreadable on 300 runs" is a single fixable fact about the version,
 * not 300 incidents.
 */
export interface IndeterminateDivergenceReason {
  reasonKey: string;
  kind: IndeterminateDivergenceKind;
  certainty: "indeterminate";
  affectedRunCount: number;
  representativeRunIds: string[];
  exemplar: IndeterminateDivergence;
}

/**
 * "Can I ship version X across everything this agent has actually been doing?"
 *
 * Same derived-projection posture as {@link DivergenceReport}, one level up.
 */
export interface FleetDivergenceReport {
  agentId: string;
  /** Echoed for ignored-parameter detection, exactly as on {@link DivergenceReport.targetVersionId}. */
  targetVersionId: string;
  analyzedAt: number;
  /** Must equal `fleetDivergenceVerdict(...)` over this report's own contents. Clients verify. */
  verdict: DivergenceVerdict;
  /** Distinct proven reasons, most-affecting first. THE HEADLINE. */
  provenReasons: ProvenDivergenceReason[];
  /** Distinct speculative reasons. */
  speculativeReasons: SpeculativeDivergenceReason[];
  /**
   * Distinct questions the scan could not answer. Non-empty means the fleet
   * answer is incomplete, whatever `provenReasons` says — see
   * {@link isFleetDivergenceAnalysisComplete}.
   */
  indeterminateReasons: IndeterminateDivergenceReason[];
  /**
   * Runs with at least one PROVEN divergence. Note this is not the sum of
   * `provenReasons[].affectedRunCount` — one run can break for several reasons.
   */
  runsWithProvenDivergence: number;
  /** REQUIRED. What the scan covered — see {@link DivergenceScanWindow}. */
  window: DivergenceScanWindow;
}

/**
 * Was this fleet analysis actually finished? The scan window must be whole
 * AND no question may have gone unanswered — the fleet counterpart of
 * {@link isDivergenceAnalysisComplete}, and the single definition for the
 * fleet gate.
 */
export function isFleetDivergenceAnalysisComplete(report: FleetDivergenceReport): boolean {
  return isFleetScanComplete(report.window) && report.indeterminateReasons.length === 0;
}

/** Convenience: the verdict this fleet report's own contents imply. Use to verify a server's `verdict`. */
export function fleetDivergenceVerdict(report: FleetDivergenceReport): DivergenceVerdict {
  return computeDivergenceVerdict({
    provenCount: report.provenReasons.length,
    speculativeCount: report.speculativeReasons.length,
    complete: isFleetDivergenceAnalysisComplete(report),
  });
}

/** Bound on `representativeRunIds` in every reason type. Mirrors `FailurePattern.representativeRunIds`. */
export const MAX_DIVERGENCE_REPRESENTATIVE_RUNS = 5;

/**
 * Merge consecutive pages of a fleet scan into one report.
 *
 * A fleet scan is a bounded batch with a cursor, so the fleet ANSWER is
 * assembled from pages. That assembly is exact rather than approximate, and
 * the reason is a property of the design: a `reasonKey` is RUN-INDEPENDENT
 * (contracts requires it to contain no run id, timestamp or sequence number),
 * and pages PARTITION the run set — each run appears on exactly one page. So
 * counts add and reason keys collide correctly, with no double counting and no
 * reconciliation pass.
 *
 * THIS LIVES IN CONTRACTS BECAUSE THERE MUST BE EXACTLY ONE OF IT. The server
 * merges pages when it can; the CLI merges when it pages itself; the web UI
 * merges when it loads more. Three implementations of "how do these add up"
 * is three chances for a CI gate and a dashboard to disagree about whether a
 * version ships — the same failure the shared triage ranking exists to
 * prevent, one feature over.
 *
 * The merged window is the CONSERVATIVE union: any page that truncated makes
 * the whole scan truncated, skipped counts add, and the merged `nextCursor` is
 * the LAST page's — so a merge that stopped early still reports itself
 * incomplete and can never read as a whole-fleet all-clear.
 *
 * @param pages - pages in scan order. All must share `agentId` and
 *   `targetVersionId`; a mismatch throws, because merging answers about two
 *   different versions would produce a report about neither.
 * @returns one report. Verdict is recomputed from the merged contents — never
 *   inherited from a page, whose verdict described only its own slice.
 */
export function mergeFleetDivergenceReports(pages: FleetDivergenceReport[]): FleetDivergenceReport {
  const first = pages[0];
  if (first === undefined) {
    throw new RangeError("mergeFleetDivergenceReports: at least one page is required.");
  }
  for (const page of pages) {
    if (page.agentId !== first.agentId || page.targetVersionId !== first.targetVersionId) {
      throw new RangeError(
        `mergeFleetDivergenceReports: pages disagree about their subject ` +
          `(${first.agentId}/${first.targetVersionId} vs ${page.agentId}/${page.targetVersionId}). ` +
          `Merging answers about two different versions would produce a report about neither.`
      );
    }
  }

  const proven = mergeReasons(pages.flatMap((p) => p.provenReasons));
  const speculative = mergeReasons(pages.flatMap((p) => p.speculativeReasons));
  const indeterminate = mergeReasons(pages.flatMap((p) => p.indeterminateReasons));
  const last = pages[pages.length - 1];

  const window: DivergenceScanWindow = {
    ...(first.window.since !== undefined && { since: first.window.since }),
    ...(first.window.until !== undefined && { until: first.window.until }),
    runsScanned: sum(pages, (p) => p.window.runsScanned),
    runsAnalyzed: sum(pages, (p) => p.window.runsAnalyzed),
    runsUnassessable: sum(pages, (p) => p.window.runsUnassessable),
    runsSkippedForBudget: sum(pages, (p) => p.window.runsSkippedForBudget),
    scanTruncated: pages.some((p) => p.window.scanTruncated),
    ...(first.window.scanRowCeiling !== undefined && { scanRowCeiling: first.window.scanRowCeiling }),
    // The last page's cursor, present exactly when the scan did not finish.
    ...(last?.window.nextCursor !== undefined && { nextCursor: last.window.nextCursor }),
  };

  const merged: FleetDivergenceReport = {
    agentId: first.agentId,
    targetVersionId: first.targetVersionId,
    analyzedAt: Math.max(...pages.map((p) => p.analyzedAt)),
    // Placeholder, replaced immediately below — the verdict is a function of
    // the merged contents, never of any page's own slice.
    verdict: "indeterminate",
    provenReasons: proven,
    speculativeReasons: speculative,
    indeterminateReasons: indeterminate,
    runsWithProvenDivergence: sum(pages, (p) => p.runsWithProvenDivergence),
    window,
  };
  return { ...merged, verdict: fleetDivergenceVerdict(merged) };
}

function sum<T>(items: T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}

/**
 * Collapse reasons sharing a `reasonKey`: counts add, representative run ids
 * union (bounded, first-seen order), and the FIRST exemplar wins.
 *
 * Keeping the first exemplar rather than synthesising one matters: an exemplar
 * is a real finding from a real run, carrying real proof. A merged exemplar
 * would be a fabricated finding citing a run that never produced it.
 */
function mergeReasons<
  R extends { reasonKey: string; affectedRunCount: number; representativeRunIds: string[] },
>(reasons: R[]): R[] {
  const byKey = new Map<string, R>();
  for (const reason of reasons) {
    const existing = byKey.get(reason.reasonKey);
    if (existing === undefined) {
      byKey.set(reason.reasonKey, {
        ...reason,
        representativeRunIds: reason.representativeRunIds.slice(0, MAX_DIVERGENCE_REPRESENTATIVE_RUNS),
      });
      continue;
    }
    const runIds = [...existing.representativeRunIds];
    for (const runId of reason.representativeRunIds) {
      if (runIds.length >= MAX_DIVERGENCE_REPRESENTATIVE_RUNS) break;
      if (!runIds.includes(runId)) runIds.push(runId);
    }
    byKey.set(reason.reasonKey, {
      ...existing,
      affectedRunCount: existing.affectedRunCount + reason.affectedRunCount,
      representativeRunIds: runIds,
    });
  }
  // Most-affecting first — the fleet view's whole job is to put the biggest
  // root cause at the top.
  return [...byKey.values()].sort((a, b) => b.affectedRunCount - a.affectedRunCount);
}
