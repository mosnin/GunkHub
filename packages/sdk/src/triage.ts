/**
 * `afr_triage` — the entry point. Pure ranking and projection; the tool module
 * (`tools/triage.ts`) is a thin shell around this.
 *
 * WHY THIS EXISTS
 * ---------------
 * The four-tier ladder works and it is measured: ~284 tokens to learn what is
 * broken, ~423 for the evidence behind one pattern, ~121 to explain a run,
 * ~3 838 for a window of raw events. What the ladder did NOT have was an
 * obvious bottom rung.
 *
 * An agent arriving cold has no reason to start cheap. The CRUD instinct is
 * "fetch the run" — tier 4, ~3 838 tokens, and it answers nothing useful
 * because the agent does not yet know which run. A ladder whose bottom rung is
 * not the obvious one is a ladder people fall off.
 *
 * So this tool answers, in ONE call with ZERO required arguments, the question
 * an agent actually arrives with: *what is wrong right now, and what should I
 * look at first?*
 *
 * FOUR CONSTRAINTS, AND THEY ARE THE WHOLE DESIGN
 * -----------------------------------------------
 * 1. CHEAP. Budgeted at or under tier 2 (450 tokens). If triage cost more than
 *    calling tier 1 and tier 2 yourself (~707 together), it would be a FIFTH
 *    TIER PRETENDING TO BE A SHORTCUT and it should not exist. The budget is
 *    asserted against contract-maximal input in
 *    `tests/unit/mcp_triage.test.ts`, not hoped for.
 *
 * 2. NEXT-HOP POINTERS, NOT JUST DATA. Every item carries `next`, the exact
 *    tool name and argument object to call for more. An agent should never
 *    have to INFER the ladder; the response hands it the next rung. Exactly
 *    ONE pointer per item, chosen by signal — offering two would re-create,
 *    per item, the choice problem this tool exists to remove.
 *
 * 3. RANKED, AND THE RANKING IS EXPLAINED. See {@link SIGNAL_WEIGHT} below for
 *    the full justification. A ranking nobody can explain is one nobody will
 *    trust, so the weights, the tiering property, and the reason each term is
 *    shaped the way it is are all written down here rather than tuned to hit a
 *    number.
 *
 * 4. HONEST ABOUT EMPTINESS. "Nothing is broken" and "I could not evaluate"
 *    are different answers. {@link TriageResult.verdict} distinguishes `clear`
 *    from `unknown`, and {@link TriageResult.complete} states separately
 *    whether the view behind ANY verdict was whole — because "these are the
 *    worst three things in your org" and "these are the worst three of the
 *    fifty I happened to see" are also different answers.
 *
 * WHAT THIS TOOL IS NOT. It is not a new data source. It reads exactly what
 * tier 1 reads, from the same endpoint, with a field selection derived the same
 * way. Everything below is ordering, capping and pointer construction over that
 * one response. There is no second fact here to disagree with the first.
 */
import { columnsOf, requestFieldsOf, truncateProse } from './projection.js'
import { isPatternScanComplete } from './reader.js'

import type { ProjectedColumn } from './projection.js'
import type {
  FixConfidenceEntry,
  V1ListFailurePatternsData,
  V1ListFixConfidenceEnvelope,
} from './reader.js'
import type { FailurePattern } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Ranking — signal class
// ---------------------------------------------------------------------------

/**
 * The signal a pattern is ranked under. Emitted verbatim so a caller can see
 * WHY an item is where it is without re-deriving anything.
 *
 * - `regressed`   — it was resolved, and it came back after that resolution.
 * - `spiking`     — the spike detector's most recent assessment flagged it.
 * - `open`        — recurring, and nobody has claimed to have looked at it.
 * - `acknowledged`— a human has seen it and has not fixed it.
 * - `resolved`    — a live resolution with no post-resolution recurrence.
 */
export type TriageSignal = 'regressed' | 'spiking' | 'open' | 'acknowledged' | 'resolved'

