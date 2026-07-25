/**
 * `afr_triage` — THE ENTRY POINT. Tier 0, if you like.
 *
 * One call, zero required arguments, answering the question an agent actually
 * arrives with: what is wrong right now, and what should I look at first?
 *
 * The four-tier ladder below it works and is measured. What it lacked was an
 * obvious bottom rung: an agent arriving cold has no reason to start cheap, and
 * the CRUD instinct — "fetch the run" — is tier 4, ~3 838 tokens, answering
 * nothing because the agent does not yet know which run.
 *
 * THE BUDGET IS THE DESIGN CONSTRAINT. Triage is budgeted at or under tier 2
 * (450 tokens). If it cost more than calling tier 1 and tier 2 yourself, it
 * would be a fifth tier pretending to be a shortcut and it should not exist.
 * `tests/unit/mcp_triage.test.ts` asserts that against contract-maximal input.
 *
 * ONE UPSTREAM READ. This is the same endpoint tier 1 reads, with a field
 * selection derived the same way; everything else happens in `../triage.ts`.
 * There is no second source of truth here to disagree with the first.
 *
 * NO `limit` ARGUMENT, deliberately. The emitted count is hard at
 * {@link MAX_ITEMS} because the measured budget is measured AT that number — a
 * caller-raisable cap would mean the published cost is not the cost. Breadth is
 * `afr_list_failure_patterns`, which is where the response's own `next` points
 * when the scan was truncated.
 */
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { withFieldProjection } from '../field-projection.js'
import { MAX_ITEMS, SCAN_LIMIT, TRIAGE_REQUEST_FIELDS, toTriageResult } from '../triage.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { ListFailurePatternsParams } from '@agent-flight-recorder/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * ZERO REQUIRED ARGUMENTS — that is what makes this the default. `afr_triage()`
 * must work, or an agent has to know something before it can ask what is wrong.
 *
 * `agentId` is the only filter offered. There is deliberately NO `environment`
 * filter: a `FailurePattern` is an org-scoped rollup over fingerprints and
 * carries no environment, so an `environment` argument here could only be
 * accepted and ignored — a filter that silently does nothing is worse than an
 * absent one, because a caller believes it applied.
 */
const inputSchema = {
  agentId: z
    .string()
    .min(1)
    .optional()
    .describe('Only patterns seen on this agent. Omit to triage the whole org — that is the normal call.'),
}

/**
 * Register `afr_triage` on the server.
 *
 * @param server - the MCP server.
 * @param reader - the read client.
 */
export function registerTriage(server: McpServer, reader: AfrReader): void {
  server.registerTool(
    'afr_triage',
    {
      title: 'Triage: what is wrong and what to look at first',
      description:
        'CALL THIS FIRST. Answers "what is wrong right now, and what should I look at first?" in one call with no ' +
        `required arguments. ~400 tokens: it scans the ${String(SCAN_LIMIT)} most-recently-seen failure patterns and returns the top ` +
        `${String(MAX_ITEMS)}, ranked, each with a "next" field naming the exact tool and arguments to call for more — you never have ` +
        'to infer the next step. ' +
        'Ranking: regressed (a fix that did not hold) > spiking > open > acknowledged > resolved; recency and volume ' +
        'order within a class and never promote across one; muted patterns sort last and are flagged. ' +
        'READ "verdict" AND "complete" TOGETHER: verdict "clear" means the scan finished and found nothing, ' +
        '"unknown" means it could not be evaluated — they are not the same answer. complete:false means the view was ' +
        'not whole and "caveats" says why. If "scanTruncated" is present the SERVER could not finish its scan, so ' +
        'even an empty result is NOT evidence that nothing is broken. ' +
        'NOT for: a specific run you already have an id for (use afr_explain_run), or breadth beyond ' +
        `${String(MAX_ITEMS)} patterns (use afr_list_failure_patterns).`,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const filters: ListFailurePatternsParams = {
        limit: SCAN_LIMIT,
        ...(args.agentId !== undefined && { agentId: args.agentId }),
      }
      try {
        // Same derived-selection discipline as tier 1. TRIAGE_REQUEST_FIELDS
        // carries the ranking-only sources too (regressedAt, resolvedAt,
        // lastSpikeAssessment, representativeRunIds) — a field the server does
        // not send is one the ranking silently treats as absent, which would
        // quietly demote every regression on a deployment without
        // fix-confidence.
        const data = await withFieldProjection(TRIAGE_REQUEST_FIELDS, (fields) =>
          reader.getFailurePatterns({ ...filters, ...(fields !== undefined && { fields }) }),
        )
        return jsonResult(toTriageResult(data.patterns, data.fixConfidence, data.nextCursor, Date.now(), data))
      } catch (err) {
        throw toMcpError(err, 'pattern')
      }
    },
  )
}
