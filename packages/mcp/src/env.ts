/**
 * Server configuration read from the process environment.
 *
 * This mirrors `packages/cli/src/env.ts` EXACTLY — same two variables, same
 * names, same "both or neither" rule, same error sentence. An MCP server is a
 * shell-launched process just like `afr` is (an MCP client spawns it with an
 * `env` block), so it takes the same contract rather than inventing a second
 * one. `packages/sdk` still never reads `process.env`; that rule is about the
 * recording library, not about the executables built on top of it.
 *
 * The key must carry the `read` scope. A write-only ingest key is rejected by
 * the v1 read API with 403, which surfaces here as an auth error on the first
 * tool call — we cannot detect it at startup without making a request.
 */

/** The two variables the server needs. Both are required. */
export interface McpEnv {
  apiKey?: string
  baseUrl?: string
}

/** A validated, complete configuration. */
export interface McpConfig {
  apiKey: string
  baseUrl: string
}

/** The exact sentence printed on a missing/incomplete environment, naming both variables. */
export const MISSING_ENV_MESSAGE =
  'AFR_API_KEY and AFR_BASE_URL must both be set (the key needs the `read` scope). ' +
  'Set them in the `env` block of your MCP client config, or run `afr config check` to validate the pair.'

/**
 * Read `AFR_API_KEY` / `AFR_BASE_URL` from the given environment map.
 *
 * VALUES ARE TRIMMED. A variable set to `"  "` or to a trailing newline is
 * whitespace, not configuration — it comes from a heredoc, a copied secret with
 * a stray newline, or a JSON config with a padded string. Untrimmed, it is
 * truthy, so the server boots, advertises five tools, and fails every single
 * call with an auth error: exactly the per-call failure mode startup validation
 * exists to prevent. Trimming here means an all-whitespace value is simply
 * unset, and the startup check catches it.
 *
 * @param env - defaults to `process.env`; tests pass a plain object instead.
 */
export function readEnv(env: Record<string, string | undefined> = process.env): McpEnv {
  const result: McpEnv = {}
  const apiKey = env['AFR_API_KEY']?.trim()
  const baseUrl = env['AFR_BASE_URL']?.trim()
  if (apiKey) result.apiKey = apiKey
  if (baseUrl) result.baseUrl = baseUrl
  return result
}

/**
 * Thrown by {@link resolveConfig} when the environment cannot produce a working
 * client. The caller (`src/index.ts`) prints the message to stderr and exits
 * non-zero rather than starting a server whose every tool call would fail.
 *
 * The whole point of failing at startup: a guaranteed failure that arrives
 * mid-conversation reads as a tool error the model tries to work around, while
 * the same failure at launch reads as a config error the human can fix.
 */
export class MissingEnvError extends Error {
  constructor(message: string = MISSING_ENV_MESSAGE) {
    super(message)
    this.name = 'MissingEnvError'
  }
}

/** Hosts for which plaintext `http://` is an intentional dev loop rather than a leaked credential. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * Validate `AFR_BASE_URL` before any request is made.
 *
 * Three rejections, all of them guaranteed failures or guaranteed leaks:
 *
 * - **Unparseable** (`afr.example.com`, `/api/v1`, `htps://…`). `new URL()`
 *   fails, so every request would fail. Catching it at startup turns a
 *   mid-conversation mystery into a one-line config fix.
 * - **Non-HTTP scheme** (`file:`, `ftp:`). Parses fine, cannot serve the API.
 * - **Plaintext `http:` to a non-local host.** The API key is sent as a header
 *   on EVERY request, so this transmits a read-scoped credential in the clear
 *   to anyone on the path. Allowed only for localhost, where there is no path.
 */
function assertUsableBaseUrl(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new MissingEnvError(
      `AFR_BASE_URL is not a valid URL: "${baseUrl}". It must be an absolute URL including the scheme, e.g. https://afr.example.com`,
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MissingEnvError(
      `AFR_BASE_URL must use http or https, got "${url.protocol}" in "${baseUrl}".`,
    )
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new MissingEnvError(
      `AFR_BASE_URL uses plaintext http to a non-local host ("${url.hostname}"). AFR_API_KEY is sent on every ` +
        'request, so this would transmit a read-scoped credential in the clear. Use https, or point at localhost for a dev loop.',
    )
  }
}

/**
 * Turn a read environment into a complete {@link McpConfig}.
 *
 * @throws {@link MissingEnvError} when either variable is unset/whitespace, or
 *   when `AFR_BASE_URL` cannot produce a working, non-leaking request.
 */
export function resolveConfig(env: McpEnv): McpConfig {
  if (!env.apiKey || !env.baseUrl) {
    throw new MissingEnvError()
  }
  assertUsableBaseUrl(env.baseUrl)
  return { apiKey: env.apiKey, baseUrl: env.baseUrl }
}