/**
 * THE RANKING, AND WHY IT IS THIS RANKING.
 *
 * Ordering by count alone puts the loudest thing first, which is usually the
 * thing everyone already knows about. Ordering by recency alone puts the
 * newest singleton first. Neither answers "what should I look at FIRST", so
 * the ranking is a signal class first, broken by recency and volume.
 *
 * THE ORDER, WITH THE ARGUMENT FOR EACH STEP:
 *
 * - `regressed` FIRST, above everything. A regression is not merely a failure;
 *   it is a FALSE BELIEF LIVING IN THE SYSTEM. Someone asserted this was
 *   fixed, the product recorded that assertion, and the evidence now
 *   contradicts it. Everyone downstream — a dashboard, a CI gate, the next
 *   engineer — is currently reasoning from something known to be wrong. A
 *   known-wrong belief is strictly worse than a known-unknown, which is what
 *   every other row on this list is. This is the "regressed-and-confirmed-
 *   fixed outranks never-resolved" rule.
 *
 * - `spiking` SECOND. A spike is a CHANGE, and a change is the only signal
 *   here that carries information about *when* something started. A pattern
 *   that has failed at a steady rate for a month is a known cost; one that
 *   quadrupled this morning is a new event, and the causal window for it is
 *   still open.
 *
 * - `open` THIRD, above `acknowledged`. Both are unfixed; the difference is
 *   whether a human has looked. Triage answers "what should I look at first",
 *   and unseen strictly beats seen-and-deferred for that question. Someone
 *   already made a judgement about the acknowledged one.
 *
 * - `resolved` LAST but NOT ZERO. A resolution that is holding is still a
 *   fact worth surfacing when nothing else is wrong, and dropping it outright
 *   would make an all-resolved org indistinguishable from an empty one — the
 *   exact conflation constraint 4 exists to prevent.
 *
 * THE WEIGHTS ARE SPACED SO THE TIERS CANNOT INTERLEAVE. The gap between
 * adjacent weights is 40, and the tie-breakers below sum to at most
 * {@link MAX_TIEBREAK} = 35. So recency and volume ORDER WITHIN a signal class
 * and can never promote an item across one. That property is the whole reason
 * the ranking is explainable in one sentence: read the signal, then read the
 * position within it. If a future change widens the tie-breakers past 40 the
 * property silently dies, so `tests/unit/mcp_triage.test.ts` asserts it
 * directly rather than trusting the arithmetic to stay true.
 */
export const SIGNAL_WEIGHT: Record<TriageSignal, number> = {
  regressed: 200,
  spiking: 160,
  open: 120,
  acknowledged: 80,
  resolved: 40,
}

/** Maximum recency contribution, for a pattern seen just now. */
export const RECENCY_WEIGHT = 20
/**
 * Half-life of the recency term, in ms. A day: a failure last seen 24 h ago is
 * worth half the urgency of the same failure seen an hour ago, and one last
 * seen a week ago has essentially decayed out. Exponential rather than a
 * cliff, so nothing changes rank discontinuously as the clock ticks past a
 * threshold.
 */
export const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000

/** Maximum volume contribution, for a pattern with ~100+ occurrences. */
export const VOLUME_WEIGHT = 15
/**
 * Volume is LOG-SCALED, deliberately. Linear volume would let one 10 000-count
 * pattern drown every other row, and "the biggest number" is not the same
 * question as "what should I look at first" — a fresh regression with three
 * occurrences is more actionable than a well-understood tenth-of-a-percent
 * error rate. log10 saturates the term at ~100 occurrences: past that, more
 * volume tells you nothing new about priority.
 */
export const VOLUME_SATURATION = 100

/** The most the tie-breakers can contribute. Must stay under the 40-point signal gap — see {@link SIGNAL_WEIGHT}. */
export const MAX_TIEBREAK = RECENCY_WEIGHT + VOLUME_WEIGHT

