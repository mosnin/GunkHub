/**
 * TENANCY / EXISTENCE-ORACLE guards for `packages/mcp`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CLAUDE.md § Tenancy Rules: "If a query for org A could ever return a record
 * belonging to org B, it is a security defect." The MCP server is a NEW read
 * surface over that data, reached by an agent holding an API key, and every new
 * read surface re-opens the question independently.
 *
 * The subtle failure here is not "org B's data came back". It is the EXISTENCE
 * ORACLE: a caller in org A asks for a fingerprint belonging to org B and gets a
 * response distinguishable — by shape, by error code, or by message wording —
 * from asking for a fingerprint that does not exist anywhere. That difference IS
 * the leak: it lets an attacker enumerate other tenants' fingerprint hashes and
 * run ids without ever reading a record.
 *
 * This repository closed 25 such oracles in one day. This file exists so a 26th
 * does not enter through the MCP surface.
 *
 * WHERE THE DECISION ACTUALLY LIVES
 * ---------------------------------
 * `packages/mcp/src/errors.ts`. Both "unknown id" and "another org's id" arrive
 * from the v1 read API as a `V1ApiError` of kind `not_found`, and `toMcpError`
 * chooses what the agent sees. Its contract is that the `not_found` sentence is
 * selected by RESOURCE KIND and nothing else — never the id, never the server's
 * own message. That last clause is load-bearing and is the thing most likely to
 * be "improved" later: forwarding `err.message` for a better developer
 * experience is a one-line change that reintroduces the oracle the moment any
 * upstream layer's wording diverges between the two cases.
 *
 * THE ASSERTION TECHNIQUE
 * -----------------------
 * `expect(result).toBeNull()` on both branches is NOT sufficient — it passes
 * when one branch returns null and the other THROWS, and it passes when one
 * throws "not found" and the other throws "forbidden". Both are oracles.
 *
 * So every call is captured as a total value:
 *
 *     { ok: true, value: unknown } | { ok: false, error: { name, message, code } }
 *
 * and the two captures are compared with `toEqual`. A version that returns a
 * record for one input and null for the other fails. A version that returns null
 * for one and throws for the other fails. A version that throws
 * `PATTERN_NOT_FOUND` for one and `FORBIDDEN` for the other fails. There is no
 * way to be accidentally green.
 */
import { V1ApiError } from '@agent-flight-recorder/sdk'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Module seam (see mcp_progressive_disclosure.test.ts for why it is dynamic)
// ---------------------------------------------------------------------------

interface McpErrorLike extends Error {
  code: number
}

interface ErrorsModule {
  toMcpError(err: unknown, kind: 'run' | 'pattern'): McpErrorLike
}

/** Non-literal specifier — see mcp_progressive_disclosure.test.ts for why. */
const ERRORS_SPEC = '../../packages/mcp/src/errors.ts'

const errors = (await import(/* @vite-ignore */ ERRORS_SPEC)) as ErrorsModule

// ---------------------------------------------------------------------------
// Total-result capture
// ---------------------------------------------------------------------------

type Capture = { ok: true; value: unknown } | { ok: false; error: { name: string; message: string; code: unknown } }

/**
 * Runs `fn` and reduces BOTH outcomes to one comparable value.
 *
 * The error branch captures `name`, `message` AND `code`. Message wording is
 * included deliberately: "Pattern not found" vs "Pattern belongs to another
 * organization" is exactly the oracle this file exists to catch, and a
 * name/code-only comparison would wave it straight through.
 *
 * Stack traces are excluded — they legitimately differ between two calls to the
 * same function and would make the comparison vacuously unequal.
 */
async function capture(fn: () => unknown): Promise<Capture> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    const e = err as { name?: string; message?: string; code?: unknown }
    return { ok: false, error: { name: e?.name ?? 'Error', message: e?.message ?? String(err), code: e?.code } }
  }
}

/** Reduce a RETURNED McpError (toMcpError returns rather than throws) the same way. */
function captureError(e: McpErrorLike): Capture {
  return { ok: false, error: { name: e.name, message: e.message, code: e.code } }
}

/**
 * The core assertion. Deep-equal, with a failure message that names the security
 * consequence rather than just printing a diff — a tenancy failure that reads
 * like a snapshot mismatch gets "fixed" by updating the expectation.
 */
function expectIndistinguishable(unknownResult: Capture, crossOrgResult: Capture, surface: string): void {
  expect(
    crossOrgResult,
    `EXISTENCE ORACLE on ${surface}.\n\n` +
      `  Asking for an id that does not exist ANYWHERE and asking for an id that\n` +
      `  exists in ANOTHER ORG produced different results:\n\n` +
      `    unknown id   -> ${JSON.stringify(unknownResult)}\n` +
      `    cross-org id -> ${JSON.stringify(crossOrgResult)}\n\n` +
      `  That difference is the leak. It lets a caller enumerate other tenants'\n` +
      `  fingerprint hashes and run ids without reading a single record.\n` +
      `  CLAUDE.md § Tenancy Rules 2-3. The cross-org path must return the SAME\n` +
      `  not-found result, never a distinct "forbidden".`
  ).toEqual(unknownResult)
}

