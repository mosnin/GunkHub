/**
 * services/divergence.ts — Convex I/O for the ADR-008 divergence surface.
 *
 * ===========================================================================
 * FOUR ANSWERS, NOT THREE
 * ===========================================================================
 *
 * `serviceResult.ts` already refuses to conflate "there is genuinely nothing"
 * with "the query failed". This surface needs a third kind of nothing, and it
 * is the most dangerous one in the product:
 *
 *   ok             the analysis ran; here is the report (which may itself
 *                  carry a verdict of `indeterminate` — see below)
 *   empty          the agent/run has no recorded history to analyse
 *   unanalysable   THE ANALYSIS COULD NOT RUN AT ALL — no configuration
 *                  snapshot to compare against, or no baseline version on the
 *                  run
 *   error          the query failed; we know nothing
 *
 * `AgentVersion.configSnapshot` is optional in the schema
 * (packages/contracts/src/entities.ts), so `unanalysable` is reachable in
 * production. Rendering it as `empty` would put "no divergences found" in front
 * of an operator who is deciding whether to ship — telling them a change is
 * safe when the truth is that we never asked the question.
 *
 * ---------------------------------------------------------------------------
 * TWO DIFFERENT "WE DID NOT LOOK", AND BOTH ARE MODELLED
 * ---------------------------------------------------------------------------
 *
 * Do not collapse `status: 'unanalysable'` with a report whose `verdict` is
 * `'indeterminate'`. They are different failures at different levels:
 *
 *   status 'unanalysable'   we never started. There is no report, no coverage,
 *                           and nothing to show but the reason and a remedy.
 *   verdict 'indeterminate' we ran, and finished with questions open. There IS
 *                           a report: proven findings in it are still proven,
 *                           and the open questions are enumerated.
 *
 * A proven divergence found during a partially-covered analysis is still
 * proven — the contract's `computeDivergenceVerdict` is explicit that
 * `incompatible` outranks `indeterminate` for exactly this reason. Collapsing
 * the two states would throw that proof away.
 *
 * ---------------------------------------------------------------------------
 * SHAPES
 * ---------------------------------------------------------------------------
 *
 * Every divergence type is imported from `@agent-flight-recorder/contracts`
 * (CLAUDE.md § Repo Conventions — the web app never redeclares entity types).
 * The engine's transport envelopes are mapped onto those contract types by
 * `@/lib/divergence/adapt`, which also fills the third band the engine does not
 * yet emit. See that module's header.
 */

import { unavailableEmpty, unavailableError, type ServiceUnavailable } from './serviceResult'

import type { EngineFleetEnvelope, EngineRunEnvelope } from '@/lib/divergence/adapt'
import type {
  AgentVersion,
  DivergenceReport,
  FleetDivergenceReport,
  Run,
} from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'
import { adaptFleetReport, adaptRunReport } from '@/lib/divergence/adapt'

// ---------------------------------------------------------------------------
// The four-way result
// ---------------------------------------------------------------------------

/**
 * The analysis could not run. Distinct from `empty` (there was nothing to
 * analyse) and from `error` (it blew up).
 *
 * `why` and `remedy` are safe to render: both are static copy assembled in this
 * module, never derived from a caught exception — the rule `serviceResult.ts`
 * establishes for every user-facing service message.
 */
export interface DivergenceUnanalysable {
  readonly status: 'unanalysable'
  readonly why: string
  readonly remedy: string
}

export type DivergenceResult<T> =
  | ({ readonly status: 'ok' } & T)
  | ServiceUnavailable
  | DivergenceUnanalysable

const SNAPSHOT_REMEDY =
  'Record a configuration snapshot when creating the version (the `configSnapshot` field on createAgentVersion), then re-run this analysis. A version created without one can never be checked against recorded history.'

function unanalysable(why: string, remedy: string = SNAPSHOT_REMEDY): DivergenceUnanalysable {
  return { status: 'unanalysable', why, remedy }
}

/** Does a version carry enough config to be compared against anything at all? */
export function hasConfigSnapshot(v: Pick<AgentVersion, 'configSnapshot'>): boolean {
  return v.configSnapshot !== undefined && Object.keys(v.configSnapshot).length > 0
}

const RUN_SUBJECT = 'the run divergence analysis'
const FLEET_SUBJECT = 'the fleet blast radius'

// ---------------------------------------------------------------------------
// Single run
// ---------------------------------------------------------------------------

export interface RunDivergenceData {
  readonly report: DivergenceReport
  readonly run: Run
  readonly targetVersion: AgentVersion
  /** Version label the run executed under, when it had one. */
  readonly baselineVersionLabel: string | null
  readonly targetVersionLabel: string
}

/**
 * Analyse one recorded run against one target version.
 *
 * Returns `unanalysable` — never `empty` — when the run has no baseline version
 * or the target has no config snapshot. Both are "we could not ask", and
 * neither may render as "we asked and found nothing".
 */