/**
 * Demotion applied to a MUTED pattern — larger than any achievable score, so a
 * muted pattern always sorts below every unmuted one while keeping its order
 * relative to other muted ones.
 *
 * Muting suppresses ALERTING, not existence, so a muted pattern is never
 * dropped from the response and is always flagged `muted: true`. But an org
 * admin muting a fingerprint is a human saying "stop putting this in front of
 * me", and a tool whose entire job is to answer "what should I look at first"
 * has no business overriding that. Surfaced, ranked last, labelled.
 */
export const MUTE_DEMOTION = 1000

/**
 * Classify a pattern's signal.
 *
 * REGRESSION IS DETECTED TWO WAYS, AND BOTH ARE NEEDED.
 *
 * The authoritative answer is the fix-confidence verdict (`state ===
 * 'regressed'`), which means a recurrence strictly after the LIVE resolution.
 * But that verdict is snapshot-backed and a deployment may not serve it at
 * all — in which case silently reporting `open` would be exactly the false
 * confidence this product exists to remove.
 *
 * So the fallback reads the rollup's own `regressedAt` against `resolvedAt`.
 * The comparison is the load-bearing part: `regressedAt` is deliberately
 * PRESERVED as history across a re-resolve, so `regressedAt != null` alone
 * also matches a pattern that regressed, was genuinely re-fixed, and was
 * re-resolved. Requiring `regressedAt > resolvedAt` keeps the fallback
 * answering the same question as the verdict rather than a looser one.
 *
 * @param pattern - the rollup.
 * @param confidence - the matching fix-confidence entry, when the deployment served one.
 */
export function classifySignal(pattern: FailurePattern, confidence?: FixConfidenceEntry): TriageSignal {
  if (confidence?.state === 'regressed') return 'regressed'
  if (
    pattern.regressedAt !== undefined &&
    pattern.resolvedAt !== undefined &&
    pattern.regressedAt > pattern.resolvedAt
  ) {
    return 'regressed'
  }
  if (pattern.lastSpikeAssessment?.isSpiking === true) return 'spiking'
  const status = pattern.status ?? 'open'
  if (status === 'resolved') return 'resolved'
  if (status === 'acknowledged') return 'acknowledged'
  return 'open'
}

/**
 * Score one pattern. Higher sorts first.
 *
 * @param pattern - the rollup.
 * @param signal - its class, from {@link classifySignal}.
 * @param now - the clock, injected so the recency term is testable.
 */
export function scorePattern(pattern: FailurePattern, signal: TriageSignal, now: number): number {
  const ageMs = Math.max(0, now - pattern.lastSeenAt)
  const recency = RECENCY_WEIGHT * Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS)
  const volume = VOLUME_WEIGHT * Math.min(1, Math.log10(Math.max(1, pattern.count)) / Math.log10(VOLUME_SATURATION))
  const demotion = pattern.muted === true ? MUTE_DEMOTION : 0
  return Math.round(SIGNAL_WEIGHT[signal] + recency + volume - demotion)
}

// ---------------------------------------------------------------------------
// Field selection
// ---------------------------------------------------------------------------

/** One ranked item. Six scalars, a signal, a score, and the next rung. */
export interface TriageItem {
  fingerprintHash: string
  class: string
  /** Capped at {@link LABEL_BYTE_CAP} bytes with an explicit in-band marker. */
  label: string
  count: number
  lastSeenAt: number
  signal: TriageSignal
  /** The ranking score. Emitted so the ordering is auditable, not just asserted. */
  score: number
  /** Present, and only ever `true`, when an admin has muted this fingerprint. Muted items always sort last. */
  muted?: true
  /** THE NEXT RUNG. Call this tool with these arguments verbatim. */
  next: TriagePointer
}

