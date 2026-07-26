// ADR-002 — pure validation/derivation helpers for the run-hierarchy /
// environment / labels / search / token-usage fields. Deliberately
// dependency-free of auth.ts so BOTH the Clerk-authenticated path
// (convex/runs.ts, convex/events.ts) and the API-key path (convex/sdk_ingest.ts,
// which must NOT import auth.ts) can share this logic without duplicating it —
// mirrors why VALID_EVENT_TYPES / MAX_EVENTS_PER_RUN already live in a shared,
// auth-free module.

import { afrError } from "./errors.js";
import {
  MAX_ENVIRONMENT_LENGTH,
  MAX_LABELS_PER_RUN,
  MAX_LABEL_LENGTH,
  MAX_MODELS_SEEN_PER_RUN,
  MAX_SEARCH_TEXT_BYTES,
  MAX_SESSION_ID_LENGTH,
} from "./pagination.js";

/**
 * runs.environment accepts the well-known set OR any custom string up to
 * MAX_ENVIRONMENT_LENGTH (see ADR-002) — this is intentionally NOT a closed
 * enum, so KNOWN_ENVIRONMENTS is documentation/UI-hinting only, not an
 * enforced allowlist.
 */
export function validateEnvironment(environment: string | undefined): void {
  if (environment === undefined) return;
  if (environment.length === 0 || environment.length > MAX_ENVIRONMENT_LENGTH) {
    throw afrError(
      "INVALID_ARGUMENT",
      `environment must be 1-${MAX_ENVIRONMENT_LENGTH} characters`,
    );
  }
}

/** Write ceiling for runs.labels: at most MAX_LABELS_PER_RUN, each bounded. */
export function validateLabels(labels: string[] | undefined): void {
  if (labels === undefined) return;
  if (labels.length > MAX_LABELS_PER_RUN) {
    throw afrError(
      "INVALID_ARGUMENT",
      `At most ${MAX_LABELS_PER_RUN} labels are allowed per run`,
    );
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      throw afrError(
        "INVALID_ARGUMENT",
        `Each label must be 1-${MAX_LABEL_LENGTH} characters`,
      );
    }
  }
}

export function validateSessionId(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw afrError(
      "INVALID_ARGUMENT",
      `sessionId must be 1-${MAX_SESSION_ID_LENGTH} characters`,
    );
  }
}

/**
 * Join non-empty parts with a space and truncate to the searchText byte
 * budget (UTF-8). Never throws — searchText is a best-effort search-index
 * source field, not a validated user input.
 */
export function buildSearchText(parts: Array<string | undefined>): string | undefined {
  const joined = parts.filter((p): p is string => !!p && p.length > 0).join(" ");
  if (joined.length === 0) return undefined;
  const bytes = new TextEncoder().encode(joined);
  if (bytes.length <= MAX_SEARCH_TEXT_BYTES) return joined;
  const truncated = bytes.slice(0, MAX_SEARCH_TEXT_BYTES);
  // Lenient decode: a multi-byte UTF-8 char split at the boundary decodes to
  // U+FFFD rather than throwing — acceptable for a search-index source field.
  return new TextDecoder("utf-8", { fatal: false }).decode(truncated);
}

/**
 * Tolerant extraction of token usage from an `llm.response` event payload.
 * Accepts both `{ usage: { input_tokens, output_tokens } }` (Anthropic-style)
 * and flat `{ prompt_tokens, completion_tokens }` (OpenAI-style) shapes, plus
 * an already-normalized `{ tokensIn, tokensOut }`. Never throws — an
 * unrecognized payload shape simply contributes zero.
 */
export function extractTokenUsage(payload: unknown): { tokensIn: number; tokensOut: number } {
  if (!payload || typeof payload !== "object") {
    return { tokensIn: 0, tokensOut: 0 };
  }
  const top = payload as Record<string, unknown>;
  const usage =
    top["usage"] && typeof top["usage"] === "object"
      ? (top["usage"] as Record<string, unknown>)
      : top;

  const firstNumber = (candidates: unknown[]): number => {
    for (const c of candidates) {
      if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
    }
    return 0;
  };

  const tokensIn = firstNumber([
    usage["input_tokens"],
    usage["prompt_tokens"],
    usage["tokensIn"],
  ]);
  const tokensOut = firstNumber([
    usage["output_tokens"],
    usage["completion_tokens"],
    usage["tokensOut"],
  ]);
  return { tokensIn, tokensOut };
}

