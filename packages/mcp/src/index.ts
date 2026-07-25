/**
 * `afr-mcp` — the Agent Flight Recorder MCP server, over stdio.
 *
 * stdio is the standard transport for a locally-spawned MCP server (Claude
 * Desktop, Claude Code, Cursor). An MCP client launches this binary and speaks
 * JSON-RPC over its stdin/stdout, which is why NOTHING may ever be written to
 * stdout except protocol frames — every diagnostic here goes to stderr.
 *
 * Configure it in an MCP client like this:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "agent-flight-recorder": {
 *       "command": "afr-mcp",
 *       "env": {
 *         "AFR_BASE_URL": "https://afr.example.com",
 *         "AFR_API_KEY": "afr_..."
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * STARTUP VALIDATION: if either variable is missing we print the message and
 * exit non-zero rather than starting. A server that accepts the handshake and
 * then fails every single tool call is worse than one that never starts — the
 * client shows it as connected, and the failure surfaces as a tool error the
 * model tries to work around instead of as a configuration problem the human
 * can fix.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { MissingEnvError, readEnv, resolveConfig } from './env.js'
import { createReader } from './reader.js'
import { createServer } from './server.js'
import { MCP_VERSION } from './version.js'

export { createServer, SERVER_NAME } from './server.js'
export { createReader } from './reader.js'
export type { AfrReader } from './reader.js'
export { readEnv, resolveConfig, MISSING_ENV_MESSAGE, MissingEnvError } from './env.js'
export type { McpConfig, McpEnv } from './env.js'
export { MCP_VERSION } from './version.js'
export * from './projections.js'

/**
 * Boot the server on stdio. Resolves only when the transport closes.
 *
 * @throws {@link MissingEnvError} when `AFR_API_KEY` / `AFR_BASE_URL` are not both set.
 */
export async function main(): Promise<void> {
  const config = resolveConfig(readEnv())
  const server = createServer(createReader(config), MCP_VERSION)
  await server.connect(new StdioServerTransport())
}

// Only run when this module is the process entry point, so importing the
// package (for tests, or to embed `createServer` in another host) never starts
// a server. Same check as `packages/cli/src/index.ts`.
const isMainModule =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`

if (isMainModule) {
  main().catch((err: unknown) => {
    if (err instanceof MissingEnvError) {
      process.stderr.write(`afr-mcp: ${err.message}\n`)
      process.exit(1)
    }
    process.stderr.write(`afr-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