export async function getRunDivergence(
  runId: string,
  targetVersionId: string,
): Promise<DivergenceResult<RunDivergenceData>> {
  try {
    const { getRun } = await import('@/lib/services/runs')
    const { getAgentVersion } = await import('@/lib/services/agent_versions')

    const [runResponse, targetVersion] = await Promise.all([
      getRun(runId),
      getAgentVersion(targetVersionId),
    ])
    const run = runResponse.run

    if (targetVersion === null) {
      return unavailableError(RUN_SUBJECT, new Error('target version not found'), {
        service: 'divergence',
        fn: 'getRunDivergence',
      })
    }

    // Checked BEFORE the query, so the operator gets a specific remedy instead
    // of a generic backend error. The engine refuses these too; this is not a
    // substitute for that check, it is a better message for it.
    if (run.agentVersionId === undefined) {
      return unanalysable(
        'This run was recorded without an agent version, so there is no baseline configuration to compare the target against. The analysis could not run — this is not a finding that the run is unaffected.',
        'Record runs with an `agentVersionId` so their configuration is known. Runs already recorded without one cannot be analysed retroactively, because the configuration they ran under was never captured.',
      )
    }
    if (!hasConfigSnapshot(targetVersion)) {
      return unanalysable(
        'The target version has no configuration snapshot recorded, so there is nothing to compare this run against. The analysis could not run — this is not a finding of "no divergences".',
      )
    }

    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const raw = await client.query(convex.divergence.analyzeRun, {
      runId,
      targetVersionId,
    })

    const envelope = raw as EngineRunEnvelope
    const report = adaptRunReport(envelope)

    return {
      status: 'ok',
      report,
      run,
      targetVersion,
      baselineVersionLabel: envelope.baselineVersion,
      targetVersionLabel: envelope.targetVersion,
    }
  } catch (err) {
    return unavailableError(RUN_SUBJECT, err, {
      service: 'divergence',
      fn: 'getRunDivergence',
      runId,
      targetVersionId,
    })
  }
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export interface BlastRadiusData {
  readonly report: FleetDivergenceReport
  readonly targetVersion: AgentVersion
  readonly baselineVersion: AgentVersion
  readonly baselineVersionLabel: string
  readonly targetVersionLabel: string
  /**
   * Continuation cursor for the NEXT batch of runs, or null when this batch was
   * the last page.
   *
   * Surfaced all the way to the UI on purpose. The fleet scan is ONE BOUNDED
   * BATCH, not one answer: Convex permits a single `.paginate()` per execution
   * and `events` has no index on `type`, so a 10,000-run population is walked
   * page by page. A first page presented as "the fleet answer" is a lie in the
   * safe-looking direction, so the UI shows the cursor as a continue
   * affordance and the verdict stays `indeterminate` until the walk finishes.
   */
  readonly nextCursor: string | null
}

/**
 * Analyse a target version against the runs recorded under a BASELINE version.
 *
 * The engine keys the fleet scan on a (baseline, target) version pair rather
 * than on an agent, because every speculative finding is a property of that
 * pair and is identical across all its runs — which is what makes the cheap
 * tier possible at all. The UI therefore asks for both.
 *
 * ONE BOUNDED BATCH. `report.window.scanTruncated` is true whenever pages
 * remain, so `isFleetDivergenceAnalysisComplete` — and therefore the verdict —
 * refuses `compatible` until the whole population has been walked. The UI
 * renders that as an open question rather than as a footnote.
 */
export async function getBlastRadius(
  baselineVersionId: string,
  targetVersionId: string,
  cursor?: string,
): Promise<DivergenceResult<BlastRadiusData>> {
  try {
    const { getAgentVersion } = await import('@/lib/services/agent_versions')

    const [baselineVersion, targetVersion] = await Promise.all([
      getAgentVersion(baselineVersionId),
      getAgentVersion(targetVersionId),
    ])

    if (baselineVersion === null || targetVersion === null) {
      return unavailableError(FLEET_SUBJECT, new Error('version not found'), {
        service: 'divergence',
        fn: 'getBlastRadius',
      })
    }

    if (!hasConfigSnapshot(targetVersion)) {
      return unanalysable(
        'The target version has no configuration snapshot recorded, so there is nothing to compare recorded runs against. The analysis could not run — this is not a finding of "no divergences".',
      )
    }
    if (!hasConfigSnapshot(baselineVersion)) {
      return unanalysable(
        'The baseline version has no configuration snapshot recorded, so no change between it and the target can be established. The analysis could not run — this is not a finding that the versions are equivalent.',
      )
    }

    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const raw = await client.query(convex.divergence.analyzeFleet, {
      baselineVersionId,
      targetVersionId,
      ...(cursor !== undefined && { cursor }),
    })

    const envelope = raw as EngineFleetEnvelope

    // The scan visited nothing. Genuinely empty — the query succeeded and this
    // baseline version has no recorded runs — so `empty` is the honest status
    // here, unlike every branch above.
    if (envelope.window.runsScanned === 0) {
      return unavailableEmpty(
        'No runs were recorded against the baseline version, so there is no history to check the target against. Instrument a run with the SDK and it will appear here.',
      )
    }

    return {
      status: 'ok',
      report: adaptFleetReport(envelope),
      targetVersion,
      baselineVersion,
      baselineVersionLabel: envelope.baselineVersion,
      targetVersionLabel: envelope.targetVersion,
      nextCursor: envelope.nextCursor,
    }
  } catch (err) {
    return unavailableError(FLEET_SUBJECT, err, {
      service: 'divergence',
      fn: 'getBlastRadius',
      baselineVersionId,
      targetVersionId,
    })
  }
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

export function isDivergenceOk<T>(r: DivergenceResult<T>): r is { status: 'ok' } & T {
  return r.status === 'ok'
}

/**
 * True when the analysis could not run.
 *
 * Use this — not `!isDivergenceOk(...)` — before rendering anything
 * reassuring. The reason this status exists is that "not ok" is never a licence
 * to say "nothing found".
 */
export function isUnanalysable<T>(r: DivergenceResult<T>): r is DivergenceUnanalysable {
  return r.status === 'unanalysable'
}
