/**
 * serviceResult.ts — the "why is there nothing here" contract.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO MAKE IMPOSSIBLE
 * ---------------------------------------------------------------------------
 *
 * Several services in this directory used to do:
 *
 *     try { ...convex query... } catch { return { available: false } }
 *
 * That collapses two facts that are not the same fact:
 *
 *   (a) the query SUCCEEDED and there is genuinely no data yet, and
 *   (b) the query THREW and we know nothing at all.
 *
 * The UI then rendered the same calm, reassuring empty copy for both —
 * "This fills in once evals have been recorded", "No recurring failures —
 * nice". On a tool whose stated primary outcome is "make failures
 * explainable" (CLAUDE.md), telling an engineer that everything is fine
 * because the backend blew up is close to the worst available failure mode.
 * It is also self-concealing: the more the backend breaks, the calmer the
 * product looks.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DISCRIMINANT IS `status`, NOT `available`
 * ---------------------------------------------------------------------------
 *
 * The obvious minimal fix is to keep `available: false` and bolt a `reason`
 * field onto it. That fix does not work, and it is worth writing down why so
 * nobody "simplifies" it back.
 *
 * A required field on the failure branch only breaks code that CONSTRUCTS the
 * value. Every render site in components/ reads it:
 *
 *     {!stats.available ? <EmptyState .../> : <RealThing />}
 *
 * That expression keeps compiling no matter what fields the false branch
 * gains. The reassuring copy survives, silently, which is precisely the bug.
 * TypeScript cannot force a consumer to READ a field — but it can delete the
 * field the consumer is currently reading. So the boolean is gone and the
 * discriminant is a three-way `status`:
 *
 *     'ok'    — query succeeded, data is present and real
 *     'empty' — query succeeded, there is genuinely nothing recorded yet
 *     'error' — query failed; we do not know whether data exists
 *
 * Every existing `x.available` read is now a compile error, which forces each
 * render site to decide what 'error' should look like instead of inheriting
 * the empty-state copy by default. That break is the feature.
 *
 * ---------------------------------------------------------------------------
 * MESSAGES ARE SAFE BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 *
 * `message` is user-facing and is NEVER derived from a caught exception. It is
 * assembled from a static, caller-supplied noun phrase plus a fixed template
 * in this module. The caught error goes to `logger` (the existing structured
 * logger in `@/lib/logger`, already the convention in this app's API routes —
 * no new dependency is introduced) and nowhere else.
 *
 * This matters beyond tidiness. Convex error prose can carry document IDs,
 * argument values, and function paths. This codebase deliberately keeps a
 * cross-org lookup indistinguishable from a missing record (CLAUDE.md,
 * Tenancy Rules #3); echoing a backend message into the UI would hand an
 * attacker exactly the oracle that design removes. So: no stacks, no Convex
 * prose, no IDs, no interpolated `err.message`. Ever.
 */

import { logger } from '@/lib/logger'

/**
 * Why a service has no data to show.
 *
 * These are not interchangeable and must never be rendered with the same
 * copy. 'empty' is a fact about the world. 'error' is an absence of facts.
 */
export type UnavailableReason = 'empty' | 'error'

/** The non-success branch of every service result in this directory. */
export interface ServiceUnavailable {
  status: UnavailableReason
  /**
   * Safe to render directly to a user. Contains no stack, no Convex internal
   * message, no identifiers, and nothing derived from a caught exception.
   */
  message: string
}

/**
 * A service result that is either usable data (`status: 'ok'` plus `T`'s
 * fields) or an explained absence.
 *
 * Consumers narrow on `status`. Note that `status !== 'ok'` narrows to
 * `ServiceUnavailable`, whose `status` is still `'empty' | 'error'` — so a
 * render site that wants to keep its empty-state copy has to say so out loud.
 */
export type ServiceResult<T> = ({ status: 'ok' } & T) | ServiceUnavailable

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * The query succeeded and there is genuinely nothing recorded yet.
 *
 * Only use this when a call actually completed. If you are in a `catch`, you
 * do not know this and must use `unavailableError` instead.
 *
 * @param message Honest empty-state copy for this specific view.
 */
export function unavailableEmpty(message: string): ServiceUnavailable {
  return { status: 'empty', message }
}

/**
 * We could not determine whether data exists. Logs the underlying error and
 * returns a message that is safe to show a user.
 *
 * @param subject  Static noun phrase for what failed to load, e.g.
 *                 'cost stats'. Must be a literal in service code — never
 *                 anything derived from an exception or from user input.
 * @param err      The caught error. Goes to the log only.
 * @param context  Extra structured log fields (service name, range, ...).
 *                 Do not put anything here that also reaches the UI.
 */