// ---------------------------------------------------------------------------
// How the two cases arrive from the v1 API
// ---------------------------------------------------------------------------

const CROSS_ORG_FINGERPRINT = '99aaaaaaaaaaaa'
const UNKNOWN_FINGERPRINT = 'deadbeefdeadbe'
const CROSS_ORG_RUN = 'run_other_001'
const UNKNOWN_RUN = 'run_nonexistent'

/**
 * The upstream is careful today (`convex/read_api.ts` throws one message for
 * both cases), so a faithful stub sends the same `V1ApiError` for both. But
 * `toMcpError` must be robust to that changing — an upstream that starts
 * distinguishing them is a REGRESSION THIS LAYER SHOULD ABSORB, not propagate.
 * So the divergent variants below are the interesting ones.
 */
function notFound(message: string, code?: string): V1ApiError {
  return new V1ApiError('not_found', message, { status: 404, ...(code !== undefined && { code }) })
}

describe('toMcpError — unknown vs cross-org are indistinguishable', () => {
  it('produces a byte-identical error for an unknown and a cross-org fingerprint', () => {
    const unknown = captureError(errors.toMcpError(notFound(`No pattern ${UNKNOWN_FINGERPRINT}`), 'pattern'))
    const crossOrg = captureError(errors.toMcpError(notFound(`No pattern ${CROSS_ORG_FINGERPRINT}`), 'pattern'))
    expectIndistinguishable(unknown, crossOrg, 'afr_get_pattern_evidence')
  })

  it('produces a byte-identical error for an unknown and a cross-org runId', () => {
    const unknown = captureError(errors.toMcpError(notFound(`No run ${UNKNOWN_RUN}`), 'run'))
    const crossOrg = captureError(errors.toMcpError(notFound(`No run ${CROSS_ORG_RUN}`), 'run'))
    expectIndistinguishable(unknown, crossOrg, 'afr_explain_run / afr_get_run_events')
  })

  it('ABSORBS an upstream that starts distinguishing the two cases', () => {
    /**
     * THE REGRESSION THIS LAYER IS FOR. If `convex/read_api.ts` or the v1 route
     * ever starts returning "belongs to another organization" — a change that
     * would look like a helpfulness improvement in review — this layer must
     * still flatten it. A `toMcpError` that forwards `err.message` passes every
     * other test in this file and fails only here.
     */
    const unknown = captureError(errors.toMcpError(notFound('Pattern not found'), 'pattern'))
    const crossOrg = captureError(
      errors.toMcpError(notFound('Pattern belongs to organization org_other', 'FORBIDDEN'), 'pattern')
    )
    expectIndistinguishable(unknown, crossOrg, 'toMcpError with a leaky upstream message')
  })

  it('never echoes the requested id back in the not_found message', () => {
    // Echoing the id is not itself an oracle, but it is how one gets built by
    // accident: once the id is in the string, "and it belongs to org X" is the
    // next natural addition.
    for (const [kind, id] of [
      ['pattern', CROSS_ORG_FINGERPRINT],
      ['run', CROSS_ORG_RUN],
    ] as const) {
      const err = errors.toMcpError(notFound(`No such thing: ${id}`), kind)
      expect(err.message, `the ${kind} not_found message echoed the caller's id`).not.toContain(id)
    }
  })

  it('never leaks an org identifier from an upstream message', () => {
    const err = errors.toMcpError(notFound('Record owned by org_other (clerk_org_9f2)'), 'pattern')
    expect(err.message).not.toContain('org_other')
    expect(err.message).not.toContain('clerk_org_9f2')
  })

  it('uses a fixed sentence per resource kind, and only the kind selects it', () => {
    // Same input error, different kind -> different sentence. Same kind,
    // different input error -> same sentence. That pair is the whole contract.
    const a = errors.toMcpError(notFound('anything at all'), 'pattern')
    const b = errors.toMcpError(notFound('something completely different', 'WEIRD'), 'pattern')
    expect(b.message).toBe(a.message)

    const run = errors.toMcpError(notFound('anything at all'), 'run')
    expect(run.message).not.toBe(a.message)
  })
})

