/**
 * lib/policies/localWire.ts — the narrowing layer over what `convex/policies.ts`
 * and `convex/policy_gate.ts` actually return.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS NOT A `as PolicyEvaluation` CAST
 * ===========================================================================
 *
 * `packages/contracts/src/policy.ts` is authoritative on this vocabulary
 * (CLAUDE.md → Repo Conventions → Types). The Convex engine, which landed from
 * another boundary, speaks a DIFFERENT one — `convex/helpers/policy.ts`'s
 * `LocalPolicy` / `LocalPolicyFinding` / `LocalPolicySnapshot`. The two are not
 * a rename apart. The divergences that matter here, each of which changes what
 * may be shown to a reader:
 *
 *   `prohibits: "model_invocation"`  has NO member in contracts'
 *                                    `PolicyRuleKind`. A policy of this kind
 *                                    cannot be stated in contracts' vocabulary
 *                                    at all.
 *   `scope: "agent_version"`         has NO arm in contracts' `PolicySubject`.
 *   `matcher`                        is ONE REQUIRED VALUE with an `exact` /
 *                                    `domain_suffix` mode. Contracts uses an
 *                                    OPTIONAL LIST whose ABSENCE means "deny the
 *                                    whole operation" — the only form under
 *                                    which an externalised payload still proves
 *                                    a violation. Neither shape is a superset of
 *                                    the other.
 *   `revision`                       is on the stored row and on contracts'
 *                                    `PolicyDefinition`, and is DROPPED by
 *                                    `convex/policies.ts`'s `toLocalPolicy`.
 *                                    Contracts' own `policySnapshotRefusals`
 *                                    refuses a definition without it.
 *   `name`                           is required by contracts'
 *                                    `PolicyDefinition` and `UpsertPolicyRequest`
 *                                    and has no column in `convex/schema.ts`.
 *
 * A cast would paper over every one of those and hand a renderer a body
 * TypeScript vouches for and contracts refuses. So this module CONVERTS, and —
 * the whole point — it is allowed to FAIL to convert, loudly, per policy.
 *
 * ===========================================================================
 * THE ONE RULE THIS FILE IS BUILT AROUND
 * ===========================================================================
 *
 * A POLICY THIS LAYER CANNOT REPRESENT IS NEVER SILENTLY DROPPED.
 *
 * Dropping it is the single worst thing this module could do, in both
 * directions and for two different readers:
 *
 *   IN A PRE-FLIGHT LISTING, a dropped policy is a prohibition the SDK never
 *     hears about, so `decidePreflight` answers `no_listed_policy_forbids_this_act`
 *     for an act that IS forbidden. That is the permissive direction.
 *   ON A COMPLIANCE SCREEN, a dropped policy is a control an operator believes
 *     is in force and which nothing is grading.
 *
 * So every conversion returns a two-armed result, and the caller must account
 * for the failures — in the listing by raising `listingTruncated`, which
 * contracts' `decidePreflight` already treats as "this listing cannot answer a
 * negative question"; on screen by rendering the unrepresented policies as their
 * own row with the reason.
 *
 * NOTHING IN THIS FILE INVENTS A FIELD. Not a revision, not a rule kind, not a
 * subject. An invented revision is the one that would hurt most: contracts
 * stamps it on every outcome precisely so a finding can be reproduced against
 * the rule it was judged under, and a fabricated one makes an unreproducible
 * finding look reproducible.
 */
