import { parseArgs } from 'node:util'

import { getFailurePatternEvidence } from '../apiClient.js'
import { formatTimestamp } from '../format.js'

import { isCommandFailure, readEnv, resolveApiConfig, toCommandFailure } from './shared.js'

import type { CommandFailure } from './shared.js'
import type { ApiFetchLike, V1PatternEvidenceData } from '../apiClient.js'
import type { CliEnv } from '../env.js'

export const PATTERNS_EVIDENCE_HELP = `Usage: afr patterns evidence <fingerprintHash> [options]

Show whether a failure pattern's fix actually HELD (ADR-006, "prove the fix
held"). Marking a pattern resolved is an unearned assertion on its own — this
command shows what can be checked against that claim:

  - the resolution: when, by whom, the note/ref, and the agent version the fix
    was believed to ship in
  - the exposure: how many runs have actually executed since the fix, and how
    many times the pattern recurred anyway
  - the confidence: a graded verdict (score 0-0.95 and a state) over both,
    with every driver that produced it
  - the transitions: the pattern's lifecycle history, reconstructed from the
    append-only audit log (including automatic reopens by the regression
    guard, which appear with actor "system")

States:
  unproven    Resolved, but nothing has exercised the code path since. NOT a
              success — an untested fix. Zero exposure is always unproven.
  proving     Real exposure is accumulating without recurrence, but not yet
              enough to stake a deploy on.
  confirmed   Enough clean exposure that a still-live pattern would very
              probably have fired again by now.
  regressed   The pattern fired again after the fix. It did not hold. This is
              the only state backed by direct proof.

Options:
  --json              Print the raw API response as JSON
  --help              Show this message

Scripting this in CI:
  afr patterns evidence <fingerprint> --json | jq -e '.confidence.state != "regressed"'

  Gate on 'confidence.state', not on 'exposure.heldSoFar' — heldSoFar is true
  for a fix nothing has run yet. The state already encodes that difference as
  'unproven'. Note the score is 0-1 (never 1.0), not a percentage, and
  exposure.runCount is a FLOOR when exposure.runCountTruncated is true.

Note: this command is READ-ONLY, like every 'afr' command that touches the
lifecycle. There is no 'afr patterns resolve/acknowledge/reopen' — those are
member-gated, audited, Clerk-authed org actions taken in the web app. An API
key has no human actor, and the audit log exists to record which PERSON made
a privileged change. Reading proof that a fix held needs no actor; asserting
that it held does.
`

export interface PatternsEvidenceArgs {
  fingerprintHash?: string
  json?: boolean
  help?: boolean
}

/** Parse `afr patterns evidence` flags (argv AFTER `patterns evidence`). */
export function parsePatternsEvidenceArgs(argv: string[]): PatternsEvidenceArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const result: PatternsEvidenceArgs = {}
  if (positionals[0]) result.fingerprintHash = positionals[0]
  if (values['json']) result.json = true
  if (values['help']) result.help = true
  return result
}

export type PatternsEvidenceResult = (V1PatternEvidenceData & { ok: true }) | CommandFailure

/** `afr patterns evidence <fingerprintHash>` — fix-confidence evidence through the v1 read API. */
export async function runPatternsEvidence(
  fingerprintHash: string,
  env: CliEnv = readEnv(),
  fetchImpl?: ApiFetchLike
): Promise<PatternsEvidenceResult> {
  const config = resolveApiConfig(env)
  if (isCommandFailure(config)) return config

  try {
    const data = await getFailurePatternEvidence(config, fingerprintHash, fetchImpl)
    return { ok: true, ...data }
  } catch (err) {
    return toCommandFailure(err)
  }
}

/** Render a 0..1 score as a percentage, making the reserved ceiling legible rather than surprising. */
function formatScore(score: number): string {
  return `${(score * 100).toFixed(0)}%`
}

/** `runCount` is a floor when the scan ceiling was hit — never render a capped number as if it were exact. */
function formatRunCount(count: number, truncated: boolean): string {
  return truncated ? `${String(count)}+` : String(count)
}

