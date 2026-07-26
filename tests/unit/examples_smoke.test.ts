/**
 * Smoke tests for packages/sdk/examples/**.
 *
 * Every example is a real, runnable script (not just something that
 * typechecks) — these tests exercise each one end-to-end in a child process
 * (via `tsx`, the same tool the README/example headers tell users to run
 * them with), asserting a clean exit and the log output a reader would
 * expect to see. Running in a subprocess — rather than `import()`-ing the
 * example module directly into this test's process — matters here:
 * `durable_agent.ts` installs real `process.on('beforeExit'/'uncaughtException')`
 * handlers (`captureProcessExit: true`), which must not leak onto the shared
 * vitest worker process.
 *
 * None of these tests requires a live Agent Flight Recorder server: every
 * example defaults to an in-process `MockTransport` (or, for
 * `unbuffered_quickstart.ts`, prints instructions and exits cleanly) unless
 * invoked with `--live`, which these tests never pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

const repoRoot = join(__dirname, '../..')
const tsxBin = join(repoRoot, 'node_modules/.bin/tsx')
const examplesDir = join(repoRoot, 'packages/sdk/examples')

/** Run an example file with `tsx` and return its combined stdout+stderr. */
function runExample(file: string, args: string[] = []): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(tsxBin, [join(examplesDir, file), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env },
    })
    return { stdout, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; status?: number | null; message: string }
    return { stdout: e.stdout ?? e.message, status: e.status ?? 1 }
  }
}

describe('SDK examples (smoke)', () => {
  it('tsx is available at the expected path', () => {
    expect(existsSync(tsxBin)).toBe(true)
  })

  it('basic_run.ts runs end-to-end with MockTransport', () => {
    const { stdout, status } = runExample('basic_run.ts')
    expect(status).toBe(0)
    expect(stdout).toContain('Using MockTransport (no server required)')
    expect(stdout).toContain('All examples completed successfully.')
  })

  it('durable_agent.ts recovers, records, and completes the run', () => {
    const { stdout, status } = runExample('durable_agent.ts')
    expect(status).toBe(0)
    expect(stdout).toContain('Agent replied:')
    expect(stdout).toContain('Run finished with outcome: completed')
  })

  it('llm_agent_loop.ts instruments the full request/tool/response loop', () => {
    const { stdout, status } = runExample('llm_agent_loop.ts')
    expect(status).toBe(0)
    expect(stdout).toContain('type=llm.request')
    expect(stdout).toContain('type=tool.call')
    expect(stdout).toContain('type=tool.result')
    expect(stdout).toContain('Run completed: ok')
  })

  it('large_payloads.ts demonstrates automatic >10KB externalization', () => {
    const { stdout, status } = runExample('large_payloads.ts')
    expect(status).toBe(0)
    // The small event stays inline...
    expect(stdout).toMatch(/payload is \d+ bytes -> sent inline, unchanged/)
    // ...the oversized one is called out as externalization-eligible, with the
    // artifact pointer shape documented inline.
    expect(stdout).toContain('POST /api/artifacts/upload')
    expect(stdout).toContain('checksum (sha256)')
  })

  it('read_back.ts records a run then reads it back through the simulated v1 API', () => {
    const { stdout, status } = runExample('read_back.ts')
    expect(status).toBe(0)
    expect(stdout).toContain('Run started:')
    expect(stdout).toContain('using a simulated v1 API response')
    expect(stdout).toContain('apiVersion: v1')
    expect(stdout).toContain('Read-back round trip completed successfully.')
  })

  it('unbuffered_quickstart.ts prints guidance and exits cleanly without --live', () => {
    const { stdout, status } = runExample('unbuffered_quickstart.ts')
    expect(status).toBe(0)
    expect(stdout).toContain('pass --live')
  })
})
