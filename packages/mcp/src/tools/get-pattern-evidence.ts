/**
 * Tier 2 — `afr_get_pattern_evidence`.
 *
 * "Did the fix hold?" A resolution on its own is an unearned human assertion:
 * someone marked a pattern fixed and the product believed them. This returns
 * what can be checked against that claim — the resolution, the run exposure
 * accumulated since, a graded confidence verdict with every driver behind it,
 * and the lifecycle history from the append-only audit log.
 *
 * ~300 tokens, for ONE pattern the caller already chose in tier 1.
 *
 * READ-ONLY, like every tool here. There is deliberately no acknowledge /
 * resolve / reopen / mute tool: those are member-gated, audited, human-actor
 * actions in the web app. An API key has no human behind it, and the audit log
 * exists to record which person made a privileged change. Reading proof that a
 * fix held needs no actor; asserting that it held does.
 */
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { toPatternEvidenceResult } from '../projections.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const inputSchema = {
  fingerprintHash: z.string().min(1).describe('From afr_list_failure_patterns.'),
}

/**
 * Register `afr_get_pattern_evidence` on the server.
 *
 * @param server - the MCP server.
 * @param reader - the read client.
 */
export function registerGetPatternEvidence(server: McpServer, reader: AfrReader): void {
  server.registerTool(
    'afr_get_pattern_evidence',
    {
      title: 'Get failure pattern evidence',
      description:
        'Answers "did the fix hold?" for ONE failure pattern, ~423 tokens: resolution metadata, run exposure since ' +
        'the fix (since/runCount/runCountTruncated/recurrenceCount/heldSoFar), a 0-1 confidence score with its state ' +
        'and every driver behind it, and the 10 most recent lifecycle transitions. ' +
        'Read confidence.state, not heldSoFar alone — heldSoFar is true for a fix nothing has exercised yet. ' +
        'state "regressed" is the build-failing signal. score is a fraction capped at 0.95, never a percentage. ' +
        'NOT for: finding out WHICH pattern to ask about (afr_triage), a coarse state across many patterns ' +
        '(afr_list_failure_patterns already returns confidenceState per row for a tenth the cost), or why a ' +
        'particular run failed (afr_explain_run).',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const evidence = await reader.getFailurePatternEvidence(args.fingerprintHash)
        return jsonResult(toPatternEvidenceResult(evidence))
      } catch (err) {
        throw toMcpError(err, 'pattern')
      }
    },
  )
}
