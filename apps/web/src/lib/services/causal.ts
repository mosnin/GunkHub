/**
 * services/causal.ts — the causal surface's one data seam.
 *
 * ===========================================================================
 * TWO OUTCOMES HERE, FOUR ON THE PAGE
 * ===========================================================================
 *
 *   ok      the walks ran. They may still have found no edges, and may still
 *           be incomplete — WHICH of the non-answers the page shows is decided
 *           by the contract's own verdict rule, never by this status and never
 *           by `edges.length`.
 *   error   a walk failed. We know nothing. Never rendered as "this run has no
 *           lineage": `serviceResult.ts` documents why that conflation is the
 *           worst failure mode this product has.
 *
 * `serviceResult.ts`'s `empty` is deliberately unused. On this surface "there
 * is nothing" is never an empty dataset — it is either an earned, bounded
 * finding (`isolated`) or an unfinished walk (`indeterminate`), and those have
 * opposite meanings.
 *
 * ---------------------------------------------------------------------------
 * NO ADAPTER. `convex/causality.ts` SPEAKS THE CONTRACT.
 * ---------------------------------------------------------------------------
 *
 * `traverse()` returns a `CausalTraversal` built from
 * `packages/contracts/src/causality.ts` — imported there, not mirrored — so
 * nothing stands between the engine and the components. An earlier version of
 * this file mapped a Convex-local `CausalGraphReport` onto the contract; that
 * seam is deleted rather than maintained. Two of its compromises were not
 * stylistic:
 *
 *   it wrote `sequenceNumber: 0` on every event citation, because the old wire
 *   shape carried no position. Event Log Rule 4 starts sequences at 1, so the
 *   contract now REFUSES `0` as `not_a_sequence_number` — a sentinel inside
 *   the data's own domain reads as a measurement.
 *
 *   it cited the edge-index row for artifact handoffs, because the old shape
 *   carried no digest. That is CIRCULAR SELF-EVIDENCE — an edge whose evidence
 *   is the row asserting the edge — which is precisely the shape an inference
 *   engine emits.
 *
 * Both were forced by what the old shape carried, and both are gone with it.
 * The verification that licensed the deletion is §4b of
 * tests/unit/causal_ui_chain.test.tsx: a traversal shaped the way the engine
 * builds one passes all three of the contract's gates with nothing to report,
 * and renders every citation kind.
 *
 * ---------------------------------------------------------------------------
 * TWO DIRECTIONAL WALKS — THE ONLY REPRESENTABLE SHAPE, NOT A WORKAROUND
 * ---------------------------------------------------------------------------
 *
 * `getIncidentGraph` throws `INVALID_ARGUMENT`, and the contract makes the
 * reason a type: `ComponentTerminus` has no origin arm, so a component walk
 * cannot make an origin claim at all — and a fully-closed component then has
 * no valid terminus to put in a NON-EMPTY tuple. There is nothing honest to
 * return. So the walk runs once per direction and each traversal is read
 * against its own direction. That is the sanctioned path.
 *
 * The cost is two snapshots of a graph that can change between them. The page
 * states that; nothing here stitches the two `scan` records into a single
 * claim neither engine made.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER IS CROSS-CHECKED, NOT OVERWRITTEN
 * ---------------------------------------------------------------------------
 *
 * Three things arrive already answered, and silently replacing any of them
 * would turn a backend defect into a clean screen — the exact failure mode
 * this file sits downstream of:
 *
 *   `verdict`        recomputed from the contract's rule, because a consumer
 *                    must not trust a `verdict` a server handed it. A
 *                    DISAGREEMENT IS REPORTED, not swallowed.
 *   `scan.direction` the echo is load-bearing: a deployment that ignores the
 *                    parameter answers a different question and looks
 *                    identical doing it. An earlier draft of this file
 *                    OVERWROTE this field to the direction we asked for, which
 *                    would have made that defect unobservable. It is now
 *                    compared and reported.
 *   `termini`        typed non-empty, and Team A saw it arrive empty on an
 *                    ordinary parent/child pair. Reported, and rendered.
 *
 * NOTHING HERE REPAIRS A TRAVERSAL. Every disagreement becomes a finding the
 * page shows. That is the lesson from the iteration where a recovery path in
 * this codebase quietly absorbed a backend fold bug: a seam that fixes what it
 * finds makes the defect unobservable at its source, and the next person to
 * look sees a working screen over broken data.
 */

import { computeCausalVerdict } from '@agent-flight-recorder/contracts'

import type { CausalTraversal, CausalVerdict } from '@agent-flight-recorder/contracts'

import { auditTraversal, type CausalFinding } from '@/lib/causal/audit'
import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'
import { unavailableError, type ServiceUnavailable } from '@/lib/services/serviceResult'

// `CausalFinding` and the gate itself live in `@/lib/causal/audit`, which is
// pure and importable from a test without pulling a Convex client in behind
// it. Re-exported so consumers of this service keep one import site.
export type { CausalFinding }

export type CausalTraversalResult =
  | {
      readonly status: 'ok'
      /** Read against inbound adjacency. "What produced this run?" */
      readonly upstream: CausalTraversal
      /** Read against outbound adjacency. "What ran on this run's output?" */
      readonly downstream: CausalTraversal
      /** The verdict over BOTH halves, from the contract's rule. */
      readonly verdict: CausalVerdict
      /**
       * Everything withheld, contradictory, or disagreed with. Rendered on the
       * page — a silently shorter chain ends earlier than it should, and an
       * early end is read as a finding.
       */
      readonly findings: readonly CausalFinding[]
    }
  | (ServiceUnavailable & { status: 'error' })

export async function getCausalTraversal(
  runId: string,
  maxDepth: number,
): Promise<CausalTraversalResult> {
  try {
    const client = await getAuthedClient()
    // Both refs declare their args and return `unknown` (see
    // `@/lib/convexFunctions`), so nothing here is `any` and nothing needs a
    // disable. `auditTraversal` takes `unknown` by design: it is what
    // establishes whether what arrived is a traversal at all.
    const [rawUp, rawDown] = await Promise.all([
      client.query(convex.causality.traceRunOrigin, { runId, maxDepth }),
      client.query(convex.causality.traceRunImpact, { runId, maxDepth }),
    ])

    const up = auditTraversal(rawUp, 'upstream', maxDepth)
    const down = auditTraversal(rawDown, 'downstream', maxDepth)

    return {
      status: 'ok',
      upstream: up.traversal,
      downstream: down.traversal,
      // ONE rule, the contract's, over both halves. A recorded edge in either
      // direction is a chain; an incomplete walk in either direction means "no
      // edges" cannot be certified as an island.
      verdict: computeCausalVerdict({
        edgeCount: up.traversal.edges.length + down.traversal.edges.length,
        complete: up.complete && down.complete,
      }),
      findings: [...up.findings, ...down.findings],
    }
  } catch (err) {
    // `unavailableError` always produces `status: 'error'`, but its declared
    // return type is the wider `ServiceUnavailable`. The narrowing cast is the
    // house convention (see `services/fleet.ts`) and is safe in the one
    // direction that matters: this path can never produce `'empty'`, because
    // "there is genuinely nothing" is not something a failed walk can know.
    return unavailableError('the causal chain for this run', err, {
      service: 'causal',
      runId,
    }) as ServiceUnavailable & { status: 'error' }
  }
}
