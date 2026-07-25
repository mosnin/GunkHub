/**
 * `AgentConfigSnapshot` — making the divergence engine able to answer
 * something, without invalidating a byte of stored data.
 *
 * The product problem this closes: `configSnapshot` is free-form by decision
 * (ADR-0019), a free-form blob makes no checkable claims, and the engine
 * therefore correctly answers `indeterminate` for nearly every real run. A
 * replay test that mostly says "I cannot tell" is not cautious, it is
 * unusable — and it trains operators to click past the verdict, which is how a
 * real breaking change ships.
 *
 * The fix is NOT to weaken the anti-false-clean rule. Four properties are
 * pinned here, and the third is the one that would be catastrophic to get
 * wrong:
 *
 *   1. FREE-FORM STAYS LEGAL. An unmarked snapshot reads as undeclared, never
 *      as an error and never as empty.
 *   2. DECLARATION IS PER DIMENSION. Declaring tools alone buys real answers
 *      about tools, not a global pass and not a global shrug.
 *   3. AN INCOMPLETE LIST CAN NEVER PRODUCE A PROOF. A half-captured tool list
 *      treated as complete would report proven breakage for every tool that
 *      simply was not enumerated — a fabricated certainty, from a capture bug.
 *   4. "NONE" IS A REAL, CHECKABLE CLAIM, distinct from "unknown".
 */
import {
  AGENT_CONFIG_SNAPSHOT_SCHEMA,
  declaredDimensions,
  divergenceByDimension,
  readAgentConfigSnapshot,
  supportsProof,
} from '@agent-flight-recorder/contracts'
import {
  buildAgentConfigSnapshot,
  digestSystemPrompt,
  enumeratedTools,
  partialTools,
  toolsFromCalls,
} from '@agent-flight-recorder/sdk'
import { describe, expect, it } from 'vitest'

import type { DivergenceReport } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// 1. Free-form stays legal
// ---------------------------------------------------------------------------

