/**
 * `afr_get_run_divergence` — the drill-down: where ONE recorded run's
 * trajectory becomes impossible under a target version.
 *
 * Reached from `afr_assess_version`'s per-reason `next` pointers. Reaching for
 * it first means paying a per-run price for a question that has a fleet answer,
 * and — worse — having to choose a run id before knowing which run matters,
 * which is the one thing the fleet call tells you.
 *
 * WHY THIS IS NOT PRICED LIKE `afr_get_run_events`. The instinct is that a
 * drill-down onto one run must be the expensive tier. It is not: this returns
 * FINDINGS, bounded by how many tools and models a config declares, never event
 * payloads. Its budget is derived from what it returns, not from the shape of
 * the ladder it sits in. If it is ever made to carry proof BODIES rather than
 * proof pointers it becomes a tier-4 tool and its ceiling has to be re-derived
 * from scratch rather than raised — and it would also be inlining payloads that
 * Event Log Rule 3 keeps behind artifact pointers.
 *
 * The first proven break is the meaningful one. Once a run provably could not
 * have taken a step it recorded, the remainder of the recorded trajectory is
 * counterfactual: the target version was never going to be in that state. So
 * findings are emitted earliest-first, the cut falls on the tail, and `next`
 * points at an event window centred on the first break.
 *
 * See `docs/adr/008-version-divergence-analysis.md`.
 */
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { toRunDivergenceResult } from '../projections.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const inputSchema = {
  runId: z.string().min(1).describe('The recorded run to replay. From afr_assess_version’s next pointers.'),
  targetVersionId: z
    .string()
    .min(1)
    .describe('The AgentVersion id to test against. REQUIRED — same reasoning as afr_assess_version.'),
}

/**
 * Register `afr_get_run_divergence` on the server.
 *
 * @param server - the MCP server.
 * @param reader - the read client.
 */
export function registerGetRunDivergence(server: McpServer, reader: AfrReader): void {
  server.registerTool(
    'afr_get_run_divergence',
    {
      title: 'Get one run’s divergence against a target version',
      description:
        'Answers "where does THIS recorded run become impossible under that version?" Nothing is executed — it is ' +
        'a structural replay of recorded events against the target’s configSnapshot. Reach it from ' +
        'afr_assess_version, which tells you which run to ask about. ' +
        'proven[] entries are FACTS, each carrying provenBy: the recorded event sequence number, the event type, ' +
        'the target config path, the value the run recorded, and what the target declares there (null = absent, ' +
        'which is itself the proof). speculative[] entries are NOT EVIDENCE and carry no proof by construction: ' +
        'a changed prompt may alter everything or nothing, and recorded history cannot decide. indeterminate[] ' +
        'entries are QUESTIONS THAT COULD NOT BE ANSWERED, each with a remedy naming the action that would make ' +
        'it answerable. The three lists are never merged and never summed. Every finding carries a dimension, so ' +
        'a partial analysis is attributable: tools provably broken WHILE budgets went unanswered. ' +
        'THE TOP-LEVEL complete IS THE FIELD THAT STOPS A FALSE CLEAN, and it is stricter than coverage.complete ' +
        'beside it: there are two ways not to have looked — a dimension never reached, and a question reached but ' +
        'unanswerable — and both count. An empty proven[] means "this run is safe" ONLY when complete is true; ' +
        'otherwise it means "we did not check everything", and coverage.unassessed names each dimension and why ' +
        '(no configSnapshot on the target, a dimension the snapshot is silent on, an unreadable shape, an engine ' +
        'limit). READ byDimension BEFORE THE VERDICT: it gives one outcome per config dimension ' +
        '(incompatible | changed | clean | undeclared | unanswered), and a single global verdict is almost ' +
        'always the worst of the six. tools clean while budgets is undeclared is a far more useful and far more ' +
        'actionable answer than one undifferentiated word — and "undeclared" is the state YOU can fix, by ' +
        'publishing a structured configSnapshot. verdict follows the same vocabulary as afr_assess_version and ' +
        'has no "safe" value. ' +
        'next points at the event window around the FIRST proven break; findings after it describe a trajectory ' +
        'the target would never have reached. ' +
        'THE ASYMMETRY THAT IS EASIEST TO MISREAD WHEN THE NEWS IS GOOD: a clean report says this run would not ' +
        'have BROKEN on the target. It NEVER says it would BEHAVE THE SAME. Added capability is invisible to a ' +
        'replay by construction. Note also what proof can and cannot run in each direction: a surviving tool ' +
        'call can be proven INVALID against the target schema, never proven VALID — enums, formats and ' +
        'cross-field constraints are not evaluated. ' +
        'NOT for: reading the events themselves (afr_get_run_events), or why the run failed (afr_explain_run).',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const data = await reader.getRunDivergence(args.runId, { targetVersionId: args.targetVersionId })
        return jsonResult(toRunDivergenceResult(data.report))
      } catch (err) {
        throw toMcpError(err, 'divergence')
      }
    },
  )
}
