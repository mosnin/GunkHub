/**
 * Body validation for the two PRIVILEGED budget mutations
 * (`POST /api/v1/budgets/trip`, `POST /api/v1/budgets/reset`) and their
 * Clerk-authed management twins.
 *
 * Dependency-free — no `next/server`, no Clerk, no Convex — so it is unit
 * testable without a Next.js runtime, the same rationale as
 * `lib/apiKeyScopes.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY `reason` IS REQUIRED HERE EVEN THOUGH CONVEX ACCEPTS IT AS OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * `ManualTripRequest.reason` and `ManualResetRequest.reason` are REQUIRED in
 * the contract, and the reason they are is specific: a manual trip has no meter
 * reading behind it and a reset DISCARDS evidence from an accounting window.
 * Neither act can be justified by arithmetic afterwards, so the audit entry's
 * only content is the sentence a human wrote. An empty one is not a shorter
 * justification, it is the absence of one.
 *
 * The Convex validator types `note` as optional because it also serves callers
 * that never had a reason to give. This boundary is the one the contract
 * describes, so this boundary enforces the contract — REJECT, NEVER DEFAULT. A
 * defaulted "no reason given" would write a plausible-looking audit row that
 * nobody chose, which is worse than a 400.
 *
 * REJECT, NEVER COERCE, applies to the whitespace case too: `"   "` is not a
 * reason. It is trimmed for the length check and forwarded TRIMMED, so what the
 * audit log stores is what a reader will see.
 */

/** A validated privileged-mutation body. Field names match the contract's request types. */
export interface BudgetMutationBody {
  budgetId: string
  reason: string
}

export type BudgetMutationBodyParse =
  | { ok: true; body: BudgetMutationBody }
  /**
   * `message` is STATIC ROUTE COPY naming the field and what it expects — never
   * anything derived from the input, which would make this response an echo
   * surface.
   */
  | { ok: false; message: string }

/** The longest reason accepted. Bounded because it lands in an append-only log that is never edited. */
export const MAX_BUDGET_REASON_LENGTH = 1_000

/**
 * Parse a trip/reset request body.
 *
 * @param raw - anything at all, including a non-object. `ok: false` is a valid answer.
 * @returns the validated body, or a static message naming the offending field. Never throws.
 */
export function parseBudgetMutationBody(raw: unknown): BudgetMutationBodyParse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'body must be a JSON object with budgetId and reason' }
  }
  const body = raw as Record<string, unknown>

  const budgetId = body['budgetId']
  if (typeof budgetId !== 'string' || budgetId.length === 0) {
    return { ok: false, message: 'budgetId is required and must be a non-empty string' }
  }

  const reason = body['reason']
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return {
      ok: false,
      message:
        'reason is required and must be a non-empty string; it is written to the append-only admin audit log and ' +
        'is the only account of why this was done by hand',
    }
  }
  const trimmed = reason.trim()
  if (trimmed.length > MAX_BUDGET_REASON_LENGTH) {
    return { ok: false, message: `reason must be at most ${MAX_BUDGET_REASON_LENGTH} characters` }
  }

  return { ok: true, body: { budgetId, reason: trimmed } }
}
