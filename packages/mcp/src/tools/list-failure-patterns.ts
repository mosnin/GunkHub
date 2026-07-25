/**
 * Tier 1 — `afr_list_failure_patterns`.
 *
 * The cheapest question in the product: "what is currently broken?" One row per
 * recurring failure fingerprint, ~25 tokens each, carrying the
 * `fingerprintHash` that buys tier 2.
 *
 * What this tool deliberately does NOT return: representative run ids, event
 * payloads, spike detail (`recentCount`/`baselineMean`/`z`), trends, agent
 * version lists, mute state, or resolution notes. Every one of those is
 * available a tier down, for the one pattern the caller actually chose.
 */
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { withFieldProjection } from '../field-projection.js'
import { PATTERN_REQUEST_FIELDS, toListPatternsResult } from '../projections.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { ListFailurePatternsParams } from '@agent-flight-recorder/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Rows returned when the caller does not ask for a specific number. */
export const DEFAULT_LIMIT = 20
/** Hard ceiling on rows per call, enforced by the input schema. */
export const MAX_LIMIT = 100

const inputSchema = {
  agentId: z.string().min(1).optional().describe('Only patterns seen on this agent.'),
  state: z
    .enum(['unproven', 'proving', 'confirmed', 'regressed'])
    .optional()
    .describe(
      'Fix-confidence state — what the EVIDENCE supports. Prefer state:"regressed" over regressed:true for CI gates: it matches only a recurrence after the current resolution.',
    ),
  status: z
    .enum(['open', 'acknowledged', 'resolved'])
    .optional()
    .describe('Lifecycle status — what a human ASSERTED. A pattern with no status set counts as "open".'),
  spiking: z.boolean().optional().describe('Only patterns whose most recent spike assessment flagged them as spiking.'),
  regressed: z
    .boolean()
    .optional()
    .describe('Only patterns with regressedAt set. Includes regressions that predate the current resolution.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Rows to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
  cursor: z.string().min(1).optional().describe('Opaque cursor from a previous call’s nextCursor.'),
}

/**
 * Register `afr_list_failure_patterns` on the server.
 *
 * @param server - the MCP server.
 * @param reader - the read client.
 */
export function registerListFailurePatterns(server: McpServer, reader: AfrReader): void {
  server.registerTool(
    'afr_list_failure_patterns',
    {
      title: 'List failure patterns',
      description:
        'Answers "what is broken, in full?" — every recurring failure fingerprint for your org, most-recently-seen ' +
        `first, ~28 tokens per row (~284 for the default ${String(DEFAULT_LIMIT)}). ` +
        'COLUMNAR RESULT: {fields, rows} — each row is positional; look a column up by its name in `fields`, never ' +
        'by a hardcoded index. Columns: fingerprintHash, class, label, count, lastSeenAt, status, confidenceState, ' +
        'confidenceStale (null where absent). ' +
        'IF "scanTruncated" IS PRESENT, AN EMPTY OR SHORT RESULT IS NOT EVIDENCE THAT NOTHING MATCHED — the ' +
        'server stopped on its row ceiling. Follow nextCursor until a page comes back without it, or report the ' +
        'question as unanswered. ' +
        'Then: afr_get_pattern_evidence(fingerprintHash) for "did the fix hold?", or afr_explain_run(runId) for a single run. ' +
        'NOT for: your first call, or "what should I look at first?" — afr_triage costs about the same, ranks the ' +
        'results, and hands you the next tool and arguments per item. Reach for this when you need BREADTH past ' +
        'triage’s top 5, or a specific filter (state/status/spiking/regressed), or paging.',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const filters: ListFailurePatternsParams = {
        limit: args.limit ?? DEFAULT_LIMIT,
        ...(args.agentId !== undefined && { agentId: args.agentId }),
        ...(args.state !== undefined && { state: args.state }),
        ...(args.status !== undefined && { status: args.status }),
        ...(args.spiking !== undefined && { spiking: args.spiking }),
        ...(args.regressed !== undefined && { regressed: args.regressed }),
        ...(args.cursor !== undefined && { cursor: args.cursor }),
      }
      try {
        // Ask the server for exactly the columns this tool emits.
        // PATTERN_REQUEST_FIELDS is DERIVED from the same column table the
        // columnar header comes from, so the request cannot drift from what is
        // projected below.
        //
        // The client-side projection still runs, and still matters:
        // `confidenceState`/`confidenceStale` are joined from the response's
        // `fixConfidence` envelope rather than the pattern document, and a
        // deployment without `?fields=` returns full patterns (see
        // `withFieldProjection`). It is defense in depth, not leftovers.
        const data = await withFieldProjection(PATTERN_REQUEST_FIELDS, (fields) =>
          reader.getFailurePatterns({ ...filters, ...(fields !== undefined && { fields }) }),
        )
        // `data` is passed as the scan-marker source, not destructured into a
        // boolean here: what an ABSENT `scanTruncated` means is decided in one
        // place (the SDK's `isPatternScanComplete`), and re-deciding it at
        // every call site is how three layers end up disagreeing.
        return jsonResult(toListPatternsResult(data.patterns, data.fixConfidence, data.nextCursor, data))
      } catch (err) {
        throw toMcpError(err, 'pattern')
      }
    },
  )
}
