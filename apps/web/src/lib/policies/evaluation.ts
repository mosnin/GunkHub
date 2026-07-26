/**
 * lib/policies/evaluation.ts — reading an evaluation body into what a screen
 * shows, with NO Convex client and NO environment anywhere in the import graph.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF services/policies.ts
 * ===========================================================================
 *
 * Everything here is PURE over a body that arrived from the wire, and it is the
 * layer every honesty property in this feature actually lives in: the
 * fail-closed defaults, the demotion, the prose guard, the ordering. That is
 * exactly the code that most needs to be exercised directly, over hostile
 * literals, in a DOM test — and it could not be, while it sat in a module whose
 * first import pulls in the Convex client and `lib/env.ts`, which throws without
 * a Clerk publishable key.
 *
 * A test that cannot reach the honesty layer without booting a deployment is a
 * test nobody writes. So the seam is here: `services/policies.ts` does the I/O
 * and calls into this, and `tests/unit/policy_ui_three_states.test.tsx` holds
 * this over literals.
 */
import { complianceClaimIn, type PolicyVerdict } from '@agent-flight-recorder/contracts'

import { readVerdict } from '@/lib/policies/localWire'
import { orderOutcomes, readOutcomes, type PolicyOutcomeView } from '@/lib/policies/outcomes'


/**
 * An evaluation as this UI shows it.
 *
 * `verdict` and `verdictStatement` are the SERVER'S, read rather than recomputed
 * — recomputing here would be a second opinion that can disagree with the one
 * the CLI and the SDK get from the same body, and the disagreement would surface
 * as two screens showing different compliance answers for the same runs.
 *
 * The three counts are present TOGETHER, or the type does not compile. There is
 * no total and no ratio anywhere in this shape.
 */
export interface PolicyEvaluationView {
  readonly evaluatedAt: number
  readonly verdict: PolicyVerdict
  readonly verdictStatement: string
  /** Violations first, always. See `orderOutcomes`. */
  readonly outcomes: readonly PolicyOutcomeView[]
  readonly scan: PolicyScanView
}

/** What the evaluation actually covered. Every field is a coverage fact, not metadata. */
export interface PolicyScanView {
  readonly policiesInScope: number
  readonly policiesEvaluated: number
  readonly runsInScope: number
  readonly runsRead: number
  /** True when the evaluation stopped on a server ceiling: every count above is a FLOOR. */
  readonly evaluationTruncated: boolean
  /** Rows outside this org that were excluded entirely. Non-zero narrows every result. */
  readonly foreignRowsSkipped: number
}

export type PolicyEvaluationRead =
  | { kind: 'evaluation'; evaluation: PolicyEvaluationView }
  | { kind: 'unreadable'; because: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Read an evaluation body.
 *
 * ---------------------------------------------------------------------------
 * EVERY DEFAULT IN HERE POINTS TOWARD "WE DID NOT LOOK"
 * ---------------------------------------------------------------------------
 *
 *   `evaluationTruncated` FAILS CLOSED TO `true`. A dropped flag must never read
 *     as "this scan was complete".
 *   `policiesEvaluated` FALLS BACK TO `0` while `policiesInScope` falls back to
 *     the number of outcomes we could read, so an unreadable pair reports fewer
 *     policies evaluated than are in scope — which is `evaluation_incomplete`,
 *     never an all-clear.
 *   `foreignRowsSkipped` FALLS BACK TO `0` ONLY because a non-zero value can
 *     only come from the server saying so; there is no reading of a missing
 *     field that means "rows were skipped".
 *   `verdict` falls back through `readVerdict` to `evaluation_incomplete`.
 *
 * AND THE PROSE IS RE-CHECKED. `verdictStatement` is the sentence most likely to
 * be quoted out of this whole feature, and it is producer-supplied. A compliance
 * word in it is replaced wholesale rather than rendered — the badge coming back
 * through the one channel no field-name check covers is exactly the failure
 * contracts' `FORBIDDEN_COMPLIANCE_PROSE` exists to catch.
 */
export function readEvaluation(raw: unknown): PolicyEvaluationRead {
  if (!isRecord(raw)) {
    return {
      kind: 'unreadable',
      because:
        'the evaluation request returned something that is not an evaluation. Nothing was checked, and this is ' +
        'not a statement that nothing was found.',
    }
  }
  const outcomes = orderOutcomes(readOutcomes(raw['findings'] ?? raw['outcomes']))
  const scanRaw = isRecord(raw['scan']) ? raw['scan'] : {}
  const statement = raw['verdictStatement']
  const safeStatement =
    typeof statement === 'string' && statement.length > 0 && complianceClaimIn(statement) === null
      ? statement
      : 'The evaluation supplied no statement this interface could show. Read the per-policy outcomes below; ' +
        'the absence of a summary is not a summary saying nothing was found.'

  return {
    kind: 'evaluation',
    evaluation: {
      evaluatedAt: typeof raw['evaluatedAt'] === 'number' ? raw['evaluatedAt'] : 0,
      verdict: readVerdict(raw['verdict']),
      verdictStatement: safeStatement,
      outcomes,
      scan: {
        policiesInScope: count(scanRaw['policiesInScope'], outcomes.length),
        policiesEvaluated: count(scanRaw['policiesEvaluated'], 0),
        runsInScope: count(scanRaw['runsInScope'], 0),
        runsRead: count(scanRaw['runsRead'], 0),
        // FAILS CLOSED. See this function's header.
        evaluationTruncated: scanRaw['evaluationTruncated'] !== false,
        foreignRowsSkipped: count(scanRaw['foreignRowsSkipped'], 0),
      },
    },
  }
}

