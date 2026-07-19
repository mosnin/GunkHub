/**
 * LLM cost model — SNAPSHOT pricing table + fuzzy model matcher.
 *
 * Pure, schema-independent module (no `ctx`, no Convex imports). Owned by
 * Team B (Insight Engine). Consumed at QUERY TIME only — cost is never
 * stored on a run or event (CLAUDE.md: "Do not denormalize event data into
 * the runs table" — the same reasoning applies to derived cost: pricing
 * changes over time and a stored dollar figure would silently go stale).
 *
 * ---------------------------------------------------------------------
 * IMPORTANT — THIS IS SNAPSHOT PRICING, NOT LIVE PRICING.
 * ---------------------------------------------------------------------
 * The table below reflects each provider's public per-1M-token pricing as
 * best known as of PRICING_LAST_UPDATED. Providers change prices without
 * notice. Operators running this in production SHOULD override this table
 * (e.g. via an env-configured JSON blob merged over PRICING_TABLE, or by
 * forking this file) rather than trusting it blindly for billing-adjacent
 * decisions. Nothing in this codebase treats these numbers as authoritative
 * for invoicing — they exist to give engineers a *directional* sense of
 * run cost while debugging.
 */

/** Bump this whenever the PRICING_TABLE contents below are revised. */
export const PRICING_LAST_UPDATED = "2026-01-15";

export interface ModelPricing {
  /** Canonical key this entry is stored/reported under. */
  key: string;
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
}

export interface CostEstimate {
  costUsd: number;
  /** False when the model string could not be resolved to a known entry — cost is 0, never guessed. */
  matched: boolean;
  /** The PRICING_TABLE key that was matched, or undefined when matched is false. */
  pricingKey?: string;
}

/**
 * SNAPSHOT pricing table, keyed by a normalized canonical model id.
 * All values are USD per 1,000,000 tokens. See PRICING_LAST_UPDATED.
 *
 * Sources (directional, not contractual): provider list-price pages as
 * commonly cited in early-2026 developer docs. DO NOT treat as exact.
 */
