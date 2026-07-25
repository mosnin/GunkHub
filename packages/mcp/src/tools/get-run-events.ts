/**
 * Tier 4 — `afr_get_run_events`. THE EXPENSIVE ONE.
 *
 * Returns a WINDOW of a run's event log, never a whole run. A 50-step run is
 * 100k+ tokens raw; the entire point of tiers 1-3 is that a caller arrives here
 * already knowing which three sequence numbers matter.
 *
 * Two hard rules:
 *
 * 1. THE LIMIT IS CAPPED AT {@link MAX_LIMIT} AND THE CAP IS NOT NEGOTIABLE.
 *    It is enforced by the input schema, so a request for 5000 is rejected
 *    rather than silently clamped — silently returning 50 of 5000 would let a
 *    caller believe it had seen the whole log.
 *
 * 2. ARTIFACT PAYLOADS ARE NEVER INLINED. A payload over the externalization
 *    threshold lives in blob storage; this returns the pointer and checksum
 *    only. Enforced in `toEventRow`.
 */
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { fetchEventWindow } from '../events-window.js'
import { budgetEventRows, TRUNCATION_NOTE } from '../projections.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Events returned when the caller does not ask for a specific number. */
export const DEFAULT_LIMIT = 20
/** Hard ceiling on events per call. Enforced by the input schema — requests above it are rejected, not clamped. */
export const MAX_LIMIT = 50

const inputSchema = {
  runId: z.string().min(1).describe('The run id.'),
  aroundSequence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Centre the window on this sequence number — pass one of afr_explain_run’s citedSequenceNumbers.'),
  fromSequence: z.number().int().min(1).optional().describe('Start the window at this sequence number. Ignored if aroundSequence is set.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Events to return. Default ${DEFAULT_LIMIT}, HARD MAX ${MAX_LIMIT} — a larger value is rejected, not clamped.`),
}

/**
 * Resolve the window's first sequence number.
 *
 * `aroundSequence` centres the window: half the budget before the cited event,
 * half after, clamped at 1. That is what makes a cited sequence useful — the
 * events leading UP TO a failure are usually what explain it.
 */
export function resolveStart(limit: number, aroundSequence?: number, fromSequence?: number): number {
  if (aroundSequence !== undefined) {
    return Math.max(1, aroundSequence - Math.floor(limit / 2))
  }
  return Math.max(1, fromSequence ?? 1)
}

/**
 * Register `afr_get_run_events` on the server.
 *
 * @param server - the MCP server.
 * @param reader - the read client.
 */
export function registerGetRunEvents(server: McpServer, reader: AfrReader): void {
  server.registerTool(
    'afr_get_run_events',
    {
      title: 'Get a window of run events',
      description:
        'THE EXPENSIVE LAST RESORT — roughly 3 800 tokens for a full window, about 30x afr_explain_run and 10x ' +
        'afr_triage. Answers "show me the actual events" for one run, as a WINDOW of its log, never the whole run. ' +
        'DO NOT REACH FOR THIS FIRST. If you are asking what is broken, afr_triage answers it for ~400 tokens. If ' +
        'you are asking why a run failed, afr_explain_run answers it for ~121 and tells you which sequence numbers ' +
        'to ask for here. Those two answer the question for a fraction of the cost in the large majority of cases; ' +
        'come here only when you specifically need the raw payloads they cite. ' +
        `Max ${MAX_LIMIT} events per call (default ${DEFAULT_LIMIT}); a larger limit is REJECTED, not clamped. ` +
        'Pass one of afr_explain_run’s citedSequenceNumbers as aroundSequence to centre the window on what matters ' +
        'instead of paging from the start. ' +
        'Externalized (>10 KB) payloads are returned as an artifact pointer with a checksum — never inlined; large ' +
        'inline payloads are replaced by a labelled {truncated,bytes,preview}. Page forward with nextFromSequence.',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const limit = args.limit ?? DEFAULT_LIMIT
      const start = resolveStart(limit, args.aroundSequence, args.fromSequence)
      try {
        const window = await fetchEventWindow(reader, args.runId, start, limit)
        const { rows, truncated } = budgetEventRows(window.events)
        return jsonResult({
          runId: args.runId,
          fromSequence: start,
          events: rows,
          ...(window.nextFromSequence !== undefined && { nextFromSequence: window.nextFromSequence }),
          ...(truncated && { truncationNote: TRUNCATION_NOTE }),
        })
      } catch (err) {
        throw toMcpError(err, 'run')
      }
    },
  )
}
