/**
 * CLI configuration read from the process environment.
 *
 * NOTE: reading `process.env` here is intentional and CLI-specific — the SDK
 * itself never reads `process.env` (`packages/sdk` takes all config
 * explicitly via `RecorderConfig`). A CLI is a different contract: engineers
 * configure shell tools via environment variables as a matter of course, and
 * `AFR_API_KEY`/`AFR_BASE_URL` are how `afr` authenticates against a
 * deployment without requiring a config file or repeated flags.
 */
export interface CliEnv {
  apiKey?: string
  baseUrl?: string
}

/**
 * Read `AFR_API_KEY` / `AFR_BASE_URL` from the given environment map.
 *
 * @param env - defaults to `process.env`; tests pass a plain object instead.
 */
export function readEnv(env: Record<string, string | undefined> = process.env): CliEnv {
  const result: CliEnv = {}
  if (env['AFR_API_KEY']) result.apiKey = env['AFR_API_KEY']
  if (env['AFR_BASE_URL']) result.baseUrl = env['AFR_BASE_URL']
  return result
}
