/**
 * ADR-004 — pluggable LLM provider for run explanations ("Why did this
 * fail?"). Mirrors the shape of `convex/helpers/notifier.ts`'s
 * `EmailNotifier`/`getConfiguredEmailNotifier` exactly:
 *
 *   - `ExplanationLLM` is a tiny, provider-agnostic interface.
 *   - `NoopExplanationLLM` (the DEFAULT) never calls out to anything and
 *     always reports "not configured" — no configuration required, safe for
 *     local dev and any deployment that hasn't opted into a real provider.
 *     The DETERMINISTIC heuristic explanation (Team B's
 *     `buildHeuristicExplanation`, `convex/insights.ts`) is ALWAYS generated
 *     regardless of whether an LLM is configured — this provider only ever
 *     supplements it.
 *   - `HttpExplanationLLM` is a SHAPE-ONLY, generic HTTP-POST provider: it
 *     does not hardcode a vendor. It reads its endpoint/API key from env vars
 *     and posts the grounding prompt as JSON, expecting a JSON response
 *     shaped `{ summary, rootCause, suggestedFix?, citedSeqNums }`. A real
 *     deployment wires a specific vendor by setting `AFR_LLM_ENDPOINT` (and
 *     `AFR_LLM_API_KEY` if the endpoint requires bearer auth) — nothing here
 *     assumes a particular vendor's request/response shape beyond that
 *     minimal contract, matching this file's brief ("do NOT hardcode a
 *     vendor").
 *   - `getConfiguredExplanationLLM()` is the single factory every call site
 *     uses. It NEVER throws: an unset or unrecognized `AFR_LLM_PROVIDER`
 *     falls back to `NoopExplanationLLM`, so a misconfiguration degrades to
 *     "heuristic only" rather than breaking explanation generation.
 *
 * GROUNDING CONTRACT (enforced by the CALLER, `convex/run_explanations.ts`,
 * not by this file): any `citedSeqNums` returned by `explain()` that do not
 * correspond to a real event on the run are stripped before the explanation
 * is stored; if validation leaves too little to trust, the caller discards
 * the LLM result entirely and falls back to the heuristic explanation. This
 * file is intentionally trust-nothing about what a configured provider
 * returns.
 */

// ---------------------------------------------------------------------------
// ExplanationLLM
// ---------------------------------------------------------------------------

/** A grounding prompt built by the caller — always includes the run's real event sequenceNumbers. */
export interface GroundedExplanationPrompt {
  /** Full prompt text, including instructions to cite only sequenceNumbers that appear below. */
  prompt: string;
  /** The exact sequenceNumbers present in the run's (bounded) event window — for the caller's own reference, not sent verbatim beyond what `prompt` already embeds. */
  availableSequenceNumbers: number[];
}

export interface ExplanationLLMResult {
  summary: string;
  rootCause: string;
  suggestedFix?: string;
  /** Sequence numbers the model claims to be citing. Validated by the caller — never trusted as-is. */
  citedSeqNums: number[];
  /** Wall-clock time spent in the provider call (ms), for the stored explanation's optional generationMs note. */
  generationMs?: number;
}

export interface ExplanationLLM {
  /** Returns `undefined` if the provider could not produce a result (network error, bad response, not configured). Never throws. */
  explain(input: GroundedExplanationPrompt): Promise<ExplanationLLMResult | undefined>;
}

// ---------------------------------------------------------------------------
// HttpExplanationLLM hardening constants
// ---------------------------------------------------------------------------

/** Request timeout for the HTTP provider call — a hung upstream must never stall explanation generation. */
const LLM_REQUEST_TIMEOUT_MS = 20_000;

/** At most one retry on a 5xx response or network error — bounded, never an infinite/backoff loop. */
const LLM_MAX_ATTEMPTS = 2;

/** Guard against an oversized/malicious response body before it is even JSON-parsed. */
const LLM_MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Output string length caps applied to a raw provider response BEFORE it is
 * handed back to the caller — belt-and-suspenders on top of
 * run_explanations.ts's own truncateToBytes calls on the final stored value.
 * A misbehaving/compromised provider returning e.g. a 100 KB "summary" must
 * not be carried around in memory/logs any longer than necessary.
 */
