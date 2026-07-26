import { readEnv } from '../env.js'

import type { CliEnv } from '../env.js'

/** Minimal fetch shape, injectable so tests never hit the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>

export interface ConfigCheck {
  name: string
  status: 'ok' | 'fail'
  message: string
}

export interface ConfigCheckResult {
  ok: boolean
  checks: ConfigCheck[]
}

/**
 * `afr config check` — validate `AFR_API_KEY` / `AFR_BASE_URL` are set and
 * ping `GET {AFR_BASE_URL}/api/health`.
 *
 * @param env - defaults to reading from `process.env`
 * @param fetchImpl - injectable fetch, defaults to the global `fetch`
 */
export async function runConfigCheck(
  env: CliEnv = readEnv(),
  fetchImpl: FetchLike = fetch
): Promise<ConfigCheckResult> {
  const checks: ConfigCheck[] = []

  if (env.apiKey) {
    checks.push({ name: 'AFR_API_KEY', status: 'ok', message: 'set' })
  } else {
    checks.push({ name: 'AFR_API_KEY', status: 'fail', message: 'not set — required for every command' })
  }

  if (env.baseUrl) {
    checks.push({ name: 'AFR_BASE_URL', status: 'ok', message: env.baseUrl })
  } else {
    checks.push({ name: 'AFR_BASE_URL', status: 'fail', message: 'not set — required for every command' })
  }

  if (env.baseUrl) {
    try {
      const url = `${env.baseUrl.replace(/\/$/, '')}/api/health`
      const res = await fetchImpl(url)
      if (res.ok) {
        checks.push({ name: 'GET /api/health', status: 'ok', message: `HTTP ${res.status}` })
      } else {
        checks.push({ name: 'GET /api/health', status: 'fail', message: `HTTP ${res.status}` })
      }
    } catch (err) {
      checks.push({
        name: 'GET /api/health',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  } else {
    checks.push({ name: 'GET /api/health', status: 'fail', message: 'skipped — AFR_BASE_URL not set' })
  }

  return { ok: checks.every((c) => c.status === 'ok'), checks }
}

export function printConfigCheck(result: ConfigCheckResult, log: (line: string) => void = console.log): void {
  for (const c of result.checks) {
    log(`[${c.status === 'ok' ? 'ok' : 'fail'}] ${c.name}: ${c.message}`)
  }
  log(result.ok ? '\nConfiguration OK.' : '\nConfiguration INVALID.')
}