/**
 * WHY THERE IS NO `confidenceState` ON A TRIAGE ITEM, even though the envelope
 * that reaches this module carries one per pattern.
 *
 * Measured, it costs ~49 tokens across five items — an ninth of the whole
 * budget — and the information is either already here or belongs one tier down:
 *
 *   - The one confidence state that changes what you should do FIRST is
 *     `regressed`, and that is already the `signal`. It is read here (see
 *     {@link classifySignal}) precisely so it can rank.
 *   - `unproven` / `proving` / `confirmed` grade a fix that has NOT come back.
 *     "Did the fix hold, and how sure are we?" is the literal question
 *     `afr_get_pattern_evidence` exists to answer, with all ten drivers behind
 *     the number — and the item's `next` already points there. Repeating the
 *     bare state here would buy a caller a word it cannot act on without the
 *     follow-up call it is being handed anyway.
 *
 * STALENESS IS NOT LOST BY THIS. `confidenceStale` existed to stop a stale
 * verdict being read as a fresh one. A stale snapshot can UNDER-report but
 * never over-report, and `regressed` is written eagerly by the regression guard
 * rather than waiting for a cron tick — so the one state triage acts on is
 * never the stale one. What genuinely cannot be graded is still reported, at
 * the result level, by {@link TriageResult.unevaluated}.
 */

/** An executable next hop: a tool name and the exact argument object to pass it. */
export interface TriagePointer {
  tool: string
  args: Record<string, string | number>
}

/**
 * `afr_triage`'s emitted column table, same derivation discipline as every
 * other projection in this package: the emitted list and the requested list are
 * one declaration, never two that can drift.
 *
 * Triage is NOT columnar, unlike tier 1 — each item carries a nested `next`
 * pointer, and positional rows cannot express one without either flattening the
 * pointer into two more columns (losing the "call this verbatim" property that
 * is the point) or nesting an object inside a positional row (worse than the
 * object it replaced). At five items the repeated key names cost ~60 tokens;
 * columnar is a compression for REPETITION, and five is not repetition enough
 * to pay for losing the pointer.
 *
 * `null` sources are two of tier 1's three cases: `fingerprintHash` is the
 * identity field the read API returns regardless (rule 3), and `signal`,
 * `score` and `next` are COMPUTED here rather than read from any document.
 */
export const TRIAGE_COLUMNS = [
  { column: 'fingerprintHash', source: null },
  { column: 'class', source: 'class' },
  { column: 'label', source: 'label' },
  { column: 'count', source: 'count' },
  { column: 'lastSeenAt', source: 'lastSeenAt' },
  { column: 'signal', source: null },
  { column: 'score', source: null },
  { column: 'muted', source: 'muted' },
  { column: 'next', source: null },
] as const satisfies readonly ProjectedColumn<keyof TriageItem>[]

/** The columns triage emits. DERIVED from {@link TRIAGE_COLUMNS}. */
export const TRIAGE_FIELDS: readonly (keyof TriageItem)[] = columnsOf(TRIAGE_COLUMNS)

/**
 * Document fields triage READS but never EMITS.
 *
 * These cannot live in the column table above — that table pairs an emitted
 * column with its source, and none of these is emitted. But they still have to
 * reach the request, because a field the server does not send is a field the
 * ranking silently treats as absent: without `regressedAt`/`resolvedAt` every
 * regression on a deployment without fix-confidence would classify as `open`,
 * and the tool would confidently rank a broken fix below a new singleton.
 *
 * Each entry states what it is for, because an unexplained name in a field
 * selection is the first thing a future reader deletes as unused:
 *   - `regressedAt`, `resolvedAt` — the regression fallback in {@link classifySignal}.
 *   - `status`                    — open vs acknowledged vs resolved.
 *   - `lastSpikeAssessment`       — the `spiking` signal.
 *   - `representativeRunIds`      — the `afr_explain_run` pointer target. Only `[0]` is ever read.
 */
export const TRIAGE_RANKING_SOURCES: readonly string[] = [
  'regressedAt',
  'resolvedAt',
  'status',
  'lastSpikeAssessment',
  'representativeRunIds',
]