describe('toMcpError — no raw errors escape', () => {
  it('never surfaces a stack trace to the agent', () => {
    // A stack trace names file paths, package versions, and internal function
    // names, and it costs hundreds of tokens the caller did not ask for.
    const boom = new TypeError("Cannot read properties of undefined (reading 'patterns')")
    const err = errors.toMcpError(boom, 'pattern')
    expect(err.message).not.toContain('at ')
    expect(err.message).not.toContain('.ts:')
    expect(err.message).not.toContain('node_modules')
  })

  it('maps auth failures to a distinct, non-retryable error', () => {
    /**
     * Auth MUST stay distinguishable from not_found — that is not an oracle,
     * it is the opposite. "Your key is invalid" and "that record is not
     * readable with your key" demand different responses from a caller, and
     * collapsing them would send an agent into a retry loop against a
     * permanently broken key.
     */
    const authErr = errors.toMcpError(new V1ApiError('auth', 'bad key', { status: 401 }), 'pattern')
    const notFoundErr = errors.toMcpError(notFound('nope'), 'pattern')
    expect(authErr.code).not.toBe(notFoundErr.code)
    expect(authErr.message).not.toBe(notFoundErr.message)
  })

  it('does not echo the API key from an auth error message', () => {
    const key = 'afr_live_5f2c1a9b7d4e8c3f6a1b9d2e5a8c4f7b'
    const err = errors.toMcpError(new V1ApiError('auth', `Invalid key ${key}`, { status: 401 }), 'pattern')
    expect(err.message, 'the API key was echoed into an error an agent will see and may log').not.toContain(key)
  })
})

// ---------------------------------------------------------------------------
// The oracle detector must be able to FAIL — prove it
// ---------------------------------------------------------------------------

describe('existence-oracle detector — self-check', () => {
  /**
   * A tenancy comparison that cannot fail is worse than no test: it is a green
   * check mark over an unexamined surface. These cases pin down that
   * `capture` + `toEqual` really does distinguish the three ways this goes
   * wrong, so the assertions above mean what they claim.
   */

  class NotFoundError extends Error {
    readonly code = 'NOT_FOUND'
    constructor(message = 'Not found') {
      super(message)
      this.name = 'NotFoundError'
    }
  }
  class ForbiddenError extends Error {
    readonly code = 'FORBIDDEN'
    constructor(message = 'Forbidden: record belongs to another organization') {
      super(message)
      this.name = 'ForbiddenError'
    }
  }

  const TABLE = [
    { orgId: 'org_caller', fingerprintHash: '01f3a9c1d4e7b2' },
    { orgId: 'org_other', fingerprintHash: CROSS_ORG_FINGERPRINT },
  ]

  /** CORRECT: filters by org FIRST, so cross-org and unknown are the same miss. */
  const correct = (orgId: string, hash: string) =>
    TABLE.find((p) => p.orgId === orgId && p.fingerprintHash === hash) ?? null

  /** LEAKY: fetch by id, THEN authorize — different error class per branch. */
  const fetchThenAuthorize = (orgId: string, hash: string) => {
    const found = TABLE.find((p) => p.fingerprintHash === hash)
    if (!found) throw new NotFoundError(`No pattern with fingerprint ${hash}`)
    if (found.orgId !== orgId) throw new ForbiddenError()
    return found
  }

  /** LEAKY, SUBTLE: same class, same code — only the wording differs. */
  const sameShapeDifferentMessage = (orgId: string, hash: string) => {
    const found = TABLE.find((p) => p.fingerprintHash === hash)
    if (!found) throw new NotFoundError('Unknown fingerprint')
    if (found.orgId !== orgId) throw new NotFoundError('Pattern is not available to this organization')
    return found
  }

  it('accepts an implementation that filters by org before lookup', async () => {
    const unknown = await capture(() => correct('org_caller', UNKNOWN_FINGERPRINT))
    const crossOrg = await capture(() => correct('org_caller', CROSS_ORG_FINGERPRINT))
    expectIndistinguishable(unknown, crossOrg, 'self-check/correct')

    // A null-for-everything implementation would also pass the check above, so
    // pin the positive case too.
    const own = await capture(() => correct('org_caller', '01f3a9c1d4e7b2'))
    expect(own.ok && own.value).toMatchObject({ fingerprintHash: '01f3a9c1d4e7b2' })
  })

  it('REJECTS fetch-then-authorize (NotFound vs Forbidden)', async () => {
    const unknown = await capture(() => fetchThenAuthorize('org_caller', UNKNOWN_FINGERPRINT))
    const crossOrg = await capture(() => fetchThenAuthorize('org_caller', CROSS_ORG_FINGERPRINT))
    expect(unknown.ok).toBe(false)
    expect(crossOrg.ok).toBe(false)
    expect(() => expectIndistinguishable(unknown, crossOrg, 'self-check')).toThrow()
  })

  it('REJECTS same-class errors that differ only in message wording', async () => {
    const unknown = await capture(() => sameShapeDifferentMessage('org_caller', UNKNOWN_FINGERPRINT))
    const crossOrg = await capture(() => sameShapeDifferentMessage('org_caller', CROSS_ORG_FINGERPRINT))

    // Same name, same code — a naive comparison would call these identical.
    expect(unknown.ok).toBe(false)
    expect(crossOrg.ok).toBe(false)
    if (!unknown.ok && !crossOrg.ok) {
      expect(crossOrg.error.name).toBe(unknown.error.name)
      expect(crossOrg.error.code).toBe(unknown.error.code)
    }
    expect(() => expectIndistinguishable(unknown, crossOrg, 'self-check')).toThrow()
  })
})