/**
 * Tolerant extraction of a model name/id from an `llm.request` or
 * `llm.response` event payload. Accepts several shapes seen across SDK
 * client libraries: a top-level `model`, a nested `request.model` /
 * `response.model` (some SDKs echo the request under the response payload),
 * and Anthropic/OpenAI-style `{ model: "..." }` bodies. Never throws — an
 * unrecognized payload shape simply contributes nothing (cost accuracy is
 * best-effort, not a validated guarantee).
 */
export function extractModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const top = payload as Record<string, unknown>;

  const candidates: unknown[] = [top["model"]];
  for (const key of ["request", "response", "body"]) {
    const nested = top[key];
    if (nested && typeof nested === "object") {
      candidates.push((nested as Record<string, unknown>)["model"]);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

/**
 * Fold a newly-observed model string into runs.modelsSeen: deduped,
 * insertion-order preserved, capped at MAX_MODELS_SEEN_PER_RUN. Returns
 * `undefined` (no patch needed) when the model is absent or already present
 * and the array is unchanged, so callers can skip a no-op `ctx.db.patch`.
 */
export function addModelSeen(
  existing: string[] | undefined,
  model: string | undefined,
): string[] | undefined {
  if (!model) return undefined;
  const current = existing ?? [];
  if (current.includes(model)) return undefined;
  if (current.length >= MAX_MODELS_SEEN_PER_RUN) return undefined;
  return [...current, model];
}

/**
 * Tolerant extraction of a human-readable error message from a run.failed
 * event payload, for appending to runs.searchText at terminal reconcile.
 * Never throws.
 *
 * M4 (searchable error text for externalized failures): `errorSummary` is
 * checked FIRST, before the older `message`/`errorMessage`/`error.message`
 * fields. The SDK attaches this redacted, <=512-char string as a sibling
 * field on BOTH run.failed payload shapes (packages/contracts/src/events.ts
 * RunFailedPayload.errorSummary and ExternalizedPayload.errorSummary):
 *   - inline: { type: "run.failed", error, duration_ms, errorSummary }
 *   - externalized: { type: "_externalized", originalType: "run.failed",
 *     _artifact, errorSummary }
 * For an externalized run.failed, the full `error` object lives only in the
 * blob artifact — it is never read at ingest time — so `errorSummary` is the
 * ONLY way any error text reaches runs.searchText for a large failure
 * payload. Checking it first (rather than only as a fallback) also means a
 * caller-supplied `errorSummary` takes precedence over a possibly-truncated
 * or differently-formatted `message`/`error.message` on the inline shape,
 * matching the SDK's redaction/sizing guarantees.
 */
export function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p["errorSummary"] === "string" && p["errorSummary"].length > 0) {
    return p["errorSummary"];
  }
  if (typeof p["message"] === "string") return p["message"];
  if (typeof p["errorMessage"] === "string") return p["errorMessage"];
  if (p["error"] && typeof p["error"] === "object") {
    const err = p["error"] as Record<string, unknown>;
    if (typeof err["message"] === "string") return err["message"];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ADR-007 — the O(1) ordering verdict for a derived run.
//
// WHAT THIS EXISTS TO REPLACE. `analyzeRunOrdering` (contracts) returns
// `sequence-native` | `temporal` | `ingest-unverified`, and the verdict is a
// property of the WHOLE log: `ingest-unverified` iff ANY derived event lacks a
// temporal key. That asymmetry is the problem. Seeing one unkeyed event PROVES
// the run is unverifiable, but no window can ever prove the other two verdicts
// — absence of evidence within a page says nothing about the rest of the run.
// So a paged consumer can only ship a one-sided alarm, and the full verdict
// costs an O(run) scan that the MCP tier-4 budget exists to refuse and that
// `apps/web` currently pays on every render.
//
// These two counters record the fact at the ONE moment it is free: on write,
// when we already hold the events. ADR-002's terms apply and are met —
// additive, org-scoped, observability-grade, and never a substitute for the
// event log, which remains the source of truth for the ordering itself.
//
// THE THREE PROPERTIES THAT MAKE THEM SAFE, each of which the counter would be
// worthless without:
//
//   ADD-ONLY. Both are sums over appended events. Nothing recomputes them and
//     nothing decrements, so they cannot drift the way a cached aggregate can.
//   PARTITION-INDEPENDENT. Each is a function of the event SET, not of arrival
//     order, so a trace delivered in any number of batches in any order
//     produces the same totals. A counter that depended on arrival order would
//     be R1 again in a new costume.
//   REDELIVERY-NEUTRAL. A redelivered batch appends ZERO events, so it adds
//     zero. Idempotency is inherited from the append path rather than needing
//     its own guard.
//
// ONE SHARED COUNTER FOR EVERY WRITER, deliberately. The counted property is
// "was this row written without a temporal key", so the count has to be taken
// wherever rows are written — and there are two such places (the ingest batch
// and the settle terminal). A second hand-rolled tally in the second writer is
// exactly the mirroring failure this codebase keeps paying for, so both call
// this.
// ---------------------------------------------------------------------------

export interface DerivedOrderingTally {
  /** Events whose provenance says `otel` — i.e. our interpretation, not a first-party recording. */
  derived: number;
  /**
   * Derived events stored WITHOUT a usable temporal key. Non-zero means the run
   * can only be rendered in arrival order, and must be LABELLED as such rather
   * than presented as a timeline.
   */
  unkeyed: number;
}

/**
 * Tally the ordering-relevant facts about a batch of events about to be (or
 * just) appended.
 *
 * The key check is STRUCTURAL, not merely a presence test: a malformed stored
 * key must count as absent, for the same reason `isTemporalOrderKey` validates
 * before trusting — a half-parsed ordering key produces a confidently wrong
 * timeline, which is worse than an admittedly unverified one.
 *
 * ---------------------------------------------------------------------------
 * ONE BUCKET, NOT TWO — "no key" and "unusable key" are counted together, and
 * this is a decision rather than an oversight. Do not "fix" it by splitting.
 *
 * `/^\d+$/` means a NEGATIVE epoch instant — reachable from an emitter with a
 * badly set clock — counts as unkeyed, so `otelUnkeyedDerivedCount` can be
 * non-zero for a run that is otherwise perfectly well formed. Splitting the
 * buckets to report that case more precisely looks like an improvement and is
 * in fact the one change that would break the counter:
 *
 *   THE COUNTER'S ENTIRE PURPOSE IS TO BE AN O(1) EQUIVALENT OF
 *   `analyzeRunOrdering`. That function reads keys through
 *   `isTemporalOrderKey`, which applies exactly this `/^\d+$/` test and treats
 *   a failing key as ABSENT. If this tally classified an unusable key
 *   differently, the O(1) verdict and the O(run) verdict would disagree — and
 *   a fast path that disagrees with the authority it stands in for is worse
 *   than no fast path, because a consumer cannot tell which one lied.
 *
 * It is also not a false alarm. `readTemporalOrder` rejects such a key, so
 * `orderEventsForProjection` really does fall back to the sequence sort: the
 * run really can only be shown in arrival order. Reporting `ingest-unverified`
 * for it is the truth, not an over-reaction — and the alternative (clamping a
 * negative instant to zero so it parses) would falsify a recorded timestamp,
 * which is the one thing this whole path exists not to do.
 *
 * If the product ever wants to distinguish "badly clocked" from "unkeyed" in
 * the UI, the place to do it is a separate signal derived from
 * `provenance.lossReasons`, NOT by desynchronising these two functions.
 * ---------------------------------------------------------------------------
 */
export function tallyDerivedOrdering(
  events: ReadonlyArray<{
    provenance?: { source?: string } | undefined;
    temporalOrder?: unknown;
  }>,
): DerivedOrderingTally {
  let derived = 0;
  let unkeyed = 0;
  for (const event of events) {
    if (event.provenance?.source !== "otel") continue;
    derived += 1;
    const key = event.temporalOrder;
    const ok =
      typeof key === "object" &&
      key !== null &&
      typeof (key as Record<string, unknown>)["instantUnixNano"] === "string" &&
      /^\d+$/.test((key as Record<string, unknown>)["instantUnixNano"] as string) &&
      typeof (key as Record<string, unknown>)["spanId"] === "string";
    if (!ok) unkeyed += 1;
  }
  return { derived, unkeyed };
}
