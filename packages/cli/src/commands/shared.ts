import { ApiClientError } from '../apiClient.js'
import { readEnv } from '../env.js'

import type { ApiClientConfig } from '../apiClient.js'
import type { CliEnv } from '../env.js'

/** A command failure, carrying the exit code the CLI convention assigns to it. */
export interface CommandFailure {
  ok: false
  exitCode: number
  message: string
}

/**
 * Resolve `CliEnv` into an `ApiClientConfig`, or a `CommandFailure` (exit
 * code 1 — usage) when `AFR_API_KEY` / `AFR_BASE_URL` are not both set.
 * Every read-API command (`runs`, `replay`, `tail`, `export`) starts with this.
 */
export function resolveApiConfig(env: CliEnv): ApiClientConfig | CommandFailure {
  if (!env.apiKey || !env.baseUrl) {
    return {
      ok: false,
      exitCode: 1,
      message: 'AFR_API_KEY and AFR_BASE_URL must both be set. Run `afr config check` for details.',
    }
  }
  return { apiKey: env.apiKey, baseUrl: env.baseUrl }
}

export function isCommandFailure(value: unknown): value is CommandFailure {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok: unknown }).ok === false
}

/**
 * Turn any thrown value from an apiClient call into a `CommandFailure` —
 * `ApiClientError` maps to its own exit code/message; anything else (should
 * not normally happen, since apiClient never lets a raw error escape) maps
 * to exit code 4 with its string message.
 */
export function toCommandFailure(err: unknown): CommandFailure {
  if (err instanceof ApiClientError) {
    return { ok: false, exitCode: err.exitCode, message: err.message }
  }
  return { ok: false, exitCode: 4, message: err instanceof Error ? err.message : String(err) }
}

/** Re-exported so command modules only need one import for env defaults. */
export { readEnv }