/**
 * The `fields` selection `afr_triage` sends: emitted sources plus ranking
 * sources, deduped, declaration order preserved.
 */
export const TRIAGE_REQUEST_FIELDS: readonly string[] = [
  ...new Set([...requestFieldsOf(TRIAGE_COLUMNS), ...TRIAGE_RANKING_SOURCES]),
]

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * How many patterns to consider before ranking.
 *
 * This is an UPSTREAM cost, not a context cost — the caller pays for
 * {@link MAX_ITEMS}, whatever this is. It is set well above the emitted count
 * because a top-5 chosen from 5 is not a ranking, and because a pattern that
 * belongs at the top can be well down the server's most-recently-seen ordering
 * (a high-volume regression that last fired six hours ago sits behind every
 * fresh singleton). 50 with a field selection is a cheap read; anything the
 * scan misses is reported as `complete: false` rather than quietly excluded.
 */
export const SCAN_LIMIT = 50

/**
 * How many items to emit. HARD — there is no `limit` argument that raises it.
 *
 * Triage is a headline, not a list. An unranked list of ten is the same problem
 * one level up, and the 450-token budget is measured AT this number: a caller-
 * raisable cap would mean the measured cost is not the cost. An agent that
 * genuinely wants breadth has `afr_list_failure_patterns`, which is what the
 * top-level `next` points at when the scan was truncated.
 */
export const MAX_ITEMS = 5

/**
 * Byte cap on an emitted `label`, with the same explicit in-band marker tier 3
 * uses for prose. `label` is derived free text with no contract bound, so a
 * runaway one could take the whole budget on its own. 64 bytes is above any
 * realistic label, so ordinary output passes through untouched.
 */
export const LABEL_BYTE_CAP = 64

/** How many `unevaluated` fingerprints to name. Three: enough to act on, not enough to cost a tier. */
export const TRIAGE_UNEVALUATED_SAMPLE_CAP = 3

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * What triage found.
 *
 * `clear` and `unknown` ARE NOT THE SAME ANSWER and must never be collapsed.
 * `clear` is "the scan completed and found nothing"; `unknown` is "I could not
 * evaluate". A tool that reports the second as the first has told a caller its
 * agents are healthy when it actually failed to look — which is the specific
 * mistake this codebase has shipped before.
 */
export type TriageVerdict = 'issues' | 'clear' | 'unknown'

/** `afr_triage`'s response. */
export interface TriageResult {
  verdict: TriageVerdict
  /**
   * Whether the view behind the verdict was WHOLE. Orthogonal to `verdict` on
   * purpose: `verdict: 'issues', complete: false` is a real and common state —
   * "these are the worst of what I saw", not "the worst that exist" — and
   * folding it into the verdict would either overstate a partial result or
   * discard a useful one.
   */
  complete: boolean
  /** How many patterns were considered. */
  scanned: number
  /** Ranked items, best-first. At most {@link MAX_ITEMS}. */
  items: TriageItem[]
  /**
   * Every reason `complete` is false, in plain sentences. Present only when
   * non-empty — a caveat list that is always there stops being read.
   */
  caveats?: string[]
  /**
   * Patterns with a live resolution but NO usable confidence snapshot: their
   * fix state could not be graded at all. Named rather than dropped, because
   * "could not evaluate these" is a different answer from "these are fine".
   */
  unevaluated?: { count: number; sample: string[] }
  /**
   * Present, and only ever `true`, when the SERVER's scan stopped on its row
   * ceiling rather than on the end of the table — the marker Convex computes,
   * the v1 route forwards and the SDK types.
   *
   * DISTINCT FROM A TRUNCATED RANKING WINDOW, and both are reported because
   * they are different failures:
   *
   *   - a `nextCursor` means more patterns exist than the {@link SCAN_LIMIT}
   *     this tool ranked. The scan was fine; the RANKING's scope was not, so
   *     "these are the worst" is really "these are the worst of the 50 I
   *     looked at".
   *   - `scanTruncated` means the server could not even finish scanning that
   *     window. A short or EMPTY page can then be an artefact of the ceiling,
   *     so an empty `items` is not evidence of health at all.
   *
   * The second is strictly worse than the first, so it is what the caveat
   * names when both fire.
   */
  scanTruncated?: true
  /**
   * The next rung when the ITEMS are not the answer — a truncated scan, or
   * nothing found at all. Absent when the items themselves carry the next hops.
   */
  next?: TriagePointer
}

