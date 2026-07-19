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
 */
export function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p["message"] === "string") return p["message"];
  if (typeof p["errorMessage"] === "string") return p["errorMessage"];
  if (p["error"] && typeof p["error"] === "object") {
    const err = p["error"] as Record<string, unknown>;
    if (typeof err["message"] === "string") return err["message"];
  }
  return undefined;
}