import {
  POLICY_RULE_KINDS,
  POLICY_SUBJECT_KINDS,
  type PolicyDefinition,
  type PolicyRule,
  type PolicySubject,
  type PolicyVerdict,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// WHAT CONVEX ACTUALLY RETURNS
//
// Declared as `unknown`-tolerant readers rather than as interfaces asserted over
// the response, because the `makeFunctionReference` seam in lib/convexFunctions.ts
// verifies nothing about the function it names: an interface here would be an
// assertion, not a check. Every field below is READ through a predicate.
// ---------------------------------------------------------------------------

/** The five scopes `convex/schema.ts` accepts. Mirrored to be compared against, never trusted. */
export const CONVEX_POLICY_SCOPES = [
  'org',
  'project',
  'agent',
  'agent_version',
  'environment',
] as const
export type ConvexPolicyScope = (typeof CONVEX_POLICY_SCOPES)[number]

/** The three act kinds `convex/schema.ts` accepts. */
export const CONVEX_PROHIBITED_ACT_KINDS = [
  'tool_invocation',
  'egress_to_host',
  'model_invocation',
] as const
export type ConvexProhibitedActKind = (typeof CONVEX_PROHIBITED_ACT_KINDS)[number]

export interface ConvexPolicyRow {
  readonly policyId: string
  readonly scope: ConvexPolicyScope
  readonly scopeId: string
  readonly prohibits: ConvexProhibitedActKind
  readonly matcher: { readonly match: 'exact' | 'domain_suffix'; readonly value: string }
  readonly rationale: string
  readonly enabled: boolean
  readonly createdAt: number
  /**
   * PRESENT ON THE STORED ROW, ABSENT FROM `toLocalPolicy`'s projection.
   *
   * Optional here for that reason and NOT defaulted anywhere — see this file's
   * header on why a fabricated revision is the worst field to fabricate.
   */
  readonly revision?: number
  /** No column exists. Read anyway, so the day one is added this layer uses it. */
  readonly name?: string
  /**
   * `convex/policies.ts`'s `listPolicies` computes this per row: whether the
   * ENGINE can interpret the rule at all. `false` is a control an operator
   * believes is in force and which grades nothing.
   */
  readonly interpretable?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Read one stored policy row, or `null` when it is not one.
 *
 * FAILS CLOSED, and the failure is visible: `null` here becomes an
 * `unrepresentable` entry upstream, never an omission. A row this reader cannot
 * make sense of is exactly as likely to be the row that forbids the act as any
 * other.
 */
export function readConvexPolicyRow(value: unknown): ConvexPolicyRow | null {
  if (!isRecord(value)) return null
  const policyId = value['policyId'] ?? value['_id']
  const scope = value['scope']
  const prohibits = value['prohibits']
  const matcher = value['matcher']
  if (!isNonEmptyString(policyId)) return null
  if (!(CONVEX_POLICY_SCOPES as readonly unknown[]).includes(scope)) return null
  if (!(CONVEX_PROHIBITED_ACT_KINDS as readonly unknown[]).includes(prohibits)) return null
  if (!isRecord(matcher)) return null
  const match = matcher['match']
  const matchValue = matcher['value']
  if (match !== 'exact' && match !== 'domain_suffix') return null
  if (!isNonEmptyString(matchValue)) return null
  if (!isNonEmptyString(value['scopeId'])) return null
  if (!isNonEmptyString(value['rationale'])) return null
  if (typeof value['enabled'] !== 'boolean') return null
  if (!isFiniteNumber(value['createdAt'])) return null
  return {
    policyId,
    scope: scope as ConvexPolicyScope,
    scopeId: value['scopeId'],
    prohibits: prohibits as ConvexProhibitedActKind,
    matcher: { match, value: matchValue },
    rationale: value['rationale'],
    enabled: value['enabled'],
    createdAt: value['createdAt'],
    ...(isCount(value['revision']) && { revision: value['revision'] }),
    ...(isNonEmptyString(value['name']) && { name: value['name'] }),
    ...(typeof value['interpretable'] === 'boolean' && { interpretable: value['interpretable'] }),
  }
}

// ---------------------------------------------------------------------------
// CONVERSION TO CONTRACTS' VOCABULARY
// ---------------------------------------------------------------------------

/**
 * One policy, converted or explicitly not.
 *
 * TWO ARMS AND NO THIRD. There is deliberately no "converted with caveats" arm:
 * a caveat is a thing a caller can forget to read, and this union is
 * unnarrowable without deciding which of the two it is.
 */
export type PolicyConversion =
  | { readonly represented: true; readonly definition: PolicyDefinition }
  | {
      readonly represented: false
      /** `null` only when the row was so malformed the id could not be read. */
      readonly policyId: string | null
      /** Names the field and why, as prose an operator can act on. */
      readonly unrepresentableBecause: string
    }

/**
 * Convert a stored rule to contracts' `PolicyRule`.
 *
 * ---------------------------------------------------------------------------
 * THE THREE DECISIONS, AND THE DIRECTION EACH ONE ERRS IN
 * ---------------------------------------------------------------------------
 *
 * `tool_invocation` + `exact`
 *   -> `{ kind: "tool_denied", deniedTools: [value] }`. Exact both sides.
 *
 * `tool_invocation` + `domain_suffix`
 *   -> UNREPRESENTABLE. Contracts' `deniedTools` is an exact list; there is no
 *      suffix spelling. Narrowing the rule to the literal value would make the
 *      listing state a NARROWER prohibition than the one in force, which is the
 *      permissive direction — the SDK would be told a tool is allowed that the
 *      evaluator will later report as a violation.
 *
 * `egress_to_host` + either mode
 *   -> `{ kind: "egress_denied", deniedHosts: [value] }`. Contracts matches
 *      `deniedHosts` with `hostFallsUnder`, which is LABEL-BOUNDARY SUFFIX
 *      matching, so an `exact` stored rule is stated here as slightly WIDER than
 *      it is: `evil.example` will also advise against `api.evil.example`.
 *
 *      THAT WIDENING IS ACCEPTED, AND THE ASYMMETRY IS THE REASON. A pre-flight
 *      that advises against one act too many costs the caller a declined call it
 *      could have made; a pre-flight that advises against one act too few is a
 *      forbidden egress the SDK never mentioned. Only the second produces a
 *      false clean, and the widening cannot produce it.
 *
 * `model_invocation` + anything
 *   -> UNREPRESENTABLE. Contracts has no rule kind for it, and there is no
 *      nearest neighbour: stating it as `tool_denied` would grade `tool.call`
 *      events against a rule about `llm.request`.
 *
 * NOTE WHAT IS NEVER PRODUCED HERE: a rule with `deniedTools` / `deniedHosts`
 * ABSENT. Absence means "deny the operation entirely" in contracts, which is a
 * STRICTLY WIDER rule than any stored row can express — `convex/schema.ts`
 * requires a non-empty matcher value. Emitting one would invent a prohibition
 * nobody wrote.
 */
export function convertRule(
  row: Pick<ConvexPolicyRow, 'prohibits' | 'matcher'>,
): { ok: true; rule: PolicyRule } | { ok: false; because: string } {
  if (row.prohibits === 'tool_invocation') {
    if (row.matcher.match === 'exact') {
      return { ok: true, rule: { kind: 'tool_denied', deniedTools: [row.matcher.value] } }
    }
    return {
      ok: false,
      because:
        `this policy forbids tool invocations matching the DOMAIN SUFFIX "${row.matcher.value}", and contracts' ` +
        `\`tool_denied\` rule carries an exact-match list with no suffix spelling. Restating it as an exact rule ` +
        `would state a NARROWER prohibition than the one in force, so it is reported unrepresented instead.`,
    }
  }
  if (row.prohibits === 'egress_to_host') {
    return { ok: true, rule: { kind: 'egress_denied', deniedHosts: [row.matcher.value] } }
  }
  return {
    ok: false,
    because:
      `this policy forbids MODEL INVOCATIONS ("${row.matcher.value}"), and contracts' \`PolicyRuleKind\` has no ` +
      `member for that act. There is no nearest neighbour: stating it as \`tool_denied\` would grade tool.call ` +
      `events against a rule about llm.request. It is reported unrepresented.`,
  }
}

/**
 * Convert a stored scope to contracts' `PolicySubject`.
 *
 * `agent_version` is UNREPRESENTABLE. Contracts' subject union has org, project,
 * agent and environment; an immutable agent VERSION is not among them. Widening
 * it to the `agent` arm would state that the policy governs every version of the
 * agent, which is a different and larger claim than the operator made.
 */
export function convertSubject(
  row: Pick<ConvexPolicyRow, 'scope' | 'scopeId'>,
): { ok: true; subject: PolicySubject } | { ok: false; because: string } {
  switch (row.scope) {
    case 'org':
      return { ok: true, subject: { appliesTo: 'org' } }
    case 'project':
      return { ok: true, subject: { appliesTo: 'project', projectId: row.scopeId } }
    case 'agent':
      return { ok: true, subject: { appliesTo: 'agent', agentId: row.scopeId } }
    case 'environment':
      return { ok: true, subject: { appliesTo: 'environment', environment: row.scopeId } }
    case 'agent_version':
      return {
        ok: false,
        because:
          `this policy is scoped to AGENT VERSION ${row.scopeId}, and contracts' \`PolicySubject\` has arms for ` +
          `org, project, agent and environment only. Restating it as an agent-scoped policy would claim it ` +
          `governs every version of that agent, which is a larger claim than the one stored.`,
      }
    default: {
      // Total over the scope vocabulary: a sixth scope is a compile error here
      // until somebody decides how it is stated, rather than a silent drop.
      const unreachable: never = row.scope
      return { ok: false, because: `unknown policy scope ${String(unreachable)}` }
    }
  }
}

/**
 * A DISPLAY LABEL for a policy row, when the store has no `name` column.
 *
 * NOT A FABRICATED FACT: every token in it is read back out of the stored row.
 * It is a restatement of `prohibits` and `matcher`, not an invention, and it is
 * only ever used where contracts requires a `name: string` that the schema has
 * nowhere to put. The day `convex/schema.ts` grows a `name` column,
 * `readConvexPolicyRow` picks it up and this is not reached.
 */
export function derivedPolicyName(
  row: Pick<ConvexPolicyRow, 'prohibits' | 'matcher' | 'scope' | 'scopeId'>,
): string {
  return `${row.prohibits} ${row.matcher.match} "${row.matcher.value}" @ ${row.scope}:${row.scopeId}`
}

/**
 * Convert one stored row to a contracts `PolicyDefinition`, or say why not.
 *
 * `orgId` is supplied by the CALLER rather than read off the row, because the
 * key-authed gate never returns one — the org comes from the credential and a
 * caller cannot name an organization, which is exactly the property that keeps
 * that surface from being a cross-tenant door (CLAUDE.md Tenancy Rules).
 */
export function convertPolicyRow(row: ConvexPolicyRow, orgId: string): PolicyConversion {
  const rule = convertRule(row)
  if (!rule.ok) {
    return { represented: false, policyId: row.policyId, unrepresentableBecause: rule.because }
  }
  const subject = convertSubject(row)
  if (!subject.ok) {
    return { represented: false, policyId: row.policyId, unrepresentableBecause: subject.because }
  }
  // THE REVISION IS NOT DEFAULTED. See this file's header. `toLocalPolicy` in
  // `convex/policies.ts` currently drops it, so this arm is today's universal
  // one on the key-authed listing — and a truncated listing is the honest
  // consequence, not a bug to route around.
  if (!isCount(row.revision)) {
    return {
      represented: false,
      policyId: row.policyId,
      unrepresentableBecause:
        `this policy carried no \`revision\`. Contracts stamps the revision on every outcome so a finding can be ` +
        `reproduced against the rule it was judged under, and \`policySnapshotRefusals\` refuses a definition ` +
        `without one. Defaulting it would make an unreproducible finding look reproducible. ` +
        `\`convex/policies.ts\`'s \`toLocalPolicy\` projection drops the column the row already stores.`,
    }
  }
  return {
    represented: true,
    definition: {
      policyId: row.policyId,
      orgId,
      name: row.name ?? derivedPolicyName(row),
      revision: row.revision,
      rule: rule.rule,
      subject: subject.subject,
      rationale: row.rationale,
      enabled: row.enabled,
      createdAt: row.createdAt,
    },
  }
}

/** Both halves of converting a list, with the failures kept rather than filtered. */
export interface PolicyListConversion {
  readonly represented: readonly PolicyDefinition[]
  readonly unrepresented: readonly Extract<PolicyConversion, { represented: false }>[]
}

/**
 * Convert every row, keeping BOTH halves.
 *
 * The signature is the enforcement: there is no overload that returns only the
 * definitions, so a caller cannot end up with the represented half and no idea
 * that a half was lost.
 */
export function convertPolicyRows(rows: readonly unknown[], orgId: string): PolicyListConversion {
  const represented: PolicyDefinition[] = []
  const unrepresented: Extract<PolicyConversion, { represented: false }>[] = []
  for (const raw of rows) {
    const row = readConvexPolicyRow(raw)
    if (row === null) {
      unrepresented.push({
        represented: false,
        policyId: null,
        unrepresentableBecause:
          'this row could not be read as a policy at all. It is reported rather than skipped: an unreadable row ' +
          'is exactly as likely to be the one that forbids the act as any other.',
      })
      continue
    }
    const converted = convertPolicyRow(row, orgId)
    if (converted.represented) represented.push(converted.definition)
    else unrepresented.push(converted)
  }
  return { represented, unrepresented }
}

// ---------------------------------------------------------------------------
// THE VERDICT, READ OFF A BODY NOTHING HAS VOUCHED FOR
// ---------------------------------------------------------------------------

const POLICY_VERDICTS: readonly PolicyVerdict[] = [
  'violations_found',
  'no_policy_governs_this_subject',
  'evaluation_incomplete',
  'no_violation_and_every_policy_was_evaluable',
]

/**
 * Read a verdict string, FAILING CLOSED to `evaluation_incomplete`.
 *
 * Not to the all-clear, obviously, and not to `no_policy_governs_this_subject`
 * either: "we could not read the verdict" and "there was nothing to check" are
 * different, and only one of them is what an unreadable field means.
 */
export function readVerdict(value: unknown): PolicyVerdict {
  return (POLICY_VERDICTS as readonly unknown[]).includes(value)
    ? (value as PolicyVerdict)
    : 'evaluation_incomplete'
}

/** Re-exported so a consumer never reaches past this module for the vocabularies. */
export { POLICY_RULE_KINDS, POLICY_SUBJECT_KINDS }
