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
}

export interface ExplanationLLM {
  /** Returns `undefined` if the provider could not produce a result (network error, bad response, not configured). Never throws. */
  explain(input: GroundedExplanationPrompt): Promise<ExplanationLLMResult | undefined>;
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

  async explain(input: GroundedExplanationPrompt): Promise<ExplanationLLMResult | undefined> {
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ prompt: input.prompt }),
      });
      if (!res.ok) return undefined;

      const body: unknown = await res.json();
      if (!body || typeof body !== "object") return undefined;
      const b = body as Record<string, unknown>;

      const summary = typeof b["summary"] === "string" ? b["summary"] : undefined;
      const rootCause = typeof b["rootCause"] === "string" ? b["rootCause"] : undefined;
      if (!summary || !rootCause) return undefined;

      const suggestedFix = typeof b["suggestedFix"] === "string" ? b["suggestedFix"] : undefined;
      const citedSeqNums = Array.isArray(b["citedSeqNums"])
        ? b["citedSeqNums"].filter((n): n is number => typeof n === "number")
        : [];

      return { summary, rootCause, suggestedFix, citedSeqNums };
    } catch {
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