const LLM_MAX_FIELD_CHARS = 8 * 1024;

/** Cap on how many citedSeqNums we bother carrying out of the provider response — validateCitedSeqNums caps further, this just bounds a pathological array (e.g. 500 fake entries) before that. */
const LLM_MAX_RAW_CITED_SEQ_NUMS = 100;

function clampString(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

/** Rejects/resolves with `undefined` after `ms` — paired with Promise.race, never leaves a dangling timer that matters (test/process teardown is fine since this is a one-shot generation action). */
function timeoutAfter(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

/**
 * Defensively extracts `{summary, rootCause, suggestedFix, citedSeqNums}` from
 * an arbitrary parsed JSON value. Tolerates: prose wrapped around a JSON
 * object (extracts the first balanced `{...}` substring), missing fields,
 * extra/unknown fields, wrong types on individual fields (drops them rather
 * than failing the whole parse). Returns `undefined` only if no usable
 * summary+rootCause pair can be recovered at all.
 */
export function parseExplanationLLMResponse(raw: unknown): ExplanationLLMResult | undefined {
  let body: unknown = raw;

  // Tolerate the provider returning the JSON as a bare string (possibly with
  // surrounding prose) instead of an already-parsed object.
  if (typeof body === "string") {
    const extracted = extractFirstJsonObject(body);
    if (extracted === undefined) return undefined;
    body = extracted;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;

  const summaryRaw = typeof b["summary"] === "string" ? b["summary"] : undefined;
  const rootCauseRaw = typeof b["rootCause"] === "string" ? b["rootCause"] : undefined;
  if (!summaryRaw || !rootCauseRaw || summaryRaw.trim().length === 0 || rootCauseRaw.trim().length === 0) {
    return undefined;
  }

  const summary = clampString(summaryRaw, LLM_MAX_FIELD_CHARS);
  const rootCause = clampString(rootCauseRaw, LLM_MAX_FIELD_CHARS);

  const suggestedFixRaw = typeof b["suggestedFix"] === "string" ? b["suggestedFix"] : undefined;
  const suggestedFix = suggestedFixRaw !== undefined ? clampString(suggestedFixRaw, LLM_MAX_FIELD_CHARS) : undefined;

  const citedSeqNumsRaw = Array.isArray(b["citedSeqNums"]) ? b["citedSeqNums"] : [];
  const citedSeqNums = citedSeqNumsRaw
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    .slice(0, LLM_MAX_RAW_CITED_SEQ_NUMS);

  return { summary, rootCause, suggestedFix, citedSeqNums };
}

/**
 * Best-effort extraction of the first balanced `{...}` substring from a
 * string that may contain prose around a JSON object (e.g. "Sure, here you
 * go: { ... } Hope that helps!"). Returns the parsed object, or `undefined`
 * if no valid JSON object could be found/parsed. Never throws.
 */
function extractFirstJsonObject(s: string): unknown {
  const start = s.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Default provider: never calls out anywhere, always reports "no result".
 * Used when `AFR_LLM_PROVIDER` is unset — the deterministic heuristic
 * explanation remains fully functional with zero external configuration,
 * matching ADR-004's requirement that LLM generation is opt-in and the
 * heuristic fallback is always available.
 */
export class NoopExplanationLLM implements ExplanationLLM {
  explain(_input: GroundedExplanationPrompt): Promise<ExplanationLLMResult | undefined> {
    return Promise.resolve(undefined);
  }
}

/**
 * Generic HTTP-POST provider SHAPE: reads its target endpoint from
 * `AFR_LLM_ENDPOINT` (and an optional bearer token from `AFR_LLM_API_KEY`),
 * POSTs `{ prompt }`, and expects a JSON body matching
 * `ExplanationLLMResult`. Deliberately vendor-agnostic — no Anthropic/OpenAI/
 * etc.-specific request or response shape is assumed. `explain` never
 * throws: any network error, non-2xx response, or malformed body is reported
 * as `undefined` so the caller can fall back to the heuristic explanation
 * without special-casing provider failures.
 */
export class HttpExplanationLLM implements ExplanationLLM {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey?: string,
  ) {}

  /**
   * One attempt at the HTTP call, race'd against a hard timeout so a hung
   * upstream can never stall explanation generation. Returns the TIMEOUT
   * sentinel on timeout, `undefined` on any request/response-level failure
   * that should NOT be retried (non-5xx failure, bad body), and `{ retry:
   * true }` for a failure this caller should retry once (5xx / network
   * error / timeout).
   */
  private async attempt(
    input: GroundedExplanationPrompt,
  ): Promise<{ ok: true; result: ExplanationLLMResult } | { ok: false; retryable: boolean }> {
    const controller = new AbortController();
    const hardTimeout = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

    try {
      const racedResult = await Promise.race([
        fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ prompt: input.prompt }),
          signal: controller.signal,
        }).then((res) => ({ kind: "response" as const, res })),
        timeoutAfter(LLM_REQUEST_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
      ]);

      if (racedResult.kind === "timeout") {
        return { ok: false, retryable: true };
      }

      const res = racedResult.res;
      if (!res.ok) {
        // Retry only on 5xx (transient upstream failure); a 4xx is our own
        // request being wrong and retrying it would just repeat the failure.
        return { ok: false, retryable: res.status >= 500 };
      }

      const text = await res.text();
      if (new TextEncoder().encode(text).length > LLM_MAX_RESPONSE_BYTES) {
        // Oversized response — do not attempt to JSON.parse an arbitrarily
        // large payload; treat as a bad (non-retryable) response.
        return { ok: false, retryable: false };
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(text);
      } catch {
        // Tolerate prose-wrapped JSON via the defensive extractor.
        parsedBody = text;
      }

      const parsed = parseExplanationLLMResponse(parsedBody);
      if (!parsed) return { ok: false, retryable: false };
      return { ok: true, result: parsed };
    } catch {
      // Network error, DNS failure, or AbortError from our own timeout.
      return { ok: false, retryable: true };
    } finally {
      clearTimeout(hardTimeout);
    }
  }

  async explain(input: GroundedExplanationPrompt): Promise<ExplanationLLMResult | undefined> {
    const startedAt = Date.now();
    try {
      for (let attemptNum = 1; attemptNum <= LLM_MAX_ATTEMPTS; attemptNum++) {
        const outcome = await this.attempt(input);
        if (outcome.ok) {
          return { ...outcome.result, generationMs: Date.now() - startedAt };
        }
        if (!outcome.retryable || attemptNum === LLM_MAX_ATTEMPTS) {
          return undefined;
        }
        // Single bounded retry — no backoff loop, no unbounded retries.
      }
      return undefined;
    } catch {
      // Never throw out of the provider — any unexpected failure degrades to
      // "no result" so the caller falls back to the heuristic explanation.
      return undefined;
    }
  }
}

/**
 * The single factory every call site uses. Reads `AFR_LLM_PROVIDER`
 * ("http" -> HttpExplanationLLM; unset/anything else -> Noop). NEVER throws:
 * `AFR_LLM_PROVIDER=http` with no `AFR_LLM_ENDPOINT` configured falls back to
 * the noop provider (heuristic-only), rather than failing explanation
 * generation.
 */
export function getConfiguredExplanationLLM(): ExplanationLLM {
  const provider = process.env["AFR_LLM_PROVIDER"];
  if (provider === "http") {
    const endpoint = process.env["AFR_LLM_ENDPOINT"];
    if (endpoint) {
      const apiKey = process.env["AFR_LLM_API_KEY"];
      return new HttpExplanationLLM(endpoint, apiKey);
    }
    console.warn(
      "AFR_LLM_PROVIDER=http but AFR_LLM_ENDPOINT is unset; falling back to the deterministic heuristic only.",
    );
  }
  return new NoopExplanationLLM();
}
