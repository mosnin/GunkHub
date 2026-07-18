/**
 * Dist smoke test: imports the BUILT SDK bundle (dist/index.mjs) instead of
 * the source alias used by the rest of the suite, and exercises a trivial
 * export. This validates the browser-safety claim in practice — the main
 * entry must load without any static `node:*` import (FileSpool defers its
 * `node:fs` load to a guarded dynamic import) — and catches packaging
 * regressions (broken tsup config, bad export maps) that source-aliased tests
 * can never see.
 *
 * Requires `pnpm --filter @agent-flight-recorder/sdk build` to have run
 * (turbo's `test` task depends on `^build`, so this holds in CI).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, it, expect } from 'vitest'

const distPath = join(__dirname, '../../packages/sdk/dist/index.mjs')

describe('SDK dist bundle', () => {
  it('dist/index.mjs exists (run `pnpm --filter @agent-flight-recorder/sdk build` if this fails)', () => {
    expect(existsSync(distPath)).toBe(true)
  })

  it('imports cleanly and exposes working exports', async () => {
    const sdk = (await import(/* @vite-ignore */ pathToFileURL(distPath).href)) as
      typeof import('@agent-flight-recorder/sdk')

    // Named exports only — no default export (tree-shaking / import hygiene).
    expect((sdk as Record<string, unknown>)['default']).toBeUndefined()

    expect(typeof sdk.Recorder).toBe('function')
    expect(typeof sdk.FlightRecorder).toBe('function')
    expect(typeof sdk.HttpTransport).toBe('function')
    expect(typeof sdk.FileSpool).toBe('function')
    expect(sdk.SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)

    // Call a trivial export end-to-end.
    const event = sdk.buildEvent('run_1', 'org_1', 'custom', { type: 'custom', data: 'smoke' }, 1)
    expect(event).toMatchObject({ runId: 'run_1', type: 'custom', sequenceNumber: 1 })

    const built = sdk.Events.custom({ hello: 'dist' })
    expect(built.type).toBe('custom')
  })
})
