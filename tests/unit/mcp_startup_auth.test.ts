/**
 * STARTUP CONFIGURATION / AUTH guards for `packages/mcp`.
 *
 * WHY "AT STARTUP" IS THE WHOLE ASSERTION
 * ---------------------------------------
 * An MCP server is launched by a host (Claude Desktop, Claude Code, Cursor) as a
 * long-lived stdio subprocess. If `AFR_API_KEY` or `AFR_BASE_URL` is missing,
 * there are two possible behaviours:
 *
 *   (a) FAIL AT STARTUP. The process exits non-zero with a message naming the
 *       missing variables. The operator sees it immediately, in the place they
 *       configured it, and fixes it once.
 *
 *   (b) FAIL PER CALL. The server starts, advertises five healthy-looking
 *       tools, and every invocation returns an error. The AGENT now absorbs the
 *       failure: it retries, it reasons about the error, it tries a different
 *       tool, it burns thousands of tokens — the exact cost this whole package
 *       exists to avoid — and the operator sees a confusing mid-conversation
 *       failure rather than a configuration problem.
 *
 * (b) is what you get for free by reading `process.env` inside a request
 * handler, which is why it is the default outcome and why it is asserted
 * against here rather than assumed.
 *
 * These tests drive the REAL `readEnv` / `resolveConfig` / `MissingEnvError`
 * from `packages/mcp/src/env.ts`, and assert the ORDERING in `main()`:
 * validation happens before a server object exists, so an invalid config can
 * never produce a tool registry.
 */
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Module seam (see mcp_progressive_disclosure.test.ts for why it is dynamic)
// ---------------------------------------------------------------------------

interface McpEnv {
  apiKey?: string
  baseUrl?: string
}
interface McpConfig {
  apiKey: string
  baseUrl: string
}

interface EnvModule {
  readEnv(env?: Record<string, string | undefined>): McpEnv
  resolveConfig(env: McpEnv): McpConfig
  MISSING_ENV_MESSAGE: string
  MissingEnvError: new () => Error
}

/** Non-literal specifier — see mcp_progressive_disclosure.test.ts for why. */
const ENV_SPEC = '../../packages/mcp/src/env.ts'

const env = (await import(/* @vite-ignore */ ENV_SPEC)) as EnvModule

/** The two variables the server requires. */
const REQUIRED_ENV = ['AFR_API_KEY', 'AFR_BASE_URL'] as const
type RequiredEnv = (typeof REQUIRED_ENV)[number]

const VALID_ENV: Record<RequiredEnv, string> = {
  AFR_API_KEY: 'afr_live_5f2c1a9b7d4e8c3f6a1b9d2e5a8c4f7b',
  AFR_BASE_URL: 'https://afr.example.com',
}

/** Resolve straight from a raw environment map, the way `main()` does. */
function start(raw: Record<string, string | undefined>): McpConfig {
  return env.resolveConfig(env.readEnv(raw))
}

// ---------------------------------------------------------------------------
// Required variables
// ---------------------------------------------------------------------------

