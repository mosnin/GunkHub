/**
 * causal/ladder.ts — turning a causal graph into something an operator reads
 * top to bottom.
 *
 * ===========================================================================
 * WHY A LADDER AND NOT A NODE-LINK DIAGRAM
 * ===========================================================================
 *
 * The default answer to "render a graph" is a force-directed node-link blob.
 * It was considered and rejected, and the reasons are recorded here so nobody
 * re-derives it as an improvement:
 *
 *   IT ANSWERS THE WRONG QUESTION. An operator holding a failed run does not
 *   ask what the topology looks like. They ask "what is upstream of this, in
 *   order, and where does it stop". That is a PATH. A path drawn as a blob has
 *   to be traced by eye through crossing edges; drawn as a ladder it IS the
 *   reading order.
 *
 *   IT IS UNREADABLE PAST A DOZEN NODES, and the incidents worth tracing are
 *   the big ones. Layout is non-deterministic, so the same component looks
 *   different on two screens and two people cannot talk about "the one on the
 *   left".
 *
 *   IT FIGHTS THE PRODUCT. CLAUDE.md asks for strong vertical hierarchy and
 *   dense vertical scanning. Every other surface here is a vertical list; a
 *   canvas is a second interaction model for one screen.
 *
 *   IT IS UNREACHABLE BY KEYBOARD AND INVISIBLE TO A SCREEN READER without
 *   rebuilding, in ARIA, exactly the list this module already produces.
 *
 *   AND THE DECIDING ONE: A BLOB CANNOT SAY WHERE THE CHAIN STOPPED. In a
 *   node-link drawing a terminal node is just a node with no further edges —
 *   which is precisely the RecordedOrigin/LostTrail conflation the causality
 *   contract exists to prevent. In a ladder the stopping point is a distinct,
 *   labelled, final element, and it is the last thing read.
 *
 * The alternatives actually weighed were an indented tree (adopted for the
 * downstream direction, where fan-out is real), a timeline with lineage
 * (rejected — see below), and a path-with-branches (adopted upstream, where a
 * fork is reported rather than drawn).
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO TIME AXIS HERE, ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * A timeline was the most tempting alternative and is the most dangerous. Two
 * runs adjacent on a time axis read as a sequence, and a sequence reads as a
 * chain — manufacturing exactly the inferred causation `SuspectedLink` exists
 * to quarantine. So a rung's position is derived ONLY from
 * `RecordedCausalEdge`s, never from `startedAt`. `CausalNode.startedAt` is
 * displayed on a row and never used to order one.
 *
 * ---------------------------------------------------------------------------
 * ROWS ARE BUILT FROM EDGES, NOT FROM THE NODE LIST
 * ---------------------------------------------------------------------------
 *
 * `CausalTraversal.nodes` is every run the walk READ, which is not the same as
 * every run that is on a chain — a node can be present because it was on the
 * frontier when a budget ran out. Building rows by walking `edgesInto` /
 * `edgesOutOf` from the subject means a row exists only if a recorded edge put
 * it there, so an unlinked run cannot reach the ladder even by being in the
 * node list. Nodes reached by no edge are reported by `orphanNodeIds` rather
 * than silently dropped.
 */

import {
  edgesInto,
  edgesOutOf,
} from '@agent-flight-recorder/contracts'

import type {
  CausalNode,
  CausalTraversal,
  RecordedCausalEdge,
} from '@agent-flight-recorder/contracts'

/**
 * One row of the ladder.
 *
 * `arrivedBy` is REQUIRED on every row except the subject's. A row without it
 * is a row nothing recorded, and `buildLadder` cannot produce one: the walk
 * only ever appends a row it has an edge in hand for.
 */
export interface LadderRow {
  node: CausalNode
  /** The recorded edge that put this row on the ladder. Absent only on the subject. */
  arrivedBy?: RecordedCausalEdge
  /** Hops from the subject, derived from the walk rather than trusted from the node. */
  depth: number
  isSubject: boolean
}

