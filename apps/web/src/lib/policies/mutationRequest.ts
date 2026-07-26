/**
 * lib/policies/mutationRequest.ts — parsing the two PRIVILEGED policy write
 * bodies.
 *
 * ===========================================================================
 * THERE IS ONE VOCABULARY, AND IT IS CONTRACTS'. THIS MODULE VALIDATES; IT DOES
 * NOT TRANSLATE.
 * ===========================================================================
 *
 * An earlier draft of this module projected the contracts `PolicyRule` /
 * `PolicySubject` onto a flat `{scope, scopeId, prohibits, matcher}` row, on the
 * stated premise that "convex/schema.ts stores ONE REQUIRED matcher value". THAT
 * PREMISE WAS FALSE. `convex/schema.ts`'s `policies` table stores `rule` and
 * `subject` in exactly the contracts shape — the same nested unions, with the
 * same OPTIONAL arrays — and `convex/policies.ts`'s `createPolicy` /
 * `updatePolicy` accept exactly `{ name, rule, subject, rationale, enabled }`.
 * The projection targeted a backend that does not exist.
 *
 * It was not a harmless mistranslation. To honour the invented constraint the
 * projection REFUSED, with a 400, the two rule forms the real schema most wants:
 *
 *   `{ kind: "tool_denied" }` — an ABSENT list, which the schema's own header
 *       calls load-bearing: it is the ONE form under which an externalized
 *       payload still proves a violation, because the event TYPE survives
 *       externalization while the tool name does not. Contracts'
 *       `ruleIsDecidableFromEventTypeAlone` is true for this form and no other.
 *       The projection rejected it as "strictly wider than any policy row this
 *       backend can store", which is precisely backwards.
 *
 *   `{ deniedTools: ["a", "b"] }` — a multi-value list, stored natively by
 *       `v.array(v.string())`. The projection made operators write one policy
 *       per forbidden tool to satisfy a limit nothing imposed.
 *
 * So the projection is gone rather than corrected: a translation layer between
 * two identical vocabularies has no correct version, and this one spent its
 * existence refusing valid policy.
 *
 * WHAT SURVIVES, AND WHY. The empty list is still refused — `[]` is the one form
 * the schema itself calls a misconfiguration, forbidding nothing forever while
 * appearing in the policy list as a control in force, and it is refused here AND
 * re-checked at evaluation time. That refusal was always right; only its stated
 * reason was wrong. It is a misconfiguration, not an unstorable shape.
 *
 * ===========================================================================
 * THE FORBIDDEN-FIELD SWEEP RUNS ON THE WAY IN, NOT ONLY ON THE WAY OUT
 * ===========================================================================
 *
 * `FORBIDDEN_POLICY_WIRE_FIELDS` is normally read as a check on RESPONSES. It is
 * applied here to REQUESTS as well, and the suppression list is the reason:
 * `suppressViolation` planted on a policy DEFINITION is the worst possible place
 * for it, because the row outlives the request and every later evaluation reads
 * it. Contracts gives a policy no way to say "and then drop the event" — this is
 * the door being kept shut at the one layer that writes.
 */
import {
  FORBIDDEN_POLICY_WIRE_FIELDS,
  complianceClaimIn,
  type DisablePolicyRequest,
  type PolicyRule,
  type PolicySubject,
  type UpsertPolicyRequest,
} from '@agent-flight-recorder/contracts'

/** The longest a rationale may be. Mirrors `convex/helpers/policy.ts`'s ceiling. */
export const MAX_POLICY_RATIONALE_LENGTH = 1_024
/** The longest a matcher value may be. Mirrors `convex/helpers/policy.ts`'s ceiling. */
export const MAX_MATCHER_VALUE_LENGTH = 512

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Every forbidden field name anywhere in the body, and every compliance claim in
 * any string in it.
 *
 * TOTAL OVER THE BODY rather than over the fields somebody listed — the same
 * posture as contracts' own walk, for the same reason: coverage that is a
 * property of the traversal is covered the day a new nested field is added.
 * BOUNDED AND CYCLE-SAFE, and it ANNOUNCES its own ceiling rather than going
 * quiet, because a claim planted below a silent bound produces zero findings and
 * reads exactly like a clean body.
 */
