/**
 * Tests for `afr init` — the frictionless first-run onboarding command
 * (`packages/cli/src/commands/init.ts`). File I/O is always injected (never
 * a real filesystem) and the backend health check uses a mocked fetch.
 */
import { main, parseInitArgs, printInit, quickstartFileContents, runInit } from '@agent-flight-recorder/cli'
import { describe, expect, it, vi } from 'vitest'

import type { FetchLike } from '@agent-flight-recorder/cli'

describe('afr init — arg parsing', () => {
  it('parses --out and --force', () => {
    expect(parseInitArgs(['--out', 'demo.mjs', '--force'])).toEqual({ out: 'demo.mjs', force: true })
  })

  it('parses no args', () => {
    expect(parseInitArgs([])).toEqual({})
  })
})

describe('afr init — scaffold write', () => {
  it('writes the starter file when nothing exists yet, using the default path', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }))
    const fileExists = vi.fn(async () => false)
    const writeFile = vi.fn(async () => undefined)

    const result = await runInit({}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl, fileExists, writeFile)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.wrote).toBe(true)
      expect(result.path).toBe('afr-quickstart.mjs')
    }
    expect(writeFile).toHaveBeenCalledWith('afr-quickstart.mjs', expect.stringContaining('@agent-flight-recorder/sdk'))
    // Never touches a real filesystem.
    expect(fileExists).toHaveBeenCalledWith('afr-quickstart.mjs')
  })

  it('honors a custom --out path', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }))
    const fileExists = vi.fn(async () => false)
    const writeFile = vi.fn(async () => undefined)

    const result = await runInit(
      { out: 'my-quickstart.mjs' },
      { apiKey: 'k', baseUrl: 'http://localhost:3000' },
      fetchImpl,
      fileExists,
      writeFile
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.path).toBe('my-quickstart.mjs')
    expect(writeFile).toHaveBeenCalledWith('my-quickstart.mjs', expect.any(String))
  })

  it('never overwrites an existing file without --force', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }))
    const fileExists = vi.fn(async () => true)
    const writeFile = vi.fn(async () => undefined)

    const result = await runInit({}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl, fileExists, writeFile)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.wrote).toBe(false)
      expect(result.skippedReason).toBe('exists')
    }
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('--force overwrites an existing file', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }))
    const fileExists = vi.fn(async () => true)
    const writeFile = vi.fn(async () => undefined)

    const result = await runInit(
      { force: true },
      { apiKey: 'k', baseUrl: 'http://localhost:3000' },
      fetchImpl,
      fileExists,
      writeFile
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.wrote).toBe(true)
    expect(writeFile).toHaveBeenCalled()
    // --force skips the existence check entirely.
    expect(fileExists).not.toHaveBeenCalled()
  })

  it('still writes the scaffold even when AFR_API_KEY/AFR_BASE_URL are unset (config check just reports the gap)', async () => {
    const fileExists = vi.fn(async () => false)
    const writeFile = vi.fn(async () => undefined)

    const result = await runInit({}, {}, undefined, fileExists, writeFile)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.wrote).toBe(true)
      expect(result.exitCode).toBe(1) // config check failed -> non-zero, but the file still got written
      expect(result.configCheck.ok).toBe(false)
    }
    expect(writeFile).toHaveBeenCalled()
  })

  it('surfaces a file-write failure as a command failure', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }))
    const fileExists = vi.fn(async () => false)
    const writeFile = vi.fn(async () => {
      throw new Error('EACCES: permission denied')
    })

    const result = await runInit({}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl, fileExists, writeFile)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('EACCES')
  })

  it('the generated quickstart imports the SDK, records a demo run, and prints the run URL', () => {
    const contents = quickstartFileContents()
    expect(contents).toContain("import { Recorder, Events } from '@agent-flight-recorder/sdk'")
    expect(contents).toContain('recorder.startRun(')
    expect(contents).toContain('recorder.endRun(')
    expect(contents).toContain('View it at:')
    expect(contents).toContain('/runs/')
  })
})

describe('afr init — printInit output', () => {
  it('prints config checks, the write outcome, and next steps', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }))
    const fileExists = vi.fn(async () => false)
    const writeFile = vi.fn(async () => undefined)
    const result = await runInit({}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl, fileExists, writeFile)

    const log = vi.fn()
    printInit(result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('Wrote starter file')
    expect(output).toContain('Next steps:')
    expect(output).toContain('node afr-quickstart.mjs')
    expect(output).toContain('afr runs list')
  })

  it('tells the user to fix config first when env vars are missing', async () => {
    const fileExists = vi.fn(async () => false)
    const writeFile = vi.fn(async () => undefined)
    const result = await runInit({}, {}, undefined, fileExists, writeFile)

    const log = vi.fn()
    printInit(result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('Set AFR_API_KEY')
  })

  it('reports the skip when the file already exists', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }))
    const fileExists = vi.fn(async () => true)
    const writeFile = vi.fn(async () => undefined)
    const result = await runInit({}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl, fileExists, writeFile)

    const log = vi.fn()
    printInit(result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Skipped writing'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--force'))
  })
})

describe('afr init — dispatch', () => {
  it("'afr init --help' prints usage and exits 0", async () => {
    const log = vi.fn()
    const code = await main(['init', '--help'], log)
    expect(code).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
  })
})