export const PRICING_TABLE: Record<string, ModelPricing> = {
  // ---- Anthropic: Claude ----
  "claude-opus-4-5": { key: "claude-opus-4-5", inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-1": { key: "claude-opus-4-1", inputPerMillion: 15, outputPerMillion: 75 },
  "claude-opus-4": { key: "claude-opus-4", inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4-5": { key: "claude-sonnet-4-5", inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4": { key: "claude-sonnet-4", inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-7-sonnet": { key: "claude-3-7-sonnet", inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-sonnet": { key: "claude-3-5-sonnet", inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { key: "claude-haiku-4-5", inputPerMillion: 1, outputPerMillion: 5 },
  "claude-3-5-haiku": { key: "claude-3-5-haiku", inputPerMillion: 0.8, outputPerMillion: 4 },
  "claude-3-haiku": { key: "claude-3-haiku", inputPerMillion: 0.25, outputPerMillion: 1.25 },
  "claude-3-opus": { key: "claude-3-opus", inputPerMillion: 15, outputPerMillion: 75 },

  // ---- OpenAI: GPT / o-series ----
  "gpt-4o": { key: "gpt-4o", inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { key: "gpt-4o-mini", inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4.1": { key: "gpt-4.1", inputPerMillion: 2, outputPerMillion: 8 },
  "gpt-4.1-mini": { key: "gpt-4.1-mini", inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { key: "gpt-4.1-nano", inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gpt-5": { key: "gpt-5", inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5-mini": { key: "gpt-5-mini", inputPerMillion: 0.25, outputPerMillion: 2 },
  "o1": { key: "o1", inputPerMillion: 15, outputPerMillion: 60 },
  "o1-mini": { key: "o1-mini", inputPerMillion: 1.1, outputPerMillion: 4.4 },
  "o3": { key: "o3", inputPerMillion: 2, outputPerMillion: 8 },
  "o3-mini": { key: "o3-mini", inputPerMillion: 1.1, outputPerMillion: 4.4 },
  "o4-mini": { key: "o4-mini", inputPerMillion: 1.1, outputPerMillion: 4.4 },

  // ---- Google: Gemini ----
  "gemini-1.5-pro": { key: "gemini-1.5-pro", inputPerMillion: 1.25, outputPerMillion: 5 },
  "gemini-1.5-flash": { key: "gemini-1.5-flash", inputPerMillion: 0.075, outputPerMillion: 0.3 },
  "gemini-2.0-flash": { key: "gemini-2.0-flash", inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gemini-2.0-flash-lite": { key: "gemini-2.0-flash-lite", inputPerMillion: 0.075, outputPerMillion: 0.3 },
  "gemini-2.5-pro": { key: "gemini-2.5-pro", inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.5-flash": { key: "gemini-2.5-flash", inputPerMillion: 0.3, outputPerMillion: 2.5 },
};

/**
 * Longest-key-first ordering used by the fuzzy matcher so e.g.
 * "claude-3-5-sonnet" is preferred over the shorter "claude-3" when both
 * would otherwise match as substrings.
 */
const SORTED_KEYS: string[] = Object.keys(PRICING_TABLE).sort((a, b) => b.length - a.length);

/**
 * Normalize a raw model string for matching:
 * - lowercase
 * - strip provider prefixes ("anthropic/", "openai/", "google/", "models/", "vertex_ai/")
 * - strip date suffixes like "-20250219" or "@20250219"
 * - collapse whitespace/underscores to hyphens
 */
function normalizeModelString(raw: string): string {
  let s = raw.trim().toLowerCase();
  // Strip a single leading "provider/" or "provider:" segment.
  s = s.replace(/^(anthropic|openai|google|vertex_ai|vertexai|models|bedrock|azure)[/:]/, "");
  // Strip trailing date-stamp suffixes: -YYYYMMDD or @YYYYMMDD
  s = s.replace(/[-@]\d{8}$/, "");
  // Strip trailing "-latest" / "-preview" / "-exp" version noise (kept last, after date strip).
  s = s.replace(/-(latest|preview|exp|stable)$/, "");
  s = s.replace(/[\s_]+/g, "-");
  return s;
}

/**
 * Resolve a free-form model string (as recorded in an `llm.request` /
 * `llm.response` event payload) to a known pricing entry.
 *
 * Matching strategy, in order:
 * 1. Exact match against a normalized PRICING_TABLE key.
 * 2. Longest-key substring match (normalized model string contains a known key,
 *    or a known key contains the normalized model string) — handles versioned
 *    fallbacks like "claude-3-5-sonnet-v2" or "gpt-4o-2024-11-20" (post date-strip).
 * 3. No match -> undefined. We never guess a nearest neighbor silently.
 */
export function resolveModelPricing(modelString: string): ModelPricing | undefined {
  if (!modelString || typeof modelString !== "string") return undefined;
  const normalized = normalizeModelString(modelString);
  if (!normalized) return undefined;

  const exact = PRICING_TABLE[normalized];
  if (exact) return exact;

  for (const key of SORTED_KEYS) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return PRICING_TABLE[key];
    }
  }

  return undefined;
}

/**
 * Estimate the USD cost of an LLM call. Unknown models return
 * `{ costUsd: 0, matched: false }` — cost is never guessed for an
 * unrecognized model string.
 */
export function estimateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
): CostEstimate {
  const pricing = resolveModelPricing(model);
  if (!pricing) {
    return { costUsd: 0, matched: false };
  }

  const safeIn = Number.isFinite(tokensIn) && tokensIn > 0 ? tokensIn : 0;
  const safeOut = Number.isFinite(tokensOut) && tokensOut > 0 ? tokensOut : 0;

  const costUsd =
    (safeIn / 1_000_000) * pricing.inputPerMillion +
    (safeOut / 1_000_000) * pricing.outputPerMillion;

  return { costUsd, matched: true, pricingKey: pricing.key };
}