export function forbiddenContentInRequest(body: unknown): string[] {
  const found: string[] = []
  const seen = new Set<object>()
  let visited = 0

  const walk = (node: unknown, path: string, depth: number): void => {
    if (visited >= 5_000 || depth > 16) {
      found.push(`${path}: the request was too large or too deeply nested to check for forbidden fields`)
      return
    }
    if (typeof node === 'string') {
      const claim = complianceClaimIn(node)
      if (claim !== null) {
        found.push(
          `${path}: contains the compliance claim "${claim}". A policy definition's prose is quoted verbatim into ` +
            `every outcome it produces, so a compliance word written here becomes an attestation on a screen.`,
        )
      }
      return
    }
    if (node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    visited += 1
    if (Array.isArray(node)) {
      for (const [i, el] of node.entries()) walk(el, `${path}[${i}]`, depth + 1)
      return
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (FORBIDDEN_POLICY_WIRE_FIELDS.includes(key)) {
        found.push(
          `${path}.${key}: this field may not appear on a policy body. A policy states what must not happen; it ` +
            `has no say over whether the event that shows it happened gets recorded, and no way to claim ` +
            `something was prevented or that anything is compliant.`,
        )
      }
      walk((node as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)
    }
  }

  walk(body, '(body)', 0)
  return found
}

// ---------------------------------------------------------------------------
// VALIDATION. The shape that arrives is the shape that is stored.
// ---------------------------------------------------------------------------

/**
 * Validate a contracts `PolicyRule` against what `convex/schema.ts` accepts, and
 * return it UNCHANGED.
 *
 * Returning the input verbatim is the point. The only legitimate job at this
 * boundary is deciding whether untrusted JSON is a rule at all; anything this
 * function could "fix" is a rule the operator did not write.
 *
 * THE ABSENT LIST IS VALID AND IS NOT NORMALISED TO AN EMPTY ONE. `{ kind:
 * "tool_denied" }` means "may not call ANY tool" and is the only rule form
 * decidable from an event type alone. `[]` means the opposite — forbids nothing
 * — and the two are one serialization step apart, which is exactly why the empty
 * list is refused rather than accepted as a synonym for anything.
 */
export function validateRule(rule: PolicyRule): ParseResult<PolicyRule> {
  if (!isRecord(rule)) return { ok: false, message: 'rule must be an object' }

  // ---------------------------------------------------------------------
  // THE DISCRIMINANT IS NARROWED FIRST, AND THE LIST IS READ OFF THE NARROWED
  // ARM. THIS ORDERING IS THE TYPE SAFETY.
  //
  // The obvious spelling — compute `list` with a ternary over `rule.kind` and
  // then check the kind — reads `rule.deniedTools` while `rule` is still the
  // `PolicyRule & Record<string, unknown>` intersection that `isRecord` produced,
  // so the property comes back `any` and every check below it is vouched for by
  // nothing. On a policy surface an `any` is not a style problem: it is how an
  // unvalidated value reaches a stored rule, and a stored rule that does not say
  // what its author thought grades quietly for months.
  //
  // So: reject the unknown kind, then narrow, then read. `kind` is captured off
  // the raw record for the error message only, where it is JSON-stringified and
  // never used as a value.
  // ---------------------------------------------------------------------
  if (rule.kind !== 'tool_denied' && rule.kind !== 'egress_denied') {
    const received: unknown = (rule as { kind?: unknown }).kind ?? null
    return {
      ok: false,
      message: `rule.kind must be one of tool_denied, egress_denied (received ${JSON.stringify(received)})`,
    }
  }
  const field = rule.kind === 'tool_denied' ? 'deniedTools' : 'deniedHosts'
  const list: readonly string[] | undefined =
    rule.kind === 'tool_denied' ? rule.deniedTools : rule.deniedHosts
  // ABSENT IS VALID AND MEANS "DENY THE OPERATION ITSELF". Returned untouched —
  // see this function's header. It is deliberately NOT filled in with a list.
  if (list === undefined) return { ok: true, value: rule }
  // `Array.isArray` IS APPLIED TO AN `unknown` ALIAS, NOT TO `list` ITSELF, and
  // the indirection is load-bearing rather than fussy. Called on a value already
  // typed `readonly string[]`, `Array.isArray` narrows it to `any[]` — so
  // `list[0]` comes back `any`, `isNonEmptyString` is checking a value
  // TypeScript has stopped reasoning about, and the length/element guards below
  // are vouched for by nothing. The runtime check is still needed (this arrives
  // as untrusted JSON and the declared type is a promise, not a fact), so it is
  // performed on the alias and `list` keeps its type.
  const listValue: unknown = list
  if (!Array.isArray(listValue)) return { ok: false, message: `rule.${field} must be an array` }
  if (list.length === 0) {
    return {
      ok: false,
      message:
        `rule.${field} must not be empty. An empty list forbids nothing, forever, while appearing in the policy ` +
        `list as a control in force — a rule that grades every run clean and produces a result byte-identical to ` +
        `one that genuinely checked.`,
    }
  }
  // EVERY element is checked, not just the first. A list is stored whole, so a
  // bad value at index 3 is a bad stored rule; validating only `[0]` is how the
  // rest of the list arrives unvouched-for.
  for (const [i, value] of list.entries()) {
    if (!isNonEmptyString(value)) {
      return { ok: false, message: `rule.${field}[${String(i)}] must be a non-empty string` }
    }
    if (value.length > MAX_MATCHER_VALUE_LENGTH) {
      return {
        ok: false,
        message: `rule.${field}[${String(i)}] must be at most ${String(MAX_MATCHER_VALUE_LENGTH)} characters`,
      }
    }
  }
  return { ok: true, value: rule }
}

/**
 * Validate a contracts `PolicySubject`, and return it UNCHANGED.
 *
 * NOTE WHAT IS NOT HERE: an org id. `{ appliesTo: "org" }` carries no identifier
 * in contracts OR in `convex/schema.ts` — the org a policy belongs to is the
 * `orgId` argument of the mutation, resolved server-side from the caller's
 * credential. An earlier draft took an `orgConvexId` parameter and stamped it
 * into the subject, which gave the key-authed route no honest value to pass and
 * left it handing in a hardcoded placeholder. A tenancy boundary with a
 * decorative parameter is worse than none, because it reads like it was enforced
 * here. It is enforced in `convex/policies.ts`, which checks
 * `requireOrgMembership` against that argument.
 */
export function validateSubject(subject: PolicySubject): ParseResult<PolicySubject> {
  if (!isRecord(subject)) return { ok: false, message: 'subject must be an object' }
  switch (subject.appliesTo) {
    case 'org':
      return { ok: true, value: subject }
    case 'project':
      return isNonEmptyString(subject.projectId)
        ? { ok: true, value: subject }
        : { ok: false, message: 'subject.projectId is required when appliesTo is "project"' }
    case 'agent':
      return isNonEmptyString(subject.agentId)
        ? { ok: true, value: subject }
        : { ok: false, message: 'subject.agentId is required when appliesTo is "agent"' }
    case 'environment':
      return isNonEmptyString(subject.environment)
        ? { ok: true, value: subject }
        : { ok: false, message: 'subject.environment is required when appliesTo is "environment"' }
    default:
      return {
        ok: false,
        message: `subject.appliesTo must be one of org, project, agent, environment (received ${JSON.stringify((subject as { appliesTo?: unknown }).appliesTo ?? null)})`,
      }
  }
}

/**
 * Parse an `UpsertPolicyRequest`.
 *
 * Returns the contracts request and nothing else — there is no second "storage"
 * shape, because `convex/policies.ts` accepts this one. See the module header.
 */
export function parseUpsertPolicyBody(raw: unknown): ParseResult<UpsertPolicyRequest> {
  if (!isRecord(raw)) return { ok: false, message: 'body must be a JSON object' }

  const forbidden = forbiddenContentInRequest(raw)
  if (forbidden.length > 0) return { ok: false, message: forbidden.join('; ') }

  if (!isNonEmptyString(raw['name'])) return { ok: false, message: 'name is required and must be a non-empty string' }
  if (!isNonEmptyString(raw['rationale'])) {
    return {
      ok: false,
      message:
        'rationale is required and must be a non-empty string. It travels into every outcome this policy produces, ' +
        'so a violation on a screen at 3am states its own justification rather than a policy id somebody has to ' +
        'go look up.',
    }
  }
  if ((raw['rationale']).length > MAX_POLICY_RATIONALE_LENGTH) {
    return { ok: false, message: `rationale must be at most ${MAX_POLICY_RATIONALE_LENGTH} characters` }
  }
  if (typeof raw['enabled'] !== 'boolean') {
    return { ok: false, message: 'enabled is required and must be a boolean' }
  }
  if (raw['policyId'] !== undefined && !isNonEmptyString(raw['policyId'])) {
    return { ok: false, message: 'policyId, when supplied, must be a non-empty string' }
  }

  const rule = validateRule(raw['rule'] as PolicyRule)
  if (!rule.ok) return rule
  const subject = validateSubject(raw['subject'] as PolicySubject)
  if (!subject.ok) return subject

  return {
    ok: true,
    value: {
      ...(isNonEmptyString(raw['policyId']) && { policyId: raw['policyId'] }),
      name: raw['name'],
      // The VALIDATED values, not the raw ones. Identical by construction today
      // — both validators return their input — but reading them back off the
      // untrusted record would make that a coincidence rather than a guarantee,
      // and would survive any future validator that did normalise.
      rule: rule.value,
      subject: subject.value,
      rationale: raw['rationale'],
      enabled: raw['enabled'],
    },
  }
}

/**
 * Parse a `DisablePolicyRequest`.
 *
 * `reason` is REQUIRED and never defaulted: it is written to the append-only
 * admin audit log (CLAUDE.md Event Log Rule 6), and a defaulted reason is an
 * audit row that records that somebody disabled a control and not why.
 *
 * THERE IS NO DELETE PARSER, and there will not be one. A policy that governed
 * recorded runs is part of how those runs were judged; removing the row would
 * make past outcomes uninterpretable.
 */
export function parseDisablePolicyBody(raw: unknown): ParseResult<DisablePolicyRequest> {
  if (!isRecord(raw)) return { ok: false, message: 'body must be a JSON object' }
  const forbidden = forbiddenContentInRequest(raw)
  if (forbidden.length > 0) return { ok: false, message: forbidden.join('; ') }
  if (!isNonEmptyString(raw['policyId'])) {
    return { ok: false, message: 'policyId is required and must be a non-empty string' }
  }
  if (!isNonEmptyString(raw['reason'])) {
    return {
      ok: false,
      message:
        'reason is required and must be a non-empty string. Disabling a policy is written to the append-only admin ' +
        'audit log, and a defaulted reason records that a control was switched off without recording why.',
    }
  }
  return { ok: true, value: { policyId: raw['policyId'], reason: raw['reason'] } }
}
