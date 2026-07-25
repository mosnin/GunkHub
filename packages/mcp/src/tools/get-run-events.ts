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
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { fetchEventWindow } from '../events-window.js'
import { budgetEventRows, PROVENANCE_NOTE, TRUNCATION_NOTE } from '../projections.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Events returned when the caller does not ask for a specific number. */
export const DEFAULT_LIMIT = 20
/** Hard ceiling on events per call. Enforced by the input schema — requests above it are rejected, not clamped. */
export const MAX_LIMIT = 50

/**
 * Hard ceiling on events per call WHEN `includeProvenance` is set.
 *
 * WHY A SECOND, LOWER CEILING. Measured against the contract-maximal fixture, a
 * full `OtelEventProvenance` projects to 499 B — not the ~230 B a record with
 * one loss reason costs, because `lossReasons` is a closed union of EIGHT and a
 * maximal record carries all of them. Fifty of those on top of a saturated
 * window measures ~10,857 tokens, which is OVER this tier's published 10,000
 * ceiling. The ceiling is the product claim, so it does not move; the request
 * that cannot be served under it is the thing that gives.
 *
 * WHY REJECT AND NOT TRUNCATE. Two cheaper-looking options were rejected:
 *
 *   - Byte-budgeting the provenance records the way
 *     `WINDOW_PAYLOAD_BYTE_BUDGET` budgets payloads would return HALF a
 *     correlation key on the events past the budget. A trace id without its
 *     span id is not a partial answer, it is a wrong one — and the only reason
 *     to pay for this data at all is to go look the span up.
 *   - Silently clamping `limit` to fit is the exact failure rule 1 of this
 *     module forbids: a caller that asked for 50 and got 40 without being told
 *     believes it has seen the window it asked for.
 *
 * So a caller that wants 50 events WITH full provenance makes two calls and
 * knows it made two calls.
 *
 * WHY 40. The largest round number whose worst case stays comfortably under the
 * ceiling: 8,717 tokens for a saturated externalized window (87%), 8,652 for a
 * saturated inline one. 45 also fits (9,787 / 9,495) but at 98%, which leaves
 * no room for the next field added to `OtelEventProvenance` — and a ceiling
 * that a single contracts change breaks is a ceiling that gets raised.
 */
export const MAX_LIMIT_WITH_PROVENANCE = 40

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
  includeProvenance: z
    .boolean()
    .optional()
    .describe(
      'Return the FULL provenance record (OTel trace id, span id, span name, instrumentation scope, semconv and ' +
        'mapper versions, loss reasons) on every event that has one. Default false, and it costs up to ~500 B ' +
        'PER EVENT — ~20 KB across a window. You do NOT need it to know an event is derived or that ' +
        'its mapping was lossy: every row always carries derived:"otel" and derivedLossy:true for that. Ask for ' +
        'this only when you are correlating these events against your own OpenTelemetry backend, or diagnosing a ' +
        `specific mapping. Caps limit at ${String(MAX_LIMIT_WITH_PROVENANCE)} — a larger limit with this set is ` +
        'REJECTED, not clamped.',
    ),
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
        'THE EXPENSIVE LAST RESORT — roughly 4 400 tokens for a full window of OTel-derived events (about 8 700 ' +
        'with includeProvenance:true, which is why that path caps the window lower), about 37x afr_explain_run ' +
        'and 10x afr_triage. Answers "show me the actual events" for one run, as a WINDOW of its log, never the whole run. ' +
        'DO NOT REACH FOR THIS FIRST. If you are asking what is broken, afr_triage answers it for ~400 tokens. If ' +
        'you are asking why a run failed, afr_explain_run answers it for ~121 and tells you which sequence numbers ' +
        'to ask for here. Those two answer the question for a fraction of the cost in the large majority of cases; ' +
        'come here only when you specifically need the raw payloads they cite. ' +
        `Max ${MAX_LIMIT} events per call (default ${DEFAULT_LIMIT}); a larger limit is REJECTED, not clamped. ` +
        'Pass one of afr_explain_run’s citedSequenceNumbers as aroundSequence to centre the window on what matters ' +
        'instead of paging from the start. ' +
        'Externalized (>10 KB) payloads are returned as an artifact pointer with a checksum — never inlined; large ' +
        'inline payloads are replaced by a labelled {truncated,bytes,preview}. Page forward with nextFromSequence. ' +
        'An event DERIVED from an OpenTelemetry span rather than recorded first-party carries derived:"otel", plus ' +
        'derivedLossy:true when the mapping dropped information — treat those payloads as an interpretation, and ' +
        'note that on a derived run sequenceNumber is ingest order, not necessarily temporal order.',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const limit = args.limit ?? DEFAULT_LIMIT
      const includeProvenance = args.includeProvenance ?? false
      // REJECTED, NOT CLAMPED — see MAX_LIMIT_WITH_PROVENANCE. Silently
      // returning 40 of 50 would let a caller believe it had seen the window it
      // asked for, which is the same defect rule 1 of this module exists to
      // prevent for MAX_LIMIT.
      if (includeProvenance && limit > MAX_LIMIT_WITH_PROVENANCE) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `limit ${String(limit)} is above ${String(MAX_LIMIT_WITH_PROVENANCE)}, the maximum when ` +
            'includeProvenance is set: a full OpenTelemetry provenance record is ~500 B, and a larger window with ' +
            'one on every event exceeds this tool’s token budget. Either request at most ' +
            `${String(MAX_LIMIT_WITH_PROVENANCE)} events with provenance, or drop includeProvenance — every event ` +
            'still carries derived:"otel" and derivedLossy:true without it.',
        )
      }
      const start = resolveStart(limit, args.aroundSequence, args.fromSequence)
      try {
        const window = await fetchEventWindow(reader, args.runId, start, limit)
        const { rows, truncated, derived } = budgetEventRows(window.events, { includeProvenance })
        return jsonResult({
          runId: args.runId,
          fromSequence: start,
          events: rows,
          ...(window.nextFromSequence !== undefined && { nextFromSequence: window.nextFromSequence }),
          ...(truncated && { truncationNote: TRUNCATION_NOTE }),
          // Once per window, and only when the window contains a derived event
          // — the same rule truncationNote follows. A native window pays zero.
          ...(derived && { provenanceNote: PROVENANCE_NOTE }),
        })
      } catch (err) {
        throw toMcpError(err, 'run')
      }
    },
  )
}
