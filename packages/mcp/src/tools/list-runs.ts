/**
 * `afr_list_runs` — compact run rows for orientation.
 *
 * Not part of the four-tier failure path; this is the "where am I?" tool. An
 * agent debugging itself knows its own `sessionId` or `agentId` and needs the
 * `runId` to feed `afr_explain_run`. Seven scalars per row at most.
 *
 * Deliberately omitted: the `metadata` bag, `tags`, `labels`, token counters,
 * `searchText`, `modelsSeen`, `sdkVersion`. `metadata` alone is unbounded
 * caller-supplied JSON and would make row size unpredictable, which is exactly
 * what a compact list must not be.
 */
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { toListRunsResult } from '../projections.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { RunStatus } from '@agent-flight-recorder/contracts'
import type { ListRunsParams } from '@agent-flight-recorder/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Rows returned when the caller does not ask for a specific number. */
export const DEFAULT_LIMIT = 20
/** Hard ceiling on rows per call, enforced by the input schema. */
export const MAX_LIMIT = 100

// `satisfies` pins this tuple against the contracts union: adding a status
// there without adding it here becomes a typecheck failure in this package,
// rather than a filter that silently rejects a valid value at runtime.
const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out'] as const satisfies readonly RunStatus[]

const inputSchema = {
  status: z.enum(RUN_STATUSES).optional().describe('Filter by run status.'),
  agentId: z.string().min(1).optional().describe('Filter by agent.'),
  environment: z.string().min(1).optional().describe('Filter by environment (e.g. "production").'),
  sessionId: z.string().min(1).optional().describe('Filter by correlation session id.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Rows to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
  cursor: z.string().min(1).optional().describe('Opaque cursor from a previous call’s nextCursor.'),
}

/**
 * Register `afr_list_runs` on the server.
 *
 * @param server - the MCP server.
 * @param reader - the read client.
 */
export function registerListRuns(server: McpServer, reader: AfrReader): void {
  server.registerTool(
    'afr_list_runs',
    {
      title: 'List runs',
      description:
        'Compact run rows for orientation. COLUMNAR RESULT: {fields, rows} — each row is positional; look a column ' +
        'up by its name in `fields`, never by a hardcoded index. Columns: runId, agentId, status, startedAt, ' +
        'endedAt, environment, sessionId (null where absent). ' +
        'Use it to find a runId, then call afr_explain_run on it. ' +
        'If you are looking for what is broken across the org rather than one run, use afr_list_failure_patterns instead — it is cheaper and better targeted.',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const filters: ListRunsParams = {
        limit: args.limit ?? DEFAULT_LIMIT,
        ...(args.status !== undefined && { status: args.status }),
        ...(args.agentId !== undefined && { agentId: args.agentId }),
        ...(args.environment !== undefined && { environment: args.environment }),
        ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
        ...(args.cursor !== undefined && { cursor: args.cursor }),
      }
      try {
        const data = await reader.listRuns(filters)
        return jsonResult(toListRunsResult(data.runs, data.nextCursor))
      } catch (err) {
        throw toMcpError(err, 'run')
      }
    },
  )
}
