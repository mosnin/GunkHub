/**
 * THE FOUR V1 POLICY ROUTES' REQUEST CONTRACT, AND THE SNAPSHOT MAPPING.
 *
 * Covers the three things a route test can pin without a live deployment: the
 * pure body/param validators, the pure wire mapping, and the source-level
 * properties that decide whether an auth failure is an existence oracle.
 *
 * ===========================================================================
 * WHY THE ORDER OF CHECKS INSIDE A ROUTE IS TESTED AT ALL
 * ===========================================================================
 *
 * "Auth failures that are not existence oracles" is not a property of any single
 * response — it is a property of the RELATIONSHIP between responses. If
 * parameter validation runs after key resolution, a request with a bad parameter
 * answers differently depending on whether the key is valid, and a caller can
 * distinguish a real key from a fake one by sending garbage. The fix is
 * ordering: validate first, so the response is identical either way. That is a
 * source property, so it gets a source test.
 *
 * ===========================================================================
 * WHY `?fields=` GETS ITS OWN SECTION
 * ===========================================================================
 *
 * On the budget snapshot, refusing a projection is about usefulness: contracts
 * reports the stripped body as malformed and the client degrades to "no answer".
 * The failure points the safe way.
 *
 * On `/api/v1/policies/evaluate` it points the OTHER way, which is why the
 * decision was made deliberately rather than copied. `?fields=scan` removes
 * `outcomes` entirely — stripping every PROVEN VIOLATION out of a compliance
 * report while leaving a body that still parses, still carries a scan, and still
 * yields a verdict. A caller, a screenshot, or a questionnaire attachment then
 * holds a document saying a scan ran and found nothing. That is the failure
 * ADR-009 exists to prevent, reachable in one query parameter, and unfixable
 * client-side because the caller cannot tell a projected clean from a real one.
 */
import { readFileSync } from 'fs'
import path from 'path'

import { policySnapshotRefusals } from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import { convertPolicyRow, convertPolicyRows, readConvexPolicyRow } from '@/lib/policies/localWire'
import {
  parseDisablePolicyBody,
  parseUpsertPolicyBody,
  validateRule,
  validateSubject,
} from '@/lib/policies/mutationRequest'
import { policySnapshotEnvelope } from '@/lib/services/api_v1_policies'

const WEB_ROOT = path.resolve(__dirname, '../../apps/web')
const read = (p: string) => readFileSync(path.join(WEB_ROOT, p), 'utf8')

const ROUTES = {
  snapshot: 'app/api/v1/policies/snapshot/route.ts',
  evaluate: 'app/api/v1/policies/evaluate/route.ts',
  upsert: 'app/api/v1/policies/upsert/route.ts',
  disable: 'app/api/v1/policies/disable/route.ts',
} as const

// ===========================================================================
// §1 — ALL FOUR ROUTES EXIST AND FOLLOW V1 CONVENTIONS
// ===========================================================================