export interface Ladder {
  direction: 'upstream' | 'downstream'
  /**
   * Upstream: furthest-reached row FIRST, subject LAST, so causation flows
   * downward as the eye moves down. Downstream: subject first, then what each
   * recorded edge leads to.
   */
  rows: readonly LadderRow[]
  /**
   * Runs in `nodes` that no recorded edge reaches in this direction. Never
   * placed on the ladder; surfaced so an unreached node is a stated fact
   * rather than a silent omission.
   */
  orphanNodeIds: readonly string[]
}

function nodeIndex(traversal: CausalTraversal): Map<string, CausalNode> {
  const out = new Map<string, CausalNode>()
  const nodes = Array.isArray(traversal?.nodes) ? traversal.nodes : []
  for (const n of nodes) {
    if (n !== null && typeof n === 'object' && typeof n.runId === 'string') out.set(n.runId, n)
  }
  return out
}

/**
 * A node we can render for a run id, or `null`.
 *
 * An edge naming a run the traversal never reached is an incoherence the
 * contract's `traversalIncoherences` reports; here it simply stops the walk,
 * because rendering a row with no node behind it would mean inventing a
 * status and a timestamp for a run we never read.
 */
function rowFor(
  index: Map<string, CausalNode>,
  runId: string,
  edge: RecordedCausalEdge | undefined,
  depth: number,
  isSubject: boolean,
): LadderRow | null {
  const node = index.get(runId)
  if (node === undefined) return null
  return { node, ...(edge !== undefined && { arrivedBy: edge }), depth, isSubject }
}

/**
 * Breadth-first from the subject along RECORDED edges only.
 *
 * A run already on the ladder is never appended twice: a cycle in the recorded
 * edges is a data defect, and walking it would render one run as several.
 */
function walk(
  traversal: CausalTraversal,
  direction: 'upstream' | 'downstream',
  maxRows: number,
): { rows: LadderRow[]; reached: Set<string> } {
  const index = nodeIndex(traversal)
  const subjectId = traversal?.subjectRunId
  const rows: LadderRow[] = []
  const reached = new Set<string>()

  if (typeof subjectId !== 'string') return { rows, reached }

  const subjectRow = rowFor(index, subjectId, undefined, 0, true)
  if (subjectRow === null) return { rows, reached }
  rows.push(subjectRow)
  reached.add(subjectId)

  let frontier: string[] = [subjectId]
  let depth = 1
  while (frontier.length > 0 && rows.length < maxRows) {
    const next: string[] = []
    for (const runId of frontier) {
      const edges =
        direction === 'upstream' ? edgesInto(traversal, runId) : edgesOutOf(traversal, runId)
      for (const edge of edges) {
        const otherId = direction === 'upstream' ? edge.producerRunId : edge.consumerRunId
        if (typeof otherId !== 'string' || reached.has(otherId)) continue
        const row = rowFor(index, otherId, edge, depth, false)
        if (row === null) continue
        if (rows.length >= maxRows) break
        reached.add(otherId)
        rows.push(row)
        next.push(otherId)
      }
    }
    frontier = next
    depth += 1
  }

  return { rows, reached }
}

/** Cap on rendered rows per direction. A ladder nobody can scan is not a ladder. */
export const MAX_LADDER_ROWS = 120

export function buildLadder(
  traversal: CausalTraversal,
  direction: 'upstream' | 'downstream',
): Ladder {
  const { rows, reached } = walk(traversal, direction, MAX_LADDER_ROWS)

  const orphanNodeIds: string[] = []
  const nodes = Array.isArray(traversal?.nodes) ? traversal.nodes : []
  for (const n of nodes) {
    if (n === null || typeof n !== 'object') continue
    if (typeof n.runId !== 'string') continue
    if (!reached.has(n.runId)) orphanNodeIds.push(n.runId)
  }

  // Upstream reads top-to-bottom in the direction causation flowed: the
  // furthest producer first, the subject last. Downstream keeps walk order.
  const ordered = direction === 'upstream' ? [...rows].reverse() : rows

  return { direction, rows: ordered, orphanNodeIds }
}
