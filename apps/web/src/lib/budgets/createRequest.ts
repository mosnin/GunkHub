/**
 * Body validation for `POST /api/budgets` (create a budget definition).
 *
 * Dependency-free so it is unit testable without a Next.js runtime — same
 * rationale as `lib/budgets/mutationRequest.ts` and `lib/apiKeyScopes.ts`.
 *
 * THE VOCABULARIES ARE BUILT FROM THE CONTRACT'S RUNTIME ARRAYS
 * (`BUDGET_SCOPES` / `BUDGET_METERS` / `BUDGET_PERIODS`), never retyped as
 * local string unions. Contracts is the authority on the spelling (CLAUDE.md
 * Repo Conventions -> Types); a locally respelled member is a second source of
 * truth, and the failure it produces is a value this layer accepts and the
 * Convex validator rejects — a 500 at the far end of a form submission.
 *
 * `limitAmount` IS CHECKED AS AN INTEGER, and the check is not pedantry. Cost
 * meters count the currency's smallest unit, never a decimal, because
 * floating-point money is how a limit of 100.00 is compared against a spend of
 * 100.00000000000001 — or, in the direction that costs money, how
 * 99.99999999999999 reads as under.
 */
import {
  BUDGET_METERS,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  type BudgetMeter,
  type BudgetPeriod,
  type BudgetScope,
} from '@agent-flight-recorder/contracts'

export interface CreateBudgetBody {
  name: string
  scope: BudgetScope
  scopeId: string
  meter: BudgetMeter
  period: BudgetPeriod
  limitAmount: number
  currency?: string
  rearmOnPeriodRoll?: boolean
  enabled?: boolean
}

export type CreateBudgetBodyParse =
  | { ok: true; body: CreateBudgetBody }
  /** Static route copy naming the offending field — never derived from the input. */
  | { ok: false; message: string }

/** Longest accepted budget name. Bounded so a name cannot be used as a payload. */
export const MAX_BUDGET_NAME_LENGTH = 120

function isMember<T extends string>(vocabulary: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (vocabulary as readonly string[]).includes(value)
}

/**
 * Parse a create-budget request body.
 *
 * @param raw - anything at all. `ok: false` is a valid answer.
 * @returns the validated body, or a static message. Never throws.
 */
export function parseCreateBudgetBody(raw: unknown): CreateBudgetBodyParse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const body = raw as Record<string, unknown>

  const name = body['name']
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'name is required and must be a non-empty string' }
  }
  if (name.trim().length > MAX_BUDGET_NAME_LENGTH) {
    return { ok: false, message: `name must be at most ${MAX_BUDGET_NAME_LENGTH} characters` }
  }

  const scope = body['scope']
  if (!isMember(BUDGET_SCOPES, scope)) {
    return { ok: false, message: `scope must be one of: ${BUDGET_SCOPES.join(', ')}` }
  }

  const scopeId = body['scopeId']
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    return {
      ok: false,
      message:
        'scopeId is required and must be a non-empty string: the id of the entity this budget governs (for an ' +
        "org-scoped budget, the organization's own id)",
    }
  }

  const meter = body['meter']
  if (!isMember(BUDGET_METERS, meter)) {
    return { ok: false, message: `meter must be one of: ${BUDGET_METERS.join(', ')}` }
  }

  const period = body['period']
  if (!isMember(BUDGET_PERIODS, period)) {
    return { ok: false, message: `period must be one of: ${BUDGET_PERIODS.join(', ')}` }
  }

  const limitAmount = body['limitAmount']
  if (typeof limitAmount !== 'number' || !Number.isInteger(limitAmount) || limitAmount <= 0) {
    return {
      ok: false,
      message:
        'limitAmount must be a positive integer in the meter\'s own unit — the currency\'s smallest unit for a ' +
        'cost meter, never a decimal',
    }
  }

  const currency = body['currency']
  if (currency !== undefined && (typeof currency !== 'string' || currency.length !== 3)) {
    return { ok: false, message: 'currency, when supplied, must be a 3-letter ISO 4217 code' }
  }

  const rearm = body['rearmOnPeriodRoll']
  if (rearm !== undefined && typeof rearm !== 'boolean') {
    return { ok: false, message: 'rearmOnPeriodRoll, when supplied, must be a boolean' }
  }

  const enabled = body['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return { ok: false, message: 'enabled, when supplied, must be a boolean' }
  }

  return {
    ok: true,
    body: {
      name: name.trim(),
      scope,
      scopeId,
      meter,
      period,
      limitAmount,
      ...(currency !== undefined && { currency }),
      ...(rearm !== undefined && { rearmOnPeriodRoll: rearm }),
      ...(enabled !== undefined && { enabled }),
    },
  }
}
