/**
 * THE THREE V1 BUDGET ROUTES' REQUEST CONTRACT.
 *
 * Covers the two things a route test can pin without a live deployment: the
 * pure body/param validators, and the source-level properties that decide
 * whether an auth failure is an existence oracle.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORDER OF CHECKS INSIDE A ROUTE IS TESTED AT ALL
 * ---------------------------------------------------------------------------
 *
 * "Auth failures that are not existence oracles" is not a property of any
 * single response — it is a property of the RELATIONSHIP between responses. If
 * parameter validation runs after key resolution, then a request with a bad
 * parameter answers differently depending on whether the key is valid, and a
 * caller can distinguish a real key from a fake one by sending garbage. The fix
 * is ordering: validate first, so the response is identical either way. That is
 * a source property, so it gets a source test.
 */
import { readFileSync } from 'fs'
import path from 'path'

import { BUDGET_METERS, BUDGET_PERIODS, BUDGET_SCOPES } from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'


import { parseCreateBudgetBody } from '@/lib/budgets/createRequest'
import { MAX_BUDGET_REASON_LENGTH, parseBudgetMutationBody } from '@/lib/budgets/mutationRequest'

const WEB_ROOT = path.resolve(__dirname, '../../apps/web')
const read = (p: string) => readFileSync(path.join(WEB_ROOT, p), 'utf8')