describe('§1 the four routes the CLI and SDK address exist', () => {
  it('every route file is present', () => {
    for (const file of Object.values(ROUTES)) {
      expect(() => read(file)).not.toThrow()
    }
  })

  it('every route goes through withApiHandler with an explicit rate class', () => {
    for (const [name, file] of Object.entries(ROUTES)) {
      const src = read(file)
      expect(src, name).toContain('withApiHandler')
      expect(src, name).toMatch(/rateLimit:\s*\{\s*key:\s*'apiKey'/)
    }
  })

  it('every route authenticates by x-api-key and never by Clerk', () => {
    // Mixing the two auth models in one route is how a future edit reaches for
    // the wrong one. An API key carries no role, so it cannot gate a privileged
    // act — which is exactly why the two writes 501 rather than guessing.
    for (const [name, file] of Object.entries(ROUTES)) {
      const src = read(file)
      expect(src, name).toContain("req.headers.get('x-api-key')")
      expect(src, name).toContain('v1UnauthorizedNoKey')
      expect(src, name).not.toContain('@clerk/nextjs')
    }
  })

  it('the two writes are POST and the two reads are GET', () => {
    expect(read(ROUTES.snapshot)).toContain('export const GET')
    expect(read(ROUTES.evaluate)).toContain('export const GET')
    expect(read(ROUTES.upsert)).toContain('export const POST')
    expect(read(ROUTES.disable)).toContain('export const POST')
  })

  it('the two writes fail LOUDLY rather than no-opping', () => {
    // A privileged mutation has exactly two acceptable behaviours: perform the
    // act and audit it, or fail loudly. A policy an operator believes exists and
    // does not is a control that grades nothing while appearing to be in force.
    for (const file of [ROUTES.upsert, ROUTES.disable]) {
      expect(read(file)).toContain('v1NotImplemented')
    }
  })
})

// ===========================================================================
// §2 — VALIDATION RUNS BEFORE THE KEY IS TOUCHED
// ===========================================================================

describe('§2 an auth failure is not an existence oracle', () => {
  it('the two GET routes validate the subject BEFORE reading the key header', () => {
    for (const file of [ROUTES.snapshot, ROUTES.evaluate]) {
      const src = read(file)
      const subjectCheck = src.indexOf('name a subject')
      const keyRead = src.indexOf("req.headers.get('x-api-key')")
      expect(subjectCheck, file).toBeGreaterThan(-1)
      expect(keyRead, file).toBeGreaterThan(-1)
      expect(subjectCheck, file).toBeLessThan(keyRead)
    }
  })

  it('the two GET routes refuse `fields` BEFORE reading the key header', () => {
    for (const file of [ROUTES.snapshot, ROUTES.evaluate]) {
      const src = read(file)
      expect(src.indexOf('parseFieldsParam'), file).toBeLessThan(
        src.indexOf("req.headers.get('x-api-key')"),
      )
    }
  })

  it('both GET routes require a named subject and refuse an implicit default', () => {
    // Omitting every id would be read as "everything that governs me", which
    // silently changes meaning the day somebody adds an org-wide policy — and it
    // changes it in the direction that under-reports.
    for (const file of [ROUTES.snapshot, ROUTES.evaluate]) {
      const src = read(file)
      expect(src, file).toContain('name a subject')
      expect(src, file).toContain("orgWide !== 'true'")
      // `orgWide` is an explicit opt-in and is never coerced from other values.
      expect(src, file).toContain('must be exactly "true"')
    }
  })
})

// ===========================================================================
// §3 — `?fields=` IS REFUSED ON BOTH READ ROUTES
// ===========================================================================

describe('§3 no projection can turn a withheld answer into an apparent clean one', () => {
  it('both read routes refuse a well-formed `fields` parameter', () => {
    for (const file of [ROUTES.snapshot, ROUTES.evaluate]) {
      const src = read(file)
      expect(src, file).toContain('fields.fields !== undefined')
      expect(src, file).toContain('fields projection is not supported on this route')
    }
  })

  it('both still validate the SHAPE of `fields` first, so a malformed one gets the shared message', () => {
    for (const file of [ROUTES.snapshot, ROUTES.evaluate]) {
      const src = read(file)
      expect(src.indexOf('fieldsInvalidArgument'), file).toBeLessThan(
        src.indexOf('fields projection is not supported'),
      )
    }
  })

  it('the evaluate route states the ASYMMETRIC reason, not the budget route reason', () => {
    // The budget snapshot refuses because a projection degrades the answer to
    // "no answer" — safe but useless. Here a projection can remove the outcomes
    // and serve a report that looks clean. The route must say so, because the
    // next person to read it will otherwise assume the parameter was refused by
    // copy-paste and re-enable it.
    const src = read(ROUTES.evaluate)
    expect(src).toContain('remove the outcomes entirely')
    expect(src).toContain('proven violation')
    expect(src).toContain('scan.retentionHorizon')
  })

  it('neither read route ever forwards a fields list to the service layer', () => {
    for (const file of [ROUTES.snapshot, ROUTES.evaluate]) {
      expect(read(file), file).not.toMatch(/fields:\s*fields\.fields/)
    }
  })
})

// ===========================================================================
// §4 — THE WRITE BODIES
// ===========================================================================

describe('§4 the privileged write bodies', () => {

  it('accepts a well-formed upsert and passes the rule through UNCHANGED', () => {
    const rule = { kind: 'tool_denied', deniedTools: ['shell.exec'] }
    const subject = { appliesTo: 'agent', agentId: 'agt_7' }
    const parsed = parseUpsertPolicyBody({
      name: 'No shell execution',
      rule,
      subject,
      rationale: 'SOC2 CC6.1 — no shell execution from customer-facing agents.',
      enabled: true,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // THE STORED SHAPE IS THE WIRE SHAPE. `convex/policies.ts`'s createPolicy
    // takes `{orgId, name, rule, subject, rationale, enabled?}` and
    // `convex/schema.ts` stores `rule`/`subject` as the same nested unions
    // contracts declares. There is no projection, so there is nothing here that
    // can store a different rule from the one that was sent.
    expect(parsed.value).toEqual({
      name: 'No shell execution',
      rule,
      subject,
      rationale: 'SOC2 CC6.1 — no shell execution from customer-facing agents.',
      enabled: true,
    })
  })

  it('ACCEPTS the deny-the-whole-operation rule, which is the only externalization-proof form', () => {
    // REGRESSION. An earlier draft rejected `{ kind: "tool_denied" }` as
    // "strictly wider than any policy row this backend can store", citing a flat
    // one-matcher schema that has never existed. It is not only storable, it is
    // the ONE rule form decidable from an event type alone — the only form under
    // which an externalized (>10 KB) payload still proves a violation, because
    // the event TYPE survives externalization while the tool name does not.
    // Contracts' `ruleIsDecidableFromEventTypeAlone` is true for this and
    // nothing else. Rejecting it removed the most valuable policy in the system.
    for (const rule of [{ kind: 'tool_denied' }, { kind: 'egress_denied' }]) {
      const parsed = parseUpsertPolicyBody({
        name: 'n',
        rule,
        subject: { appliesTo: 'org' },
        rationale: 'r',
        enabled: true,
      })
      expect(parsed.ok, JSON.stringify(rule)).toBe(true)
      if (!parsed.ok) continue
      // NOT normalised into an empty list. `undefined` forbids everything and
      // `[]` forbids nothing; they are one serialization step apart.
      expect(parsed.value.rule).toEqual(rule)
    }
  })

  it('REFUSES the vacuous empty list', () => {
    // An empty list forbids nothing, forever, while appearing in the policy list
    // as a control in force. This refusal was always correct — only its stated
    // reason was wrong. It is a misconfiguration, not an unstorable shape, and
    // `convex/schema.ts` says so in its own header.
    const r = validateRule({ kind: 'tool_denied', deniedTools: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('forbids nothing')
  })

  it('ACCEPTS a multi-value list — the schema stores an array', () => {
    // REGRESSION. The earlier draft refused this with "Write 2 policies
    // instead", to satisfy a one-matcher-per-row limit nothing imposes:
    // `convex/schema.ts` stores `v.optional(v.array(v.string()))`.
    const hosts = ['a.example', 'b.example']
    const r = validateRule({ kind: 'egress_denied', deniedHosts: hosts })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'egress_denied', deniedHosts: hosts })
  })

  it('validates EVERY element of the list, not only the first', () => {
    // A list is stored whole, so a bad value at index 3 is a bad stored rule.
    // The `7` is cast, not typed away: this arrives as untrusted JSON, so the
    // declared `readonly string[]` is a promise rather than a fact, and the
    // runtime guard is the only thing that makes it true.
    const bads: unknown[][] = [['ok.example', ''], ['ok.example', 7], ['ok.example', 'x'.repeat(600)]]
    for (const bad of bads) {
      const r = validateRule({ kind: 'egress_denied', deniedHosts: bad as string[] })
      expect(r.ok, JSON.stringify(bad)).toBe(false)
      if (r.ok) continue
      expect(r.message).toContain('[1]')
    }
  })

  it('takes NO org id — a policy subject carries none in contracts or in the schema', () => {
    // `{ appliesTo: "org" }` has no identifier field in either place. The org is
    // the `orgId` ARGUMENT of the Convex mutation, resolved from the session and
    // never from the body. An earlier draft stamped a caller-supplied id into
    // the subject, which left the v1 route passing the literal placeholder
    // string '(resolved from the credential)' — a tenancy boundary with a
    // decorative parameter, which reads as if it were enforced here.
    expect(validateSubject.length).toBe(1)
    const s = validateSubject({ appliesTo: 'org' })
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.value).toEqual({ appliesTo: 'org' })
    expect(read('src/lib/policies/mutationRequest.ts')).not.toContain('resolved from the credential')
    expect(read('app/api/v1/policies/upsert/route.ts')).not.toContain('resolved from the credential')
  })

  it('REQUIRES a rationale — it travels into every outcome the policy produces', () => {
    for (const rationale of [undefined, '', 7, null]) {
      const parsed = parseUpsertPolicyBody({
        name: 'n',
        rule: { kind: 'tool_denied', deniedTools: ['x'] },
        subject: { appliesTo: 'org' },
        rationale,
        enabled: true,
      })
      expect(parsed.ok).toBe(false)
    }
  })

  it('REFUSES a suppression directive planted on a policy DEFINITION', () => {
    // The worst possible place for one: the row outlives the request and every
    // later evaluation reads it. Contracts gives a policy no way to say "and
    // then drop the event"; this is that door kept shut at the layer that writes.
    for (const field of ['suppressViolation', 'dropEvent', 'blockIngest']) {
      const parsed = parseUpsertPolicyBody(
        {
          name: 'n',
          rule: { kind: 'tool_denied', deniedTools: ['x'] },
          subject: { appliesTo: 'org' },
          rationale: 'r',
          enabled: true,
          [field]: true,
        },
      )
      expect(parsed.ok, field).toBe(false)
    }
  })

  it('REFUSES a prevention or compliance claim anywhere in the body, at any depth', () => {
    const parsed = parseUpsertPolicyBody(
      {
        name: 'n',
        rule: { kind: 'tool_denied', deniedTools: ['x'], nested: { prevented: true } },
        subject: { appliesTo: 'org' },
        rationale: 'r',
        enabled: true,
      },
    )
    expect(parsed.ok).toBe(false)
  })

  it('REFUSES a compliance word in the rationale — it is quoted into every outcome', () => {
    const parsed = parseUpsertPolicyBody(
      {
        name: 'n',
        rule: { kind: 'tool_denied', deniedTools: ['x'] },
        subject: { appliesTo: 'org' },
        rationale: 'Ensures the agent stays compliant with SOC2.',
        enabled: true,
      },
    )
    expect(parsed.ok).toBe(false)
  })

  it('disable REQUIRES a reason — the audit row is worthless without one', () => {
    expect(parseDisablePolicyBody({ policyId: 'p1' }).ok).toBe(false)
    expect(parseDisablePolicyBody({ policyId: 'p1', reason: '' }).ok).toBe(false)
    expect(parseDisablePolicyBody({ policyId: 'p1', reason: 'tool renamed' }).ok).toBe(true)
  })

  it('there is no DELETE parser and no delete route', () => {
    // A policy that governed recorded runs is part of how those runs were
    // judged; removing the row leaves every past outcome pointing at a revision
    // of nothing.
    const src = read('src/lib/policies/mutationRequest.ts')
    expect(src).not.toMatch(/export function parseDeletePolicy/)
    expect(() => read('app/api/v1/policies/delete/route.ts')).toThrow()
  })

  it('neither parser throws on a hostile body', () => {
    for (const raw of [null, undefined, 'str', 42, [], [{ name: 'x' }], { rule: [] }]) {
      expect(() => parseUpsertPolicyBody(raw)).not.toThrow()
      expect(() => parseDisablePolicyBody(raw)).not.toThrow()
      expect(parseUpsertPolicyBody(raw).ok).toBe(false)
      expect(parseDisablePolicyBody(raw).ok).toBe(false)
    }
  })
})

// ===========================================================================
// §5 — THE SNAPSHOT MAPPING: A POLICY IT CANNOT STATE IS NEVER DROPPED
// ===========================================================================

describe('§5 the local -> contracts snapshot mapping', () => {
  const FULL_ROW = {
    policyId: 'pol_1',
    scope: 'agent',
    scopeId: 'agt_7',
    prohibits: 'tool_invocation',
    matcher: { match: 'exact', value: 'shell.exec' },
    rationale: 'no shell execution',
    enabled: true,
    createdAt: 1_700_000_000_000,
    revision: 3,
  }

  it('produces a body contracts own refusal walk ACCEPTS', () => {
    // The point of the whole mapping. A byte-for-byte forward of what
    // convex/policy_gate.ts returns is refused on every element, which would
    // give every deployment a permanently broken preflight.
    const out = policySnapshotEnvelope(
      {
        evaluatedAt: 1_700_000_000_000,
        shelfLifeMs: 600_000,
        subject: { orgId: 'org_1' },
        policies: [FULL_ROW],
        policiesInScope: 1,
        listingTruncated: false,
      },
      { agentId: 'agt_7' },
    )
    expect(policySnapshotRefusals(out.snapshot)).toEqual([])
    expect(out.snapshot.policies).toHaveLength(1)
    expect(out.snapshot.listingTruncated).toBe(false)
  })

  it('a policy it cannot state is COUNTED and forces listingTruncated', () => {
    // `listingTruncated` is contracts' own lever: "a truncated listing cannot
    // answer 'no policy forbids this' — the policy that forbids the act is
    // exactly as likely to be in the unread tail as in the read head." A policy
    // this layer could not state is in exactly that position.
    const out = policySnapshotEnvelope(
      {
        evaluatedAt: 1,
        shelfLifeMs: 600_000,
        subject: { orgId: 'org_1' },
        policies: [FULL_ROW, { ...FULL_ROW, policyId: 'pol_2', prohibits: 'model_invocation' }],
        policiesInScope: 2,
        listingTruncated: false,
      },
      { agentId: 'agt_7' },
    )
    expect(out.snapshot.policies).toHaveLength(1)
    // The count stays HONEST: two policies govern the subject.
    expect(out.snapshot.policiesInScope).toBe(2)
    expect(out.snapshot.listingTruncated).toBe(true)
    expect(out.unrepresented).toHaveLength(1)
    expect(out.unrepresented[0]?.policyId).toBe('pol_2')
    expect(policySnapshotRefusals(out.snapshot)).toEqual([])
  })

  it('a missing revision makes a policy unrepresentable rather than defaulting one', () => {
    // Contracts stamps the revision on every outcome so a finding can be
    // reproduced against the rule it was judged under. Defaulting it would make
    // an unreproducible finding look reproducible.
    const { revision: _drop, ...noRevision } = FULL_ROW
    const conv = convertPolicyRow(readConvexPolicyRow(noRevision)!, 'org_1')
    expect(conv.represented).toBe(false)
    if (conv.represented) return
    expect(conv.unrepresentableBecause).toContain('revision')
  })

  it('an agent_version scope is unrepresentable rather than widened to agent', () => {
    const conv = convertPolicyRow(
      readConvexPolicyRow({ ...FULL_ROW, scope: 'agent_version', scopeId: 'ver_1' })!,
      'org_1',
    )
    expect(conv.represented).toBe(false)
    if (conv.represented) return
    expect(conv.unrepresentableBecause).toContain('larger claim')
  })

  it('a tool rule with suffix matching is unrepresentable rather than narrowed', () => {
    const r = convertPolicyRow(
      readConvexPolicyRow({ ...FULL_ROW, matcher: { match: 'domain_suffix', value: 'sh' } })!,
      'org_1',
    )
    expect(r.represented).toBe(false)
    if (r.represented) return
    expect(r.unrepresentableBecause).toContain('NARROWER')
  })

  it('an unreadable row becomes an unrepresented entry, never an omission', () => {
    const conv = convertPolicyRows([FULL_ROW, null, 'garbage', {}], 'org_1')
    expect(conv.represented).toHaveLength(1)
    expect(conv.unrepresented).toHaveLength(3)
  })

  it('every fallback in the envelope points AWAY from "complete and empty"', () => {
    // "Complete and empty" is the one answer that means "nothing forbids this
    // act". A dropped field must never produce it.
    const out = policySnapshotEnvelope({}, { orgWide: true })
    expect(out.snapshot.listingTruncated).toBe(true)
    expect(policySnapshotRefusals(out.snapshot)).toEqual([])
  })

  it('the subject echoed is the one the CALLER asked for', () => {
    // The SDK compares it against its own parameters and refuses a listing whose
    // subject differs — that is how a deployment that ignored a narrowing id is
    // caught. Echoing the backend's own view would defeat the check.
    const out = policySnapshotEnvelope(
      { subject: { orgId: 'org_1', agentId: 'SOMETHING_ELSE' }, policies: [] },
      { agentId: 'agt_7' },
    )
    expect(out.snapshot.subject).toEqual({ agentId: 'agt_7' })
  })

  it('never throws on a hostile body', () => {
    for (const raw of [null, undefined, 'str', 42, [], { policies: 'no' }, { policies: [null] }]) {
      expect(() => policySnapshotEnvelope(raw, {})).not.toThrow()
    }
  })
})