describe('a free-form snapshot is undeclared, not invalid', () => {
  it('reads every unmarked value as free-form', () => {
    // Everything already stored looks like one of these. None may throw, and
    // none may be interpreted: `AgentVersion` is immutable, so there is no
    // migration that could ever fix a snapshot we chose to misread.
    expect(readAgentConfigSnapshot(undefined)).toBeNull()
    expect(readAgentConfigSnapshot(null)).toBeNull()
    expect(readAgentConfigSnapshot({})).toBeNull()
    expect(readAgentConfigSnapshot([1, 2, 3])).toBeNull()
    expect(readAgentConfigSnapshot('prompt: you are a helpful assistant')).toBeNull()
    expect(readAgentConfigSnapshot({ tools: ['search_web'], model: 'claude-sonnet-4-6' })).toBeNull()
  })

  it('does NOT read a lucky-shaped blob as a declaration', () => {
    // A free-form snapshot that happens to have a `tools` key never claimed to
    // be enumerating anything. Reading it as a complete tool list is exactly
    // the false-proof path — a tool absent from someone's ad-hoc notes field
    // would become "the target declares no such tool".
    const lucky = { tools: [{ name: 'search_web' }] }
    expect(readAgentConfigSnapshot(lucky)).toBeNull()
    expect(declaredDimensions(readAgentConfigSnapshot(lucky))).toEqual([])
  })

  it('reads a marked snapshot', () => {
    const snapshot = buildAgentConfigSnapshot({ tools: enumeratedTools([{ name: 'search_web' }]) })
    expect(snapshot.$schema).toBe(AGENT_CONFIG_SNAPSHOT_SCHEMA)
    expect(readAgentConfigSnapshot(snapshot)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Declaration is per dimension
// ---------------------------------------------------------------------------

describe('partial declaration is honestly partial', () => {
  it('declares only what was actually declared', () => {
    const snapshot = buildAgentConfigSnapshot({
      tools: enumeratedTools([{ name: 'search_web' }]),
      model: { declared: 'enumerated', models: ['claude-sonnet-4-6'] },
    })
    // Tools and model, and NOT budgets — omitting budgets is the absence of a
    // claim, never a claim that there are none.
    expect(declaredDimensions(readAgentConfigSnapshot(snapshot))).toEqual(['tools', 'model'])
  })

  it('treats an explicit `unknown` as undeclared — it is on the record, but it is still not an answer', () => {
    const snapshot = buildAgentConfigSnapshot({
      tools: { declared: 'unknown', why: 'the framework does not expose its registry' },
    })
    expect(declaredDimensions(readAgentConfigSnapshot(snapshot))).toEqual([])
  })

  it('an omitted dimension is never defaulted into a claim', () => {
    const snapshot = buildAgentConfigSnapshot({ tools: enumeratedTools([{ name: 'search_web' }]) })
    expect(snapshot.budgets).toBeUndefined()
    expect(snapshot.systemPrompt).toBeUndefined()
  })

  it('reports proofs about the declared dimension and unanswered questions about the rest', () => {
    // The shape that makes this feature useful before every snapshot is
    // perfect: tools BROKEN, budgets UNDECLARED, model clean — all at once,
    // from one report, instead of a single word.
    const report: DivergenceReport = {
      runId: 'run_1',
      baselineVersionId: 'ver_old',
      targetVersionId: 'ver_new',
      analyzedAt: 1,
      verdict: 'incompatible',
      proven: [
        {
          certainty: 'proven',
          kind: 'tool_removed',
          dimension: 'tools',
          reasonKey: 'tool_removed:search_web',
          provenClaim: 'called `search_web`; target declares no such tool',
          provenBy: [
            {
              citedEvent: { sequenceNumber: 42, eventType: 'tool.call' },
              targetConfigPath: 'tools[].name',
              recordedValue: 'search_web',
              targetValue: null,
            },
          ],
        },
      ],
      speculative: [],
      indeterminate: [],
      coverage: {
        assessed: ['tools', 'model'],
        unassessed: [
          { dimension: 'budgets', reason: 'target_dimension_absent' },
          { dimension: 'system_prompt', reason: 'target_dimension_absent' },
          { dimension: 'decoding_params', reason: 'target_dimension_absent' },
          { dimension: 'capabilities', reason: 'target_dimension_absent' },
        ],
        eventsExamined: 120,
        eventHistoryComplete: true,
      },
    }

    const byDimension = new Map(divergenceByDimension(report).map((o) => [o.dimension, o.state]))
    expect(byDimension.get('tools')).toBe('incompatible')
    expect(byDimension.get('model')).toBe('clean')
    // UNDECLARED, not "unanswered" and certainly not "clean": the operator can
    // fix this one by publishing a structured snapshot, and being told which
    // kind of not-checked it is is the difference between a next step and a
    // shrug.
    expect(byDimension.get('budgets')).toBe('undeclared')
    expect(byDimension.get('system_prompt')).toBe('undeclared')
  })

  it('never reports a dimension the engine ignored entirely as clean', () => {
    const silent: DivergenceReport = {
      runId: 'run_1',
      baselineVersionId: null,
      targetVersionId: 'ver_new',
      analyzedAt: 1,
      verdict: 'indeterminate',
      proven: [],
      speculative: [],
      indeterminate: [],
      // Neither assessed nor listed as unassessed — the engine simply said
      // nothing. Silence must never read as a pass.
      coverage: { assessed: ['tools'], unassessed: [], eventsExamined: 10, eventHistoryComplete: true },
    }
    const byDimension = new Map(divergenceByDimension(silent).map((o) => [o.dimension, o.state]))
    expect(byDimension.get('tools')).toBe('clean')
    expect(byDimension.get('budgets')).toBe('undeclared')
    expect(byDimension.get('model')).toBe('undeclared')
  })
})

// ---------------------------------------------------------------------------
// 3. An incomplete list can never produce a proof — THE dangerous one
// ---------------------------------------------------------------------------

describe('only a COMPLETE declaration can support a proof', () => {
  it('an enumerated list can', () => {
    expect(supportsProof(enumeratedTools([{ name: 'search_web' }]))).toBe(true)
    expect(supportsProof({ declared: 'enumerated', models: ['claude-sonnet-4-6'] })).toBe(true)
  })

  it('a PARTIAL list cannot — this is the false-proof guard', () => {
    // "These tools exist" says nothing about a tool that is not in the list.
    // If `partial` ever supported a proof, a half-captured snapshot would
    // condemn a perfectly healthy version on every run that used a tool the
    // capture missed.
    expect(supportsProof(partialTools([{ name: 'search_web' }]))).toBe(false)
    expect(supportsProof({ declared: 'partial', models: ['claude-sonnet-4-6'] })).toBe(false)
  })

  it('an unknown or absent declaration cannot', () => {
    expect(supportsProof({ declared: 'unknown' })).toBe(false)
    expect(supportsProof(undefined)).toBe(false)
  })

  it('a tool list INFERRED from observed calls is always partial, and cannot be made otherwise', () => {
    // A run exercises the tools it needed that day. Recording that as a
    // complete list would produce `tool_removed` for every tool the run simply
    // did not reach — a fabricated certainty, generated by the SDK itself.
    const inferred = toolsFromCalls(['search_web', 'send_email', 'search_web'])
    expect(inferred.declared).toBe('partial')
    expect(supportsProof(inferred)).toBe(false)
    if (inferred.declared === 'partial') {
      expect(inferred.tools.map((t) => t.name)).toEqual(['search_web', 'send_email'])
    }
  })
})

// ---------------------------------------------------------------------------
// 4. "None" is a real claim, distinct from "unknown"
// ---------------------------------------------------------------------------

describe('declaring emptiness is a checkable claim', () => {
  it('an empty enumerated list normalises to `none`, which DOES support a proof', () => {
    // The cheap win: an agent that legitimately has no tools can say so, and
    // every recorded tool call then contradicts it. Today that agent is
    // indistinguishable from one whose tool list was never captured, and is
    // permanently indeterminate.
    const none = enumeratedTools([])
    expect(none).toEqual({ declared: 'none' })
    expect(supportsProof(none)).toBe(true)
  })

  it('`unbounded` budgets are analysable — nothing can exceed no ceiling', () => {
    expect(supportsProof({ declared: 'unbounded' })).toBe(true)
    expect(declaredDimensions(readAgentConfigSnapshot(buildAgentConfigSnapshot({ budgets: { declared: 'unbounded' } })))).toEqual(
      ['budgets']
    )
  })
})

// ---------------------------------------------------------------------------
// The prompt digest
// ---------------------------------------------------------------------------

describe('digestSystemPrompt', () => {
  it('hashes locally and carries no prompt text', async () => {
    const digest = await digestSystemPrompt('You are a careful assistant.')
    expect(digest.declared).toBe('digest')
    if (digest.declared === 'digest') {
      expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(digest.length).toBe('You are a careful assistant.'.length)
      // The whole point: nothing in the result contains the prompt. A snapshot
      // is a second store that would otherwise need its own redaction,
      // retention and purge story for the most sensitive string in the system.
      expect(JSON.stringify(digest)).not.toContain('careful assistant')
    }
  })

  it('is stable for identical prompts and different for edited ones', async () => {
    const a = await digestSystemPrompt('You are a careful assistant.')
    const b = await digestSystemPrompt('You are a careful assistant.')
    const edited = await digestSystemPrompt('You are a careless assistant.')
    expect(a).toEqual(b)
    expect(a).not.toEqual(edited)
  })

  it('declares an empty prompt as `none` rather than hashing nothing', async () => {
    expect(await digestSystemPrompt('')).toEqual({ declared: 'none' })
  })
})
