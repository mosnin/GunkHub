/**
 * Server construction: create an `McpServer` and register the tools.
 *
 * Kept separate from `index.ts` (the executable) so the server can be built
 * against a stub reader without spawning a process or touching stdio.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerAssessVersion } from './tools/assess-version.js'
import { registerExplainRun } from './tools/explain-run.js'
import { registerGetPatternEvidence } from './tools/get-pattern-evidence.js'
import { registerGetRunDivergence } from './tools/get-run-divergence.js'
import { registerGetRunEvents } from './tools/get-run-events.js'
import { registerListFailurePatterns } from './tools/list-failure-patterns.js'
import { registerListRuns } from './tools/list-runs.js'
import { registerTriage } from './tools/triage.js'

import type { AfrReader } from './reader.js'

/** Server name advertised to MCP clients. */
export const SERVER_NAME = 'agent-flight-recorder'

/**
 * Build a fully-registered MCP server.
 *
 * @param reader - the read client every tool calls through.
 * @param version - the package version to advertise.
 */
export function createServer(reader: AfrReader, version: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      instructions:
        'Agent Flight Recorder — read-only access to recorded agent runs, priced in tiers of increasing cost. ' +
        'START WITH afr_triage. It takes no arguments, costs ~400 tokens, and answers "what is wrong and what ' +
        'should I look at first?", handing back the exact next tool and arguments for each item. Do NOT open with ' +
        'afr_get_run_events: it is ~3 800 tokens and cannot tell you which run to ask about. ' +
        'The ladder underneath, cheapest first: ' +
        '1) afr_list_failure_patterns — everything that is broken, ~28 tokens per pattern (breadth beyond triage’s top 5). ' +
        '2) afr_get_pattern_evidence — did a fix hold, for one pattern, ~423 tokens. ' +
        '3) afr_explain_run — why one run failed plus the event sequence numbers that matter, ~121 tokens. ' +
        '4) afr_get_run_events — a capped WINDOW of raw events, ~3 800 tokens, only when tier 3 was not enough. ' +
        'afr_list_runs is for orientation when you need a runId. ' +
        'A SEPARATE QUESTION, WITH ITS OWN CHEAP-FIRST PAIR: "is my next version safe to ship?" Start at ' +
        'afr_assess_version (agent + target AgentVersion, grouped by distinct reason across recorded runs), then ' +
        'afr_get_run_divergence for one run’s detail. Neither executes anything; both replay RECORDED history ' +
        'against a target config. Their findings come in two kinds that must never be merged, summed, or treated ' +
        'as one scale: PROVEN findings are facts backed by a cited recorded event, SPECULATIVE findings are ' +
        'config changes that may or may not matter and are never evidence of a break. Neither tool emits a ' +
        '"safe" verdict, and an empty proven list is only meaningful when the accompanying coverage/window ' +
        'reports complete — otherwise it means the analysis did not finish looking. ' +
        'Every response carries the handle for the next step; working down from triage is always cheaper than ' +
        'starting at the bottom. ' +
        'Everything is scoped to the API key’s organization; ids from other orgs are indistinguishable from ids that never existed.',
    },
  )

  registerTriage(server, reader)
  registerListFailurePatterns(server, reader)
  registerGetPatternEvidence(server, reader)
  registerExplainRun(server, reader)
  registerGetRunEvents(server, reader)
  registerListRuns(server, reader)
  registerAssessVersion(server, reader)
  registerGetRunDivergence(server, reader)

  return server
}