describe('trip/reset body: a privileged act cannot be sent without a reason', () => {
  it('accepts a well-formed body', () => {
    const parsed = parseBudgetMutationBody({ budgetId: 'b1', reason: 'runaway eval loop' })
    expect(parsed).toEqual({ ok: true, body: { budgetId: 'b1', reason: 'runaway eval loop' } })
  })

  it('REJECTS a missing reason rather than defaulting one', () => {
    // A defaulted "no reason given" writes a plausible-looking audit row that
    // nobody chose. For a manual trip that row is the ENTIRE justification —
    // there is no meter reading behind it.
    const parsed = parseBudgetMutationBody({ budgetId: 'b1' })
    expect(parsed.ok).toBe(false)
  })

  it('rejects a whitespace-only reason', () => {
    expect(parseBudgetMutationBody({ budgetId: 'b1', reason: '   ' }).ok).toBe(false)
  })

  it('rejects an empty reason', () => {
    expect(parseBudgetMutationBody({ budgetId: 'b1', reason: '' }).ok).toBe(false)
  })

  it('forwards the reason TRIMMED, so the audit log stores what a reader sees', () => {
    const parsed = parseBudgetMutationBody({ budgetId: 'b1', reason: '  cost spike  ' })
    expect(parsed.ok && parsed.body.reason).toBe('cost spike')
  })

  it('bounds the reason — it lands in a log that is never edited', () => {
    const parsed = parseBudgetMutationBody({
      budgetId: 'b1',
      reason: 'x'.repeat(MAX_BUDGET_REASON_LENGTH + 1),
    })
    expect(parsed.ok).toBe(false)
  })

  it('rejects a missing or non-string budgetId', () => {
    for (const body of [{ reason: 'r' }, { budgetId: 7, reason: 'r' }, { budgetId: '', reason: 'r' }]) {
      expect(parseBudgetMutationBody(body).ok).toBe(false)
    }
  })

  it('never throws on a hostile body', () => {
    for (const raw of [null, undefined, 'string', 42, [], [{ budgetId: 'b' }]]) {
      expect(() => parseBudgetMutationBody(raw)).not.toThrow()
      expect(parseBudgetMutationBody(raw).ok).toBe(false)
    }
  })

  it('its error messages are static copy, never an echo of the input', () => {
    // An error that quotes the request body turns a validator into a reflection
    // surface. Checked with a distinctive value that would be visible if echoed.
    const parsed = parseBudgetMutationBody({ budgetId: 'CANARY-VALUE-1234', reason: '' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).not.toContain('CANARY-VALUE-1234')
  })
})

describe('create body: the vocabularies come from the contract, not a local copy', () => {
  const valid = {
    name: 'Daily output tokens',
    scope: 'agent',
    scopeId: 'agent_1',
    meter: 'tokens_out',
    period: 'day',
    limitAmount: 1_000_000,
  }

  it('accepts a well-formed body', () => {
    expect(parseCreateBudgetBody(valid).ok).toBe(true)
  })

  it('accepts every member of every contract vocabulary', () => {
    // The check that catches a locally respelled union: a member this layer
    // rejects but Convex accepts is a 422 on a legitimate request, and a member
    // this layer accepts but Convex rejects is a 500 at the far end of a form.
    for (const scope of BUDGET_SCOPES) {
      expect(parseCreateBudgetBody({ ...valid, scope }).ok, `scope ${scope}`).toBe(true)
    }
    for (const meter of BUDGET_METERS) {
      expect(parseCreateBudgetBody({ ...valid, meter }).ok, `meter ${meter}`).toBe(true)
    }
    for (const period of BUDGET_PERIODS) {
      expect(parseCreateBudgetBody({ ...valid, period }).ok, `period ${period}`).toBe(true)
    }
  })

  it('rejects a vocabulary member the contract does not define', () => {
    expect(parseCreateBudgetBody({ ...valid, scope: 'organisation' }).ok).toBe(false)
    expect(parseCreateBudgetBody({ ...valid, meter: 'dollars' }).ok).toBe(false)
  })

  it('rejects a fractional limit — money is counted in minor units, never decimals', () => {
    // Floating-point money is how a limit of 100.00 is compared against a spend
    // of 100.00000000000001, and how 99.99999999999999 reads as under.
    expect(parseCreateBudgetBody({ ...valid, limitAmount: 10.5 }).ok).toBe(false)
  })

  it('rejects a zero or negative limit', () => {
    // A limit of 0 is breached by an empty window.
    expect(parseCreateBudgetBody({ ...valid, limitAmount: 0 }).ok).toBe(false)
    expect(parseCreateBudgetBody({ ...valid, limitAmount: -1 }).ok).toBe(false)
  })

  it('never throws on a hostile body', () => {
    for (const raw of [null, undefined, 'x', 1, []]) {
      expect(() => parseCreateBudgetBody(raw)).not.toThrow()
      expect(parseCreateBudgetBody(raw).ok).toBe(false)
    }
  })
})

describe('GET /api/v1/budgets/snapshot — source properties', () => {
  const route = read('app/api/v1/budgets/snapshot/route.ts')

  it('validates parameters BEFORE reading the api key, so it is not an existence oracle', () => {
    const subjectCheck = route.indexOf('name a subject')
    const keyRead = route.indexOf("req.headers.get('x-api-key')")
    expect(subjectCheck).toBeGreaterThan(-1)
    expect(keyRead).toBeGreaterThan(-1)
    expect(subjectCheck).toBeLessThan(keyRead)
  })

  it('requires a subject — there is no whole-org default', () => {
    // An implicit subject silently changes meaning the day an org-wide budget
    // is added, in the direction that withholds.
    expect(route).toContain('runId')
    expect(route).toContain('agentId')
    expect(route).toContain('projectId')
    expect(route).toContain('v1InvalidArgument')
  })

  it('REFUSES `?fields=` rather than projecting a snapshot', () => {
    // A projected snapshot is refused as malformed by the client-side gate,
    // which degrades every decision made from it to "no answer" — silently,
    // behind a 200.
    expect(route).toContain('fields projection is not supported')
    expect(route).toContain('parseFieldsParam')
  })

  it('uses the shared v1 envelope and error mapping', () => {
    expect(route).toContain('apiV1Envelope')
    expect(route).toContain('mapApiErrorV1')
    expect(route).toContain('v1UnauthorizedNoKey')
  })

  it('is on the read rate class, not a tighter one', () => {
    // The contract's affordability argument: a caller must never be
    // discouraged from asking, nor able to exhaust its ingest allowance by
    // checking whether it may ingest.
    expect(route).toMatch(/limitPerMin:\s*300/)
  })
})

describe('the two POST routes — source properties', () => {
  const trip = read('app/api/v1/budgets/trip/route.ts')
  const reset = read('app/api/v1/budgets/reset/route.ts')

  it('both authenticate and validate BEFORE refusing, so their contract is real today', () => {
    for (const [name, route] of [['trip', trip], ['reset', reset]] as const) {
      // CALL SITES, not import specifiers. Every one of these names also
      // appears in the import block at the top of the file, where the order is
      // alphabetical and says nothing about execution order — an earlier
      // version of this test compared import positions and passed regardless
      // of what the handler actually did.
      const auth = route.indexOf('return v1UnauthorizedNoKey(')
      const validate = route.indexOf('parseBudgetMutationBody(raw)')
      const refuse = route.indexOf('return v1NotImplemented(')
      expect(auth, `${name}: no auth check`).toBeGreaterThan(-1)
      expect(validate, `${name}: no body validation`).toBeGreaterThan(-1)
      expect(refuse, `${name}: no explicit refusal`).toBeGreaterThan(-1)
      expect(auth).toBeLessThan(validate)
      expect(validate).toBeLessThan(refuse)
    }
  })

  it('neither silently no-ops — a privileged mutation fails loudly or not at all', () => {
    for (const route of [trip, reset]) {
      expect(route).not.toMatch(/return\s+NextResponse\.json\(\s*\{\s*ok:\s*true/)
    }
  })

  it('both are on a write rate class far below the read route', () => {
    for (const route of [trip, reset]) {
      expect(route).toMatch(/limitPerMin:\s*30\b/)
    }
  })

  it('the refusal names what is missing and where to go instead', () => {
    for (const route of [trip, reset]) {
      expect(route).toContain('/settings/budgets')
      expect(route).toContain('carries no role')
    }
  })
})

describe('the Clerk-authed management routes reflect the permission split', () => {
  const trip = read('app/api/budgets/[budgetId]/trip/route.ts')
  const reset = read('app/api/budgets/[budgetId]/reset/route.ts')
  const section = readFileSync(
    path.join(WEB_ROOT, 'src/components/budgets/BudgetsSection.tsx'),
    'utf8',
  )

  it('both require a reason', () => {
    for (const route of [trip, reset]) {
      expect(route).toContain('parseBudgetMutationBody')
    }
  })

  it('the path id is authoritative, not the body’s', () => {
    for (const route of [trip, reset]) {
      expect(route).toContain('budgetId: params.budgetId')
    }
  })

  it('the UI offers trip to members and reset to admins only', () => {
    // The asymmetry is the risk's own: withholding costs delay, resuming costs
    // money with no ceiling. Evening it out in either direction is a defect.
    expect(section).toContain("orgRole !== 'viewer'")
    expect(section).toContain("orgRole === 'admin'")
    // A viewer must reach neither.
    expect(section).toContain('Viewers can read breaker state but cannot change it')
  })

  it('the UI explains why a member cannot reset, rather than hiding the control silently', () => {
    expect(section).toContain('restricted to administrators')
  })
})
