// ---------------------------------------------------------------------------
// CAUSAL EDGE DERIVATION — the log is the record.
//
// PURE. No `ctx`, no I/O, no clock. Given one stored event (or one artifact
// pair), decide whether it RECORDS a cross-run handoff, and if so, which.
//
// ===========================================================================
// WHY THIS FILE EXISTS AT ALL — THE SUBSTRATE RULING
// ===========================================================================
//
// An earlier draft of this feature stored causal edges as free-standing rows in
// `run_causal_edges` that a caller asserted directly. That was wrong, and the
// argument that kills it is the same one that put `provenance` on the event
// record rather than in a side table:
//
//   A SIDE TABLE IS MUTABLE AND DELETABLE. A lost row silently relaunders the
//   fact. And the absence of a causal-edge row is INDISTINGUISHABLE from "there
//   was never a handoff" — which is precisely the recorded-origin-versus-lost-
//   trail distinction this whole feature exists to preserve, defeated by its
//   own storage.
//
// So the RECORD is the append-only event log (and the immutable `runs.parentRunId`
// field, and the artifact checksum). A handoff is recorded the moment it
// happens, by the run that performed it, in a row that can never be edited.
//
// `run_causal_edges` still exists, but ONLY as a DERIVED, REBUILDABLE INDEX
// over that log — the same category as `runs.tokensIn` / `runs.modelsSeen` /
// `runs.otelMaxInstantNano` under ADR-002, and for the same reason: the query
// it enables ("which OTHER run's log names run X?") is not answerable from any
// index the events table can carry, because it is a lookup keyed on a value
// buried inside `payload`, which is `v.any()`.
//
// THE TEST THAT KEEPS IT HONEST: every row must be reproducible by
// {@link deriveEdgeClaims} from the log alone. `rebuildRunCausalEdges` in
// convex/causality.ts does exactly that — delete the rows derived from a run's
// log, re-derive them, and the set must be identical. If a row cannot be
// rebuilt, it should not exist.
//
// ===========================================================================
// WHAT COUNTS AS A RECORD, AND WHAT EMPHATICALLY DOES NOT
// ===========================================================================
//
// A handoff is recorded when a run's own log NAMES THE OTHER RUN'S ID. That is
// the whole rule. The recorder had the other run id in hand at the moment of
// the handoff and wrote it down; nobody afterwards is guessing.
//
// NOT a record, and no code path here can produce one:
//   * two runs adjacent in time
//   * two runs sharing a `sessionId`
//   * two runs on the same agent
//   * two runs failing with the same fingerprint
//
// Each of those is a `SuspectedLink` in packages/contracts/src/causality.ts —
// directionless by construction, unwalkable, and unable to move a verdict. This
// file cannot emit one: it returns edge claims only, and every claim it returns
// carries the id of the event that named the other run.
// ---------------------------------------------------------------------------

import type { RecordedCausalEdgeKind } from "@agent-flight-recorder/contracts";

/**
 * One handoff a stored event records.
 *
 * `namedRunId` is a STRING and deliberately unvalidated here: this module is
 * pure and cannot check that the id resolves, let alone that it resolves inside
 * the caller's org. Both checks happen at the ctx layer, which drops a claim
 * naming a run it cannot observe — so a payload carrying a foreign or fabricated
 * id produces no edge, indistinguishably.
 */
export interface DerivedEdgeClaim {
  kind: RecordedCausalEdgeKind;
  /** The other run, as the event's own payload spells it. */
  namedRunId: string;
  /**
   * Which endpoint the RECORDING run is.
   *
   * `producer` means "the run whose log this is came first" (it spawned /
   * delegated to the named run). `consumer` means "the run whose log this is
   * ran second" (it consumed / retried the named run). Direction is READ OFF
   * THE PAYLOAD KEY, never inferred from timestamps — which is why the key set
   * below is closed and each member states its direction.
   */
  recordingRunIs: "producer" | "consumer";
  /** The payload key that carried the id. Goes into the citation so a reader can check it. */
  payloadPath: string;
}

/**
 * THE CLOSED SET OF PAYLOAD KEYS THAT RECORD A HANDOFF.
 *
 * Closed on purpose, and each entry fixes BOTH the edge kind and the direction.
 * A tolerant "any key ending in RunId" reader would be a temporal-adjacency
 * heuristic wearing a different hat: it would happily read a key meaning
 * "the run I am comparing against" or "the run this dashboard links to" as a
 * dataflow arrow.
 *
 * The spellings are the contract's `RecordedCausalEdgeKind` members turned into
 * payload keys, plus the snake_case variants, because an SDK in another language
 * will write those and a missed edge is a lost trail.
 */
const HANDOFF_KEYS: ReadonlyArray<{
  keys: readonly string[];
  kind: RecordedCausalEdgeKind;
  recordingRunIs: "producer" | "consumer";
}> = [
  // The recording run STARTED the named run.
  { keys: ["spawnedRunId", "spawned_run_id", "childRunId", "child_run_id"], kind: "spawned", recordingRunIs: "producer" },
  // The recording run DELEGATED a sub-task to the named run.
  { keys: ["delegatedToRunId", "delegated_to_run_id"], kind: "delegated_to", recordingRunIs: "producer" },
  // The recording run CONSUMED the named run's output.
  { keys: ["consumedRunId", "consumed_run_id", "inputFromRunId", "input_from_run_id"], kind: "output_consumed", recordingRunIs: "consumer" },
  // The recording run is a RETRY of the named run.
  { keys: ["retryOfRunId", "retry_of_run_id"], kind: "retry_of", recordingRunIs: "consumer" },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Derive every handoff claim a single stored event records.
 *
 * TOTAL and NEVER THROWS. An externalized payload (Event Log Rule 3) is a
 * pointer object with none of these keys, so it yields nothing — which is
 * correct and is a real, stated gap: a handoff recorded inside a payload that
 * exceeded the 10 KB inline ceiling is invisible to this derivation. The
 * traversal reports that honestly as an unread adjacency rather than as "no
 * edge"; see convex/causality.ts.
 *
 * The lookup is SHALLOW — the payload root only. A deep search starts matching
 * keys that mean something else, which is exactly how a confident wrong arrow
 * gets drawn. Same reasoning as `NESTED_CONTAINERS` in helpers/divergence.ts,
 * resolved more strictly here because the output is an arrow rather than a hint.
 */
export function deriveEdgeClaims(payload: unknown): DerivedEdgeClaim[] {
  if (!isPlainObject(payload)) return [];
  // An externalized pointer records no handoff — it records that the payload
  // went to blob storage. Checked explicitly so the intent is visible.
  if (payload["type"] === "_externalized") return [];

  const out: DerivedEdgeClaim[] = [];
  const seen = new Set<string>();
  for (const entry of HANDOFF_KEYS) {
    for (const key of entry.keys) {
      const value = payload[key];
      if (typeof value !== "string") continue;
      const namedRunId = value.trim();
      if (namedRunId.length === 0) continue;
      const dedupe = `${entry.kind}:${namedRunId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        kind: entry.kind,
        namedRunId,
        recordingRunIs: entry.recordingRunIs,
        payloadPath: key,
      });
    }
  }
  return out;
}

/**
 * Does this payload record a handoff at all? Cheap pre-check for the write
 * paths, which call it on every single event insert.
 */
export function recordsHandoff(payload: unknown): boolean {
  return deriveEdgeClaims(payload).length > 0;
}

/** Every payload key this module recognises. Exported so a test can assert the set is closed. */
export const HANDOFF_PAYLOAD_KEYS: readonly string[] = HANDOFF_KEYS.flatMap((e) => e.keys);
