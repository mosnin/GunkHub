/**
 * Tier 3 — `afr_explain_run`.
 *
 * The cheap failure narrative for ONE run: summary, root cause, suggested fix,
 * failure class, and the event sequence numbers the explanation cites. ~200
 * tokens, versus 100k+ for the raw trace.
 *
 * This SURFACES the explanation the backend already generated and cached
 * (`convex/run_explanations.ts`, served by `GET /api/v1/runs/:id/explanation`).
 * It does not re-derive anything: an explanation is a derived artifact over the
 * event log, generated once server-side, and a second implementation here would
 * be a second answer to the same question.
 *
 * The `citedSequenceNumbers` are the whole point of the tier boundary — they
 * are what let a caller jump straight to the three events that matter with
 * `afr_get_run_events(runId, aroundSequence)` instead of reading the log. They
 * are byte-budgeted like everything else on this tier (see
 * `CITED_SEQUENCE_BYTE_CAP` in ../projections.ts) and a cut is announced with
 * `citationsDropped` — the handles are valuable, but an unbounded list of them
 * is what put this tier over its budget.
 */
import { z } from 'zod'

import { toMcpError } from '../errors.js'
import { toExplainRunResult } from '../projections.js'

import { jsonResult } from './shared.js'

import type { AfrReader } from '../reader.js'
import type { RunExplanation } from '@agent-flight-recorder/contracts'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const inputSchema = {
  runId: z.string().min(1).describe('The run id.'),
}

type ExplanationStatus = 'not_eligible' | 'pending' | 'ready'

const STATUSES: readonly string[] = ['not_eligible', 'pending', 'ready']

/**
 * Read the response's status discriminant.
 *
 * The server (`convex/read_api.ts` `apiGetExplanation`) returns
 * `{ status, explanation, runStatus, runEndedAt }`, but the SDK's
 * `V1GetExplanationData` still declares only `{ explanation }` — see the note
 * in this package's README. So the extra fields are read tolerantly here rather
 * than assumed.
 *
 * FALLBACK, only when `status` is absent (an older deployment): `ready` if an
 * explanation came back, otherwise `pending`. That fallback cannot distinguish
 * "this run never failed, so there will never be an explanation" from "it
 * failed and generation has not landed yet" — the coarse-null gap the `status`
 * field was added to close. `runStatus` is included in the response whenever
 * the server sent it precisely so a caller can tell them apart anyway.
 */
function readStatus(data: unknown, explanation: RunExplanation | null): ExplanationStatus {
  if (typeof data === 'object' && data !== null) {
    const raw = (data as { status?: unknown }).status
    if (typeof raw === 'string' && STATUSES.includes(raw)) return raw as ExplanationStatus
  }
  return explanation === null ? 'pending' : 'ready'
}

/** Read the run's own status, when the server supplied it. */
function readRunStatus(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null) {
    const raw = (data as { runStatus?: unknown }).runStatus
    if (typeof raw === 'string') return raw
  }
  return undefined
}

/**
 * Register `afr_explain_run` on the server.
 *
 * @param server - the MCP server.
 * @param reader - the read client.
 */
export function registerExplainRun(server: McpServer, reader: AfrReader): void {
  server.registerTool(
    'afr_explain_run',
    {
      title: 'Explain a run',
      description:
        'Answers "why did THIS run fail?" for one runId, ~121 tokens (~198 worst case). Returns the cached ' +
        'root-cause explanation: summary, rootCause, suggestedFix, failureClass, and citedSequenceNumbers. ' +
        'ALWAYS read this before afr_get_run_events — it costs ~1/30th as much and it tells you which sequence ' +
        'numbers are worth fetching. ' +
        'READ "availability", NOT "status", TO DECIDE WHETHER TO RETRY. status is the raw server discriminant and ' +
        '"not_eligible" on it does NOT mean "never": a run that is still in flight is reported not_eligible right ' +
        'now and may fail and get an explanation moments later. availability resolves that against runStatus — ' +
        '"not_yet" means it can still produce one (it failed and generation has not landed, or it is still running) ' +
        'so retry; "never" means the run finished without failing, so stop; "unknown" means runStatus was not served ' +
        'or contradicts status, so do not conclude either. When status is "ready" the explanation is below and ' +
        'availability is omitted. ' +
        '"kind" tells you whether you are reading a heuristic (derived) or llm (analysed) explanation — the ' +
        'heuristic path is unconditional, so an explanation never depends on an LLM being available. ' +
        'NOT for: a question about a recurring failure across runs (afr_triage or afr_get_pattern_evidence), or when ' +
        'you do not have a runId yet (afr_triage, then afr_list_runs). Long prose is capped with an explicit ' +
        '"…[truncated, N more chars]" marker. citedSequenceNumbers is capped too: it carries the HIGHEST cited ' +
        'sequence numbers (the ones nearest the failure) in ascending order, and when it was cut, ' +
        '"citationsDropped" says how many earlier citations are not shown — page backwards from the lowest one ' +
        'with afr_get_run_events(runId, fromSequence) to reach them, and do not read the list as the complete ' +
        'set of grounding events.',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const data = await reader.getExplanation(args.runId)
        const explanation = data.explanation
        return jsonResult(toExplainRunResult(args.runId, readStatus(data, explanation), explanation, readRunStatus(data)))
      } catch (err) {
        throw toMcpError(err, 'run')
      }
    },
  )
}