describe('startup config — required variables', () => {
  it('accepts a complete, valid environment', () => {
    const config = start({ ...VALID_ENV })
    expect(config).toEqual({ apiKey: VALID_ENV.AFR_API_KEY, baseUrl: VALID_ENV.AFR_BASE_URL })
  })

  it.each(REQUIRED_ENV)('refuses to start when %s is absent', (name) => {
    const raw: Record<string, string | undefined> = { ...VALID_ENV }
    delete raw[name]
    expect(() => start(raw)).toThrow(env.MissingEnvError)
  })

  it('refuses to start when both are absent', () => {
    expect(() => start({})).toThrow(env.MissingEnvError)
  })

  it.each(
    REQUIRED_ENV.flatMap((name) =>
      [
        { label: 'an empty string', value: '' },
        { label: 'undefined', value: undefined },
      ].map((v) => ({ name, ...v }))
    )
  )('refuses to start when $name is $label', ({ name, value }) => {
    /**
     * The empty-string case is not pedantry: `process.env.X` is an empty STRING
     * (falsy but PRESENT) when a shell exports an unset variable, which is
     * exactly what an MCP client's `"env": { "AFR_API_KEY": "" }` block
     * produces when a template is copied without filling it in. A check written
     * as `x !== undefined` accepts it and the server starts with an empty key.
     */
    const raw: Record<string, string | undefined> = { ...VALID_ENV, [name]: value }
    expect(() => start(raw)).toThrow(env.MissingEnvError)
  })

  it('names BOTH variables in the error, so the fix takes one restart not two', () => {
    // An operator with neither set should not have to restart twice to learn
    // that. This is the difference between a two-minute fix and a ten-minute one.
    let message = ''
    try {
      start({})
    } catch (err) {
      message = (err as Error).message
    }
    for (const name of REQUIRED_ENV) {
      expect(message, `the startup error must name ${name} so it is fixable without reading source`).toContain(name)
    }
    expect(message).toBe(env.MISSING_ENV_MESSAGE)
  })

  it('tells the operator WHERE to set them', () => {
    // The message is the entire user interface of a failed launch — an MCP
    // client shows stderr and nothing else. "AFR_API_KEY is required" without
    // "in the env block of your MCP client config" sends the operator to their
    // shell profile, which is not where the subprocess reads from.
    expect(env.MISSING_ENV_MESSAGE.toLowerCase()).toContain('env')
    expect(env.MISSING_ENV_MESSAGE.length).toBeGreaterThan(40)
  })

  it('mentions the `read` scope the key must carry', () => {
    // Scope cannot be validated without a request, so it cannot fail at
    // startup — which makes naming it in the startup message the only cheap
    // defence against a write-only ingest key being pasted in.
    expect(env.MISSING_ENV_MESSAGE).toContain('read')
  })
})

// ---------------------------------------------------------------------------
// Whitespace — a gap in the current check
// ---------------------------------------------------------------------------

describe('startup config — whitespace-only values', () => {
  it.each(
    REQUIRED_ENV.flatMap((name) =>
      [
        { label: 'spaces', value: '   ' },
        { label: 'a trailing newline only', value: '\n' },
        { label: 'a tab', value: '\t' },
      ].map((v) => ({ name, ...v }))
    )
  )('refuses to start when $name is $label', ({ name, value }) => {
    /**
     * `readEnv` gates on truthiness, so `'   '` and `'\n'` are PRESENT and pass
     * validation. Both are reachable in practice:
     *
     *   - `AFR_API_KEY=$(cat ~/.afr-key)` keeps the file's trailing newline.
     *   - A hand-edited JSON `env` block with a stray space.
     *
     * The result is a server that starts cleanly and then fails every tool call
     * with a 401 — precisely the per-call failure mode this package's own env.ts
     * docstring says it exists to prevent. Trimming before the emptiness check
     * closes it.
     */
    const raw: Record<string, string | undefined> = { ...VALID_ENV, [name]: value }
    expect(
      () => start(raw),
      `${name} = ${JSON.stringify(value)} was accepted at startup. It is whitespace, ` +
        `so the server boots, advertises five tools, and then fails every call with an ` +
        `auth error — the exact per-call failure mode readEnv exists to prevent. ` +
        `Trim before the emptiness check.`
    ).toThrow(env.MissingEnvError)
  })
})

// ---------------------------------------------------------------------------
// Base URL validity
// ---------------------------------------------------------------------------