/**
 * Choose an item's next hop.
 *
 * The rule is the question the item raises:
 *
 * - A pattern with a LIVE RESOLUTION, or one that regressed, raises "did the
 *   fix hold?" — which is precisely tier 2. Sending it to a run instead would
 *   answer a question nobody asked.
 * - Anything else raises "why does this happen?", and the cheapest real answer
 *   is the cached explanation for a run that exhibited it. `representativeRunIds`
 *   is a bounded, most-recent-first sample maintained on the rollup, so `[0]`
 *   is a recent concrete instance — and tier 3 is ~121 tokens, an order of
 *   magnitude under fetching that run's events.
 * - With no representative run recorded, tier 2 is the fallback rather than
 *   nothing: an item without a next hop puts the caller back to guessing.
 */
export function choosePointer(pattern: FailurePattern, signal: TriageSignal): TriagePointer {
  const evidence: TriagePointer = {
    tool: 'afr_get_pattern_evidence',
    args: { fingerprintHash: pattern.fingerprintHash },
  }
  if (signal === 'regressed' || signal === 'resolved' || pattern.resolvedAt !== undefined) return evidence
  const runId = pattern.representativeRunIds[0]
  if (runId === undefined) return evidence
  return { tool: 'afr_explain_run', args: { runId } }
}

/** Project one ranked pattern onto its emitted item. */
export function toTriageItem(pattern: FailurePattern, signal: TriageSignal, score: number): TriageItem {
  const item: TriageItem = {
    fingerprintHash: pattern.fingerprintHash,
    class: pattern.class,
    label: truncateProse(pattern.label, LABEL_BYTE_CAP),
    count: pattern.count,
    lastSeenAt: pattern.lastSeenAt,
    signal,
    score,
    next: choosePointer(pattern, signal),
  }
  if (pattern.muted === true) item.muted = true
  return item
}

/**
 * Build the triage response.
 *
 * @param patterns - the scanned page of rollups, in whatever order the server returned them.
 * @param envelope - the response's `fixConfidence` envelope, absent on a deployment that predates it.
 * @param nextCursor - the scan's cursor. Its PRESENCE means more patterns exist than were ranked.
 * @param now - the clock, injected so the recency term is testable.
 * @param scan - the response's scan markers. OPTIONAL and additive: an omitted
 *   argument reads as an undeclared marker, which {@link isPatternScanComplete}
 *   resolves to "complete".
 */
