/**
 * causal/audit.ts — the contract's gates, plus the cross-check of everything
 * the server already answered.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE, PURE MODULE
 * ===========================================================================
 *
 * It lives here rather than in `@/lib/services/causal` for one practical
 * reason and one design reason.
 *
 * PRACTICAL: the service imports `@/lib/convexServer`, which validates
 * environment variables at module load. Importing it from a jsdom test to
 * reach one pure function drags a Convex client and a Clerk key in behind it,
 * and the test dies on config rather than on behaviour. The gate that decides
 * whether a backend is telling the truth is exactly the thing that must stay
 * cheap to test.
 *
 * DESIGN: this function does no I/O and must never acquire any. Everything it
 * knows comes from the traversal in front of it and the request that produced
 * it, which is what makes its verdicts reproducible from a captured response.
 *
 * ===========================================================================
 * NOTHING HERE REPAIRS A TRAVERSAL
 * ===========================================================================
 *
 * Every disagreement becomes a finding the page renders. That is deliberate,
 * and it is the lesson from the iteration where a recovery path in this
 * codebase quietly absorbed a backend fold bug: a seam that fixes what it
 * finds makes the defect unobservable at its source, and the next person to
 * look sees a working screen over broken data.
 *
 * The one value this module does replace is `verdict` — and it replaces it
 * loudly, emitting a finding whenever the recomputed answer differs from the
 * server's. The contract requires the recomputation (a consumer must not trust
 * a `verdict` a server handed it, and `FlightReader` cross-checks the same
 * way); the finding is what keeps that from being a silent overwrite.
 */

import {
  computeCausalVerdict,
  isCausalTraversalComplete,
  traversalClaimContradictions,
  traversalIncoherences,
  traversalUnusableFields,
} from '@agent-flight-recorder/contracts'

import type { CausalTraversal } from '@agent-flight-recorder/contracts'

/** One finding a reader can act on, wherever in the pipeline it came from. */
export interface CausalFinding {
  where: string
  what: string
}

/**
 * Run the contract's three gates over one half, and cross-check what the
 * server already answered.
 *
 * USABILITY BEFORE COHERENCE BEFORE CLAIMS — the contract's stated order, and
 * it is not cosmetic: the later steps do arithmetic, and arithmetic on a
 * string is how a lost trail becomes an origin.
 */
export function auditTraversal(
  raw: unknown,
  direction: 'upstream' | 'downstream',
  maxDepthRequested: number,
): { traversal: CausalTraversal; complete: boolean; findings: CausalFinding[] } {
  // A body that is not a traversal at all becomes a traversal-shaped nothing,
  // whose every gate then reports. Throwing here would render the whole page
  // as a failed query and hide WHICH half broke.
  const traversal: CausalTraversal =
    raw !== null && typeof raw === 'object' ? (raw as CausalTraversal) : ({} as CausalTraversal)

  const findings: CausalFinding[] = []
  const where = (s: string) => `${direction}: ${s}`

  const unusable = traversalUnusableFields(traversal)
  const incoherent = traversalIncoherences(traversal)
  // The gate that catches the expensive lie: an origin contradicted by an
  // adjacent edge, a fabricated loop, an undeclared one, a frontier naming a
  // run the walk never reached. Every defect in this class produced
  // `complete: true` — it certifies a finished investigation over data that
  // refutes it.
  const contradictions = traversalClaimContradictions(traversal)

  const complete = isCausalTraversalComplete(traversal)
  const serverVerdict = traversal.verdict
  const ourVerdict = computeCausalVerdict({
    edgeCount: Array.isArray(traversal.edges) ? traversal.edges.length : 0,
    complete,
  })

  const scan = traversal.scan
  if (scan !== null && typeof scan === 'object') {
    // THE ECHO. A deployment that ignores what it was asked walks its own way
    // and reports a stop at a bound nobody chose — indistinguishable from an
    // honest answer unless the echo is checked.
    if (scan.direction !== direction) {
      findings.push({
        where: where('scan.direction'),
        what: `this walk was asked for \`${direction}\` and reports \`${String(scan.direction)}\`. It answered a different question from the one on screen, so read nothing here as being about that direction.`,
      })
    }
    if (scan.maxDepthRequested !== maxDepthRequested) {
      findings.push({
        where: where('scan.maxDepthRequested'),
        what: `a depth of ${maxDepthRequested} was asked for and ${String(scan.maxDepthRequested)} was echoed. Any depth limit reported below was reached at a bound nobody on this page chose.`,
      })
    }
  }

  // A NON-EMPTY TUPLE THAT ARRIVED EMPTY — the most dangerous shape on this
  // surface. `termini.every(t => t.terminus === 'recorded_origin')` is
  // VACUOUSLY TRUE over an empty list, so a walk reporting no frontier reads
  // as a finished trace to the most natural check anyone would write. Team A
  // hit exactly this on an ordinary parent/child pair. Reported here AND
  // rendered by `CausalChainView`: a screen with no terminus at all is the "no
  // lineage here" defect in its purest form.
  if (!Array.isArray(traversal.termini) || traversal.termini.length === 0) {
    findings.push({
      where: where('termini'),
      what: 'this walk reported no frontier at all, which the contract types as impossible — a walk always stops somewhere. Nothing states where or why it stopped, so treat the chain as unfinished.',
    })
  }

  if (serverVerdict !== undefined && serverVerdict !== ourVerdict) {
    findings.push({
      where: where('verdict'),
      what: `the server called this \`${String(serverVerdict)}\` and its own contents say \`${ourVerdict}\`. The page shows the recomputed one; the disagreement is a backend defect and is reported rather than absorbed.`,
    })
  }

  return {
    // The recomputed verdict is what the page reads. The disagreement above is
    // what keeps that from being a silent overwrite.
    traversal: { ...traversal, verdict: ourVerdict },
    complete,
    findings: [
      ...findings,
      ...unusable.map((u) => ({
        where: where(u.path),
        what: `this field could not be used (${u.reason}), so nothing derived from it is shown.`,
      })),
      ...incoherent.map((i) => ({
        where: where(i.edgeKey),
        what: `this edge's own contents contradict the rest of the traversal (${i.incoherence}), so it is not drawn.`,
      })),
      ...contradictions.map((c) => ({
        where: where(c.at),
        what: `this claim is contradicted by the data beside it (${c.claim}: ${c.contradiction}), so the walk has not established what it says it did.`,
      })),
    ],
  }
}