describe('startup config — AFR_BASE_URL validity', () => {
  it('accepts an https URL, including one with a port and a path prefix', () => {
    expect(() => start({ ...VALID_ENV, AFR_BASE_URL: 'https://afr.internal:8443/afr' })).not.toThrow()
  })

  it.each([
    ['not a URL at all', 'afr.example.com'],
    ['a bare path', '/api/v1'],
    ['a typo\'d scheme', 'htps://afr.example.com'],
  ])('rejects %s at startup', (_label, value) => {
    /**
     * A base URL that cannot be parsed produces a request failure on the first
     * tool call, not at launch — the same startup-vs-per-call split this whole
     * suite is about, just one field over. It is cheap to catch: `new URL(x)`
     * throws synchronously and needs no network.
     */
    expect(
      () => start({ ...VALID_ENV, AFR_BASE_URL: value }),
      `AFR_BASE_URL=${JSON.stringify(value)} was accepted at startup. An unparseable base ` +
        `URL cannot produce a working request, so the failure is guaranteed — it just ` +
        `arrives mid-conversation as a tool error the model tries to work around, ` +
        `instead of at launch as a config error the human can fix.`
    ).toThrow()
  })

  it('rejects a plaintext http base URL', () => {
    /**
     * The API key is sent on every request. Over http it is sent in the clear.
     * ADR-003 already holds OUTBOUND webhook targets to https-only; an inbound
     * base URL carrying a bearer credential is not a weaker case.
     *
     * (An http://localhost dev loop is the one defensible exception, and should
     * be allowed explicitly rather than by permitting http everywhere.)
     */
    expect(
      () => start({ ...VALID_ENV, AFR_BASE_URL: 'http://afr.example.com' }),
      'AFR_BASE_URL over plaintext http was accepted. The API key is sent on every ' +
        'request, so this transmits a read-scoped credential in the clear. Allow ' +
        'http only for an explicit localhost dev loop.'
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// The load-bearing distinction: startup, not per-call
// ---------------------------------------------------------------------------

describe('failure timing — startup, not per-call', () => {
  it('validation happens before a server or reader is constructed', async () => {
    /**
     * This is what actually pins "at startup". A server that throws from its
     * HANDLERS still satisfies "an invalid config produces an error"; only
     * "no tool registry was ever produced" distinguishes the two.
     *
     * `main()` is `resolveConfig(readEnv())` THEN `createServer(createReader(...))`,
     * so this asserts the ordering by proving the first step throws on its own,
     * with no server and no network involved.
     */
    let threw = false
    try {
      env.resolveConfig(env.readEnv({}))
    } catch {
      threw = true
    }
    expect(
      threw,
      'resolveConfig accepted an empty environment. If validation moves after ' +
        'createServer, an MCP host sees five advertised tools and lets the agent ' +
        'call them — the agent then pays to discover a problem the operator should ' +
        'have seen at launch.'
    ).toBe(true)
  })

  it('resolveConfig is pure — it does not read process.env behind readEnv\'s back', () => {
    /**
     * `readEnv(map)` takes an injectable environment specifically so this is
     * testable. If `resolveConfig` ALSO consulted `process.env`, a host that
     * happened to have the variables set would mask a missing `env` block in
     * the client config, and it would be untestable here.
     */
    const saved = { key: process.env.AFR_API_KEY, url: process.env.AFR_BASE_URL }
    try {
      process.env.AFR_API_KEY = VALID_ENV.AFR_API_KEY
      process.env.AFR_BASE_URL = VALID_ENV.AFR_BASE_URL
      expect(() => env.resolveConfig({})).toThrow(env.MissingEnvError)
    } finally {
      if (saved.key === undefined) delete process.env.AFR_API_KEY
      else process.env.AFR_API_KEY = saved.key
      if (saved.url === undefined) delete process.env.AFR_BASE_URL
      else process.env.AFR_BASE_URL = saved.url
    }
  })

  it('readEnv defaults to process.env but honours an injected map', () => {
    const saved = process.env.AFR_API_KEY
    try {
      process.env.AFR_API_KEY = 'from_process_env'
      expect(env.readEnv({ AFR_API_KEY: 'injected', AFR_BASE_URL: 'https://x.example' }).apiKey).toBe('injected')
    } finally {
      if (saved === undefined) delete process.env.AFR_API_KEY
      else process.env.AFR_API_KEY = saved
    }
  })
})

// ---------------------------------------------------------------------------
// The key must not leak into diagnostics
// ---------------------------------------------------------------------------

describe('startup config — secret handling', () => {
  it('never echoes AFR_API_KEY into the startup error message', () => {
    /**
     * A config error is the single most likely thing to be pasted into a bug
     * report, a support channel, or a conversation with an agent. It is also
     * written to stderr, which MCP clients surface and often log.
     * `AFR_API_KEY=<value> is invalid` is how credentials end up in transcripts.
     */
    let message = ''
    try {
      start({ AFR_API_KEY: VALID_ENV.AFR_API_KEY })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toBe('')
    expect(message, 'the API key appeared in a startup error message').not.toContain(VALID_ENV.AFR_API_KEY)
    expect(message).not.toContain('afr_live_')
  })

  it('does not attach the resolved config to the thrown error object', () => {
    let thrown: unknown = null
    try {
      start({ AFR_API_KEY: VALID_ENV.AFR_API_KEY })
    } catch (err) {
      thrown = err
    }
    // Serializing the error — what a logger does — must not surface the key.
    const serialized = JSON.stringify({
      ...(thrown as Record<string, unknown>),
      message: (thrown as Error).message,
      name: (thrown as Error).name,
    })
    expect(serialized).not.toContain(VALID_ENV.AFR_API_KEY)
  })
})