export function unavailableError(
  subject: string,
  err: unknown,
  context: Record<string, unknown> = {},
): ServiceUnavailable {
  logger.error(`service: failed to load ${subject}`, { ...context, err })
  return {
    status: 'error',
    message: `Could not load ${subject}. The query failed, so this is not a statement that there is no data — retry, and check backend status if it persists.`,
  }
}

/**
 * No Clerk organization is active on this request. Not an empty state: with no
 * org resolved we have not asked the question, so we cannot answer it.
 */
export function unavailableNoOrg(subject: string): ServiceUnavailable {
  return {
    status: 'error',
    message: `Could not load ${subject}: no active organization on this session. Select an organization and retry.`,
  }
}

/**
 * A Clerk org is active but has no corresponding Convex organization record —
 * a provisioning gap, not an empty dataset. Deliberately says nothing about
 * which org was looked up.
 */
export function unavailableOrgUnresolved(subject: string): ServiceUnavailable {
  logger.error(`service: org record unresolved while loading ${subject}`, { subject })
  return {
    status: 'error',
    message: `Could not load ${subject}: this workspace is not fully provisioned yet. If this persists, contact your administrator.`,
  }
}

// ---------------------------------------------------------------------------
// Collection-shaped results
// ---------------------------------------------------------------------------
//
// The same defect appears in services that return a bare `T[]` or
// `Record<string, T>` and do `catch { return [] }` / `catch { return {} }`.
// An empty collection is then indistinguishable from a failed fetch, and the
// caller renders "nothing to report" over an exception. On the verification
// widget this is the worst version of the bug in the codebase: a thrown query
// renders as a clean bill of health on the event log's integrity.
//
// WHY THESE REUSE `ServiceResult` RATHER THAN GETTING THEIR OWN TYPE.
// A parallel `ListResult<T>` was the obvious alternative and is worse:
//
//   1. The distinction being drawn is IDENTICAL — "there is genuinely nothing"
//      versus "I could not find out". A second type for the same semantics
//      means two vocabularies for one idea, and a reader has to learn which
//      services speak which.
//   2. `isOk` / `isEmpty` / `isError` and all four safe-message constructors
//      keep working unchanged. A separate type would need its own copies, and
//      copies drift.
//   3. Consumers are already absorbing this discriminant for the scalar
//      services. Making lists behave the same way costs them nothing new.
//
// The one accommodation lists genuinely need is a NAMED payload key. Writing
// `ServiceResult<T[]>` would intersect `{ status: 'ok' }` with an array type,
// which is legal but produces an awkward array-with-extra-properties that
// destructures badly and confuses `.map`. So collection services return their
// rows under an explicit key (`items`, `rows`, `statuses`) and the caller
// reaches through `status === 'ok'` first.

/** Convenience alias for services whose payload is a list under `items`. */
export type ServiceListResult<T> = ServiceResult<{ items: T[] }>

/**
 * Build a list result from a SUCCESSFUL fetch, mapping a genuinely empty
 * collection to `status: 'empty'` and a non-empty one to `status: 'ok'`.
 *
 * Only call this on a value you actually received. The whole point of the
 * empty/error split is that an empty array reached from a `catch` is not an
 * empty collection, it is an unknown one.
 *
 * @param emptyMessage Honest copy for the genuinely-nothing case.
 */
export function okList<T>(items: T[], emptyMessage: string): ServiceListResult<T> {
  if (items.length === 0) return unavailableEmpty(emptyMessage)
  return { status: 'ok', items }
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

/** True when the result carries real data. */
export function isOk<T>(r: ServiceResult<T>): r is { status: 'ok' } & T {
  return r.status === 'ok'
}

/**
 * True when we genuinely know there is no data.
 *
 * Use this — not `!isOk(...)` — to guard reassuring empty-state copy. The
 * whole point of this module is that `!isOk` is not a licence to say
 * "nothing here yet".
 */
export function isEmpty<T>(r: ServiceResult<T>): r is ServiceUnavailable & { status: 'empty' } {
  return r.status === 'empty'
}

/** True when the load failed and the absence of data is unexplained. */
export function isError<T>(r: ServiceResult<T>): r is ServiceUnavailable & { status: 'error' } {
  return r.status === 'error'
}
