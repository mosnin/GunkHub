/**
 * `afr_assess_version` — the fleet divergence answer, and the first call for
 * "can I ship this version?"
 *
 * THIS IS THE MOST AGENT-NATIVE QUESTION THIS PRODUCT ANSWERS: an agent asking
 * whether its own next version is safe to ship, and gating its own change on
 * the reply. Everything about the shape of this tool follows from the fact that
 * the caller may act on the answer with no human in the loop.
 *
 * WHY THIS IS THE FIRST RUNG. The unit here is the REASON, not the run. "340 of
 * 10,000 runs would break, for 12 distinct reasons" is a tractable morning; 340
 * individual reports is a resignation letter. It also hands back the run ids
 * worth drilling into, which is precisely what the caller did not know when it
 * asked — each proven reason carries the exact drill-down call.
 *
 * IT IS NOT AN ORDER OF MAGNITUDE CHEAPER THAN THE DRILL-DOWN, and pretending
 * otherwise would be the wrong lesson to draw from `afr_triage`. Measured, the
 * two are close. The fleet call's cheapness is relative to WHAT IT COVERS — one
 * call over ten thousand runs — not to the per-run call, whose cost is bounded
 * by how many tools and models a config declares rather than by run count.
 *
 * READ-ONLY, like every tool here. It analyses; it does not gate, promote,
 * approve, or record a decision. Deciding to ship is the caller's, and the
 * decision this tool's cleanest possible answer supports is narrow: *no
 * recorded run is proven to break on the dimensions that were checked.*
 *
 * See `docs/adr/008-version-divergence-analysis.md` for the decision record —
 * in particular section 5, which is the list of things this analysis can never
 * know, and is longer than the list of things it can.
 */
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { toFleetDivergenceResult } from '../projections.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { AgentDivergenceParams } from '@agent-flight-recorder/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const inputSchema = {
  agentId: z.string().min(1).describe('The agent whose recorded runs to replay against the target version.'),
  targetVersionId: z
    .string()
    .min(1)
    .describe(
      'The AgentVersion id to test against. REQUIRED — there is no "compare against latest" default, because ' +
        'a gate whose subject is implicit changes meaning the moment someone publishes a new version.',
    ),
  since: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Only analyse runs started at or after this epoch-ms timestamp.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max runs to scan. Server-capped; hitting the cap sets window.scanTruncated.'),
}

/**
 * Register `afr_assess_version` on the server.
 *
 * @param server - the MCP server.
 * @param reader - the read client.
 */
export function registerAssessVersion(server: McpServer, reader: AfrReader): void {
  server.registerTool(
    'afr_assess_version',
    {
      title: 'Assess a version change against recorded runs',
      description:
        'Answers "if I ship this AgentVersion, what breaks?" across an agent’s recorded runs, grouped by DISTINCT ' +
        'REASON rather than by run. Nothing is executed: this replays recorded event history against the target ' +
        'version’s configSnapshot, structurally. Call this BEFORE afr_get_run_divergence — it is cheaper and it ' +
        'hands you the run ids worth drilling into. ' +
        'FINDINGS COME IN THREE KINDS AND THEY ARE NOT THREE CONFIDENCE LEVELS. provenReasons are FACTS: the ' +
        'run called a tool or model the target does not declare, or blew a hard recorded budget the target ' +
        'lowers, so that step could not have happened. Safe to gate a deploy on. speculativeReasons are NOT ' +
        'EVIDENCE: a changed prompt or decoding parameter may alter behaviour or may alter nothing, and no ' +
        'recorded history can decide which. indeterminateReasons are QUESTIONS THE ANALYSIS COULD NOT ANSWER — ' +
        'a malformed config, or a tool.call payload externalized past the inline ceiling so the event survived ' +
        'and the tool name did not. That is the COMMON case, not an edge case, because configSnapshot is ' +
        'free-form. Each carries a remedy: the action that would make it answerable. Never merge the three, and ' +
        'never add their counts together. ' +
        'READ complete BEFORE READING provenReasons AS CLEAN. It is true only when the scan truncated nothing, ' +
        'skipped nothing, failed on nothing AND has no pages left — window.nextCursor alone makes it false, ' +
        'because a first page is not a fleet answer. An empty proven list with complete false means "we did ' +
        'not finish looking", not "nothing breaks". verdict is incompatible | ' +
        'compatible_with_caveats | compatible | indeterminate — there is no "safe" value, deliberately, because ' +
        'this analysis can prove a step was impossible and can never prove a change is harmless. ' +
        'THE ASYMMETRY THAT IS EASIEST TO MISREAD WHEN THE NEWS IS GOOD: a clean report says the target would ' +
        'not have BROKEN on recorded history. It NEVER says the target would BEHAVE THE SAME. Added capability ' +
        'is invisible to a replay by construction — a tool the target adds appears only as a speculative ' +
        'tool_added, because nothing recorded can be contradicted by an addition. ' +
        'Every reason carries its dimension, so the fleet answer can be grouped the way it is actually read — ' +
        'tools broken, model fine, budgets never declared. For the pre-derived per-dimension roll-up, and the ' +
        'undeclared-versus-unanswered distinction, call afr_get_run_divergence on one representative run. ' +
        'Speculative and indeterminate reasons carry no next hop on purpose: drilling in returns the same ' +
        'unprovable sentence, or the same unanswerable question, one level down. ' +
        'NOT for: which runs failed (afr_triage), why one failed (afr_explain_run).',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const params: AgentDivergenceParams = { targetVersionId: args.targetVersionId }
        if (args.since !== undefined) params.since = args.since
        if (args.limit !== undefined) params.limit = args.limit
        const data = await reader.getAgentDivergence(args.agentId, params)
        return jsonResult(toFleetDivergenceResult(data.report))
      } catch (err) {
        throw toMcpError(err, 'divergence')
      }
    },
  )
}