export function toTriageResult(
  patterns: FailurePattern[],
  envelope: V1ListFixConfidenceEnvelope | undefined,
  nextCursor: string | undefined,
  now: number,
  scan?: Pick<V1ListFailurePatternsData, 'scanTruncated'>,
): TriageResult {
  const byHash = new Map<string, FixConfidenceEntry>()
  for (const entry of envelope?.entries ?? []) byHash.set(entry.fingerprintHash, entry)

  const ranked = patterns
    .map((pattern) => {
      const confidence = byHash.get(pattern.fingerprintHash)
      const signal = classifySignal(pattern, confidence)
      return { pattern, signal, score: scorePattern(pattern, signal, now), confidence }
    })
    // Descending score. `fingerprintHash` breaks an exact tie so the ordering
    // is TOTAL and therefore reproducible — two calls a millisecond apart must
    // not shuffle equal-scoring items, or a caller cannot tell a real change
    // in priority from sort noise.
    .sort((a, b) => b.score - a.score || (a.pattern.fingerprintHash < b.pattern.fingerprintHash ? -1 : 1))

  const items = ranked
    .slice(0, MAX_ITEMS)
    .map(({ pattern, signal, score }) => toTriageItem(pattern, signal, score))

  // ---- honesty accounting -------------------------------------------------
  const caveats: string[] = []
  // Two independent incompleteness signals — see `TriageResult.scanTruncated`
  // for why the real marker did NOT simply replace the cursor proxy. The
  // cursor answers "was the RANKING's window whole?", which is this tool's own
  // limit and is not something the server marker knows about; the marker
  // answers "was the SERVER's scan whole?", which no cursor can tell you.
  // Dropping either would under-declare a real gap.
  const windowTruncated = nextCursor !== undefined
  const serverScanTruncated = !isPatternScanComplete(scan ?? {})
  // Caveat text is TERSE on purpose. These are the honesty channel, so they
  // must always be readable — but a paragraph per caveat costs ~40 tokens of a
  // 450-token budget, and a caveat block that eats a tenth of the response is
  // one a caller learns to skip. One sentence each, naming the defect and its
  // consequence, and nothing else.
  // ONE caveat covers both truncation kinds, naming the worse one when both
  // fire (a server-side ceiling always also yields a resumable cursor, so
  // "both" is the normal truncation case, and two sentences saying overlapping
  // things would cost ~20 tokens of a 450-token budget to say it twice).
  if (serverScanTruncated) {
    caveats.push('Server scan hit its row ceiling; patterns may be missing entirely.')
  } else if (windowTruncated) {
    caveats.push(`Scan truncated at ${String(SCAN_LIMIT)} patterns; ranking covers only what was scanned.`)
  }
  if (envelope === undefined) {
    caveats.push('This deployment served no fix confidence; regressions inferred from regressedAt alone.')
  }
  const unevaluated = envelope?.unevaluated ?? []
  if (unevaluated.length > 0) {
    // Points at `unevaluated` rather than restating its count and meaning. The
    // caveat's job is to say a defect EXISTS and name where the detail is; the
    // detail is already a structured field, and paying for it twice is ~15
    // tokens of a 450-token budget spent on a sentence the field already says.
    caveats.push('Some resolutions could not be graded — see `unevaluated`.')
  }
  // NOT a caveat: emitting {@link MAX_ITEMS} of `scanned` is the design, not an
  // incompleteness of the view, and `scanned` vs `items.length` already states
  // it for free. A caveat that fires on every ordinary call would make
  // `complete` permanently false and the list permanently unread.

  const complete = caveats.length === 0
  // `unknown` only when there is nothing to show AND something prevented a
  // whole look. Nothing to show after a whole look is `clear`, and it is a real
  // answer worth stating plainly.
  const verdict: TriageVerdict = items.length > 0 ? 'issues' : complete ? 'clear' : 'unknown'

  const result: TriageResult = { verdict, complete, scanned: patterns.length, items }
  if (serverScanTruncated) result.scanTruncated = true
  if (caveats.length > 0) result.caveats = caveats
  if (unevaluated.length > 0) {
    result.unevaluated = {
      count: unevaluated.length,
      sample: unevaluated.slice(0, TRIAGE_UNEVALUATED_SAMPLE_CAP),
    }
  }

  // A top-level next hop only where the ITEMS are not the answer. When the scan
  // was truncated the cursor is forwarded verbatim, so continuing is a
  // mechanical call rather than a guess; when nothing was found at all, failed
  // runs are the place to look for a failure that has not fingerprinted yet.
  if (nextCursor !== undefined) {
    result.next = { tool: 'afr_list_failure_patterns', args: { cursor: nextCursor, limit: 100 } }
  } else if (items.length === 0) {
    result.next = { tool: 'afr_list_runs', args: { status: 'failed', limit: 20 } }
  }

  return result
}