function formatElapsed(ms: number): string {
  const hours = ms / (60 * 60 * 1000)
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

/** One-line plain-English reading of why the score is where it is. */
function explainLimit(evidence: V1PatternEvidenceData): string | undefined {
  const confidence = evidence.confidence
  if (!confidence) return undefined
  switch (confidence.limitingFactor) {
    case 'recurrence':
      return 'The pattern recurred after the fix — prior clean exposure is refuted by the counter-example, not averaged with it.'
    case 'no-resolution':
      return 'No resolution has been recorded for this pattern.'
    case 'version-mismatch':
      return 'Exposure could not be attributed to the version the fix shipped in, so it does not count toward confidence.'
    case 'no-exposure':
      return 'Nothing has run since the fix — this is an untested fix, not a proven one.'
    case 'accumulating':
      return 'Evidence is still accumulating: more clean runs and more calendar time both raise this.'
    case 'none':
      return undefined
  }
}

export function printPatternsEvidence(
  args: PatternsEvidenceArgs,
  result: PatternsEvidenceResult,
  log: (line: string) => void = console.log
): void {
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return
  }

  if (args.json) {
    log(JSON.stringify(result, null, 2))
    return
  }

  const { pattern, resolution, exposure, confidence, transitions } = result

  log(`${pattern.class} — ${pattern.label}`)
  log(`  fingerprint: ${pattern.fingerprintHash}`)
  log(`  occurrences: ${String(pattern.count)} (first ${formatTimestamp(pattern.firstSeenAt)}, last ${formatTimestamp(pattern.lastSeenAt)})`)
  log('')

  if (!resolution || !exposure || !confidence) {
    log(`Status: ${pattern.status ?? 'open'} — no resolution on record, so there is nothing to prove yet.`)
    log("Resolve it in the web app (member-gated and audited), then re-run this command to watch the evidence accumulate.")
    return
  }

  const header = `${confidence.state.toUpperCase()}  (confidence ${formatScore(confidence.score)})`
  log('='.repeat(Math.min(60, Math.max(20, header.length + 10))))
  log(`  ${header}`)
  log('='.repeat(Math.min(60, Math.max(20, header.length + 10))))
  log('')

  log('Resolution claimed:')
  log(`  at:        ${formatTimestamp(resolution.resolvedAt)}`)
  if (resolution.resolvedByUserId) log(`  by:        ${resolution.resolvedByUserId}`)
  if (resolution.resolvedInVersion !== undefined || resolution.resolvedInVersionId !== undefined) {
    log(`  version:   ${resolution.resolvedInVersion ?? resolution.resolvedInVersionId ?? ''}`)
  }
  if (resolution.resolutionNote) log(`  note:      ${resolution.resolutionNote}`)
  if (resolution.resolutionRef) log(`  ref:       ${resolution.resolutionRef}`)
  log('')

  log('Exposure since the fix:')
  log(`  runs:        ${formatRunCount(exposure.runCount, exposure.runCountTruncated)}${exposure.runCountTruncated ? ' (scan ceiling hit — this is a floor)' : ''}`)
  log(`  recurrences: ${String(exposure.recurrenceCount)}`)
  if (exposure.baselineRunCount !== undefined) {
    // A TRAILING baseline (the 14 days before the fix), shown for comparison
    // only — deliberately never subtracted from `runs` above.
    log(`  baseline:    ${String(exposure.baselineRunCount)} runs in the 14 days before the fix (for comparison)`)
  }
  log(`  soak:        ${formatElapsed(confidence.elapsedMs)}`)
  log(`  agents:      ${exposure.agentIds.length > 0 ? exposure.agentIds.join(', ') : '(none recorded)'}`)
  log('')

  const limit = explainLimit(result as V1PatternEvidenceData)
  if (limit) {
    log('Why not higher:')
    log(`  ${limit}`)
    log('')
  }

  if (confidence.versionAttribution === 'unknown' && resolution.resolvedInVersionId) {
    log('Note: exposure is counted per agent, not per agent version, so it cannot be')
    log('      attributed to the fix version — version attribution reads "unknown".')
    log('')
  }

  if (transitions.length > 0) {
    log(`Lifecycle (${String(transitions.length)} transition${transitions.length === 1 ? '' : 's'}, oldest first):`)
    for (const transition of transitions) {
      log(`  ${formatTimestamp(transition.timestamp)}  ${transition.action}  (${transition.actorClerkUserId})`)
    }
  }
}
