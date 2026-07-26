/* eslint-disable */
/**
 * REPLAY DIVERGENCE ENGINE — verification.
 *
 * The feature's value is entirely in the LINE between PROVEN and SPECULATIVE,
 * so these tests are organised around that line rather than around the code's
 * structure. The properties under test:
 *
 *   1. A removed tool the run actually called is caught, and lands in `proven`
 *      with a real citation.
 *   2. An unchanged version reports zero findings and verdict `compatible`.
 *   3. An absent / malformed / partially-readable snapshot reports
 *      `indeterminate` with a named unassessed reason — NEVER "no divergences".
 *   4. Fleet grouping actually groups: N runs broken for one reason collapse to
 *      one `ProvenDivergenceReason` with `affectedRunCount: N`.
 *   5. A prompt change is never proven, never gate-worthy, never "resolved".
 *   6. Absence of evidence is never evidence of absence: an externalized
 *      `tool.call` payload forbids `compatible`.
 *   7. The proven/speculative segregation holds structurally — no proven
 *      finding without a citation, no speculative finding without a stated
 *      reason it cannot be proven.
 */
import { describe, it, expect } from 'vitest'

import {
  analyzeConfigPair,
  analyzeRunAgainstDelta,
  analyzeRunDivergence,
  computeDivergenceVerdict,
  extractRunObservation,
  foldFleetDivergence,
  isDivergenceCoverageComplete,
  isFleetScanComplete,
  mergeFleetAnalyses,
  DIVERGENCE_DIMENSIONS,
  readConfigSnapshot,
  type ObservableEvent,
  type ProvenDivergence,
  type SpeculativeDivergence,
} from './divergence'
import { OBSERVED_EVENT_TYPES } from '../divergence'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A snapshot that declares ALL SIX dimensions. Required for a `compatible`
 * verdict to be reachable at all — a snapshot that omits a dimension leaves it
 * `target_dimension_absent`, which is by design (see the engine header).
 */
const FULL_CONFIG = {
  model: 'gpt-4o',
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.2,
  max_tokens: 2048,
  capabilities: ['vector_store'],
  tools: [
    { name: 'search_web', parameters: { type: 'object', properties: { query: {}, limit: {} }, required: ['query'] } },
    { name: 'send_email', parameters: { type: 'object', properties: { to: {}, body: {} }, required: ['to', 'body'] } },
  ],
}

function toolCall(seq: number, name: string, input: unknown = {}): ObservableEvent {
  return { type: 'tool.call', sequenceNumber: seq, payload: { type: 'tool.call', name, input, call_id: `c${seq}` } }
}

function llmResponse(seq: number, completionTokens: number, model = 'gpt-4o'): ObservableEvent {
  return {
    type: 'llm.response',
    sequenceNumber: seq,
    payload: {
      type: 'llm.response',
      model,
      content: 'ok',
      usage: { prompt_tokens: 10, completion_tokens: completionTokens, total_tokens: 10 + completionTokens },
      finish_reason: 'stop',
    },
  }
}

function externalizedToolCall(seq: number): ObservableEvent {
  return {
    type: 'tool.call',
    sequenceNumber: seq,
    payload: {
      type: '_externalized',
      originalType: 'tool.call',
      _artifact: { artifactId: 'a1', storageKey: 'k', storageBucket: 'b', checksum: 'sha', size: 20000 },
    },
  }
}

const provenKinds = (p: ProvenDivergence[]) => p.map((x) => x.kind)
const specKinds = (s: SpeculativeDivergence[]) => s.map((x) => x.kind)
const unassessedFor = (a: { coverage: { unassessed: Array<{ dimension: string; reason: string }> } }, d: string) =>
  a.coverage.unassessed.filter((u) => u.dimension === d)

// ===========================================================================
// 1. PROVEN — a removed tool the run actually called
// ===========================================================================

describe('tool_removed — proven', () => {
  const target = { ...FULL_CONFIG, tools: [FULL_CONFIG.tools[1]] } // search_web gone

  it('catches a call to a tool the target does not declare, with a real citation', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, target, [
      toolCall(1, 'search_web', { query: 'x' }),
      toolCall(2, 'send_email', { to: 'a@b.c', body: 'hi' }),
    ])

    expect(provenKinds(a.proven)).toEqual(['tool_removed'])
    const f = a.proven[0]!
    expect(f.certainty).toBe('proven')
    expect(f.reasonKey).toBe('tool_removed:search_web')
    expect(f.provenBy).toHaveLength(1)
    expect(f.provenBy[0].citedEvent).toEqual({ sequenceNumber: 1, eventType: 'tool.call' })
    // `null` here IS the proof: the config path does not exist on the target.
    expect(f.provenBy[0].targetValue).toBeNull()
    expect(f.provenBy[0].recordedValue).toBe('search_web')
    expect(a.verdict).toBe('incompatible')
  })

  it('does NOT report a tool the run never called', () => {
    const targetNoEmail = { ...FULL_CONFIG, tools: [FULL_CONFIG.tools[0]] }
    const a = analyzeRunDivergence(FULL_CONFIG, targetNoEmail, [toolCall(1, 'search_web', { query: 'x' })])
    expect(a.proven).toEqual([])
    expect(a.verdict).toBe('compatible')
  })

  it('collapses many calls to the same removed tool into ONE proven finding, with bounded proofs', () => {
    const events = Array.from({ length: 40 }, (_, i) => toolCall(i + 1, 'search_web', { query: 'x' }))
    const a = analyzeRunDivergence(FULL_CONFIG, target, events)
    expect(a.proven).toHaveLength(1)
    expect(a.proven[0]!.provenClaim).toContain('40 time(s)')
    expect(a.proven[0]!.provenBy.length).toBeLessThanOrEqual(10)
  })

  it('an explicitly EMPTY tool list is readable and proves every call removed', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG, tools: [] }, [toolCall(1, 'search_web', { query: 'x' })])
    expect(provenKinds(a.proven)).toEqual(['tool_removed'])
    expect(a.verdict).toBe('incompatible')
  })

  it('an ABSENT tool list is NOT an empty tool list and produces NO proof', () => {
    // The most dangerous possible bug: fabricating a PROOF out of missing
    // metadata.
    const { tools, ...noTools } = FULL_CONFIG
    const a = analyzeRunDivergence(FULL_CONFIG, noTools, [toolCall(1, 'search_web', { query: 'x' })])
    expect(a.proven).toEqual([])
    expect(unassessedFor(a, 'tools')[0]!.reason).toBe('target_dimension_absent')
    expect(a.verdict).toBe('indeterminate')
  })

  it('a partially-unparseable target tool list refuses the whole dimension', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG, tools: [{ name: 'send_email' }, 42] }, [
      toolCall(1, 'search_web', { query: 'x' }),
    ])
    expect(a.proven).toEqual([])
    expect(unassessedFor(a, 'tools')[0]!.reason).toBe('unsupported_config_shape')
    expect(a.verdict).toBe('indeterminate')
  })
})

// ===========================================================================
// 2. THE COMPATIBLE VERDICT
// ===========================================================================

describe('unchanged version', () => {
  it('reports zero findings and verdict compatible', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG }, [
      toolCall(1, 'search_web', { query: 'x' }),
      llmResponse(2, 100),
    ])
    expect(a.proven).toEqual([])
    expect(a.speculative).toEqual([])
    expect(a.coverage.unassessed).toEqual([])
    expect(isDivergenceCoverageComplete(a.coverage)).toBe(true)
    expect(a.verdict).toBe('compatible')
  })

  it('key ORDER does not manufacture a divergence', () => {
    const reordered = {
      capabilities: ['vector_store'],
      tools: FULL_CONFIG.tools,
      max_tokens: 2048,
      systemPrompt: 'You are a helpful assistant.',
      temperature: 0.2,
      model: 'gpt-4o',
    }
    // At least one examined event: contracts 0.16.1 requires eventsExamined > 0
    // before a run may be graded compatible.
    const a = analyzeRunDivergence(FULL_CONFIG, reordered, [toolCall(1, 'search_web', { query: 'q' })])
    expect(a.verdict).toBe('compatible')
  })

  it('a snapshot missing a DIMENSION cannot reach compatible, only compatible_with_caveats or indeterminate', () => {
    // This is a real product consequence of the anti-false-clean rule: a
    // partially-declared snapshot is never a clean bill of health.
    const { capabilities, ...noCaps } = FULL_CONFIG
    const a = analyzeRunDivergence(noCaps, noCaps, [])
    expect(a.verdict).toBe('indeterminate')
    expect(unassessedFor(a, 'capabilities')[0]!.reason).toBe('target_dimension_absent')
  })
})

// ===========================================================================
// 3. UNANALYSABLE — never silently clean
// ===========================================================================

describe('absent / malformed snapshots', () => {
  it('an absent TARGET snapshot is indeterminate with target_config_missing', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, undefined, [toolCall(1, 'search_web')])
    expect(a.verdict).toBe('indeterminate')
    expect(a.coverage.assessed).toEqual([])
    expect(a.coverage.unassessed.every((u) => u.reason === 'target_config_missing')).toBe(true)
    expect(a.proven).toEqual([])
  })

  it('an absent BASELINE snapshot still permits PROOF — only speculation is blocked', () => {
    // Proven kinds need only the target's configuration. A run with no recorded
    // version is analysable for proof, and this is the case the naive design
    // (refuse outright) throws away.
    const target = { ...FULL_CONFIG, tools: [FULL_CONFIG.tools[1]] }
    const a = analyzeRunDivergence(undefined, target, [toolCall(1, 'search_web', { query: 'x' })])
    expect(provenKinds(a.proven)).toEqual(['tool_removed'])
    expect(a.verdict).toBe('incompatible')
    expect(a.coverage.unassessed.every((u) => u.reason === 'baseline_config_missing')).toBe(true)
  })

  it('BOTH snapshots absent is indeterminate — not "identical, therefore clean"', () => {
    // The trap: two absent configs compare equal. They are not equal; they are
    // both unknown.
    const a = analyzeRunDivergence(undefined, undefined, [])
    expect(a.verdict).toBe('indeterminate')
    expect(a.verdict).not.toBe('compatible')
  })

  it('a scalar / array snapshot is unsupported_config_shape, not an empty object', () => {
    expect(readConfigSnapshot('gpt-4o').snapshotStatus).toBe('not-an-object')
    expect(readConfigSnapshot(['a']).snapshotStatus).toBe('not-an-object')
    const a = analyzeRunDivergence(FULL_CONFIG, 42, [])
    expect(a.verdict).toBe('indeterminate')
    expect(a.coverage.unassessed.every((u) => u.reason === 'unsupported_config_shape')).toBe(true)
  })

  it('an OLDER snapshot shape leaves the dimensions it omits explicitly unassessed', () => {
    const old = { model: 'gpt-4o' }
    const a = analyzeRunDivergence(old, old, [])
    expect(a.coverage.assessed).toEqual(['model'])
    expect(a.coverage.unassessed.map((u) => u.dimension).sort()).toEqual([
      'budgets', 'capabilities', 'decoding_params', 'system_prompt', 'tools',
    ])
    expect(a.verdict).toBe('indeterminate')
  })

  it('every unassessed entry names WHY, so "we did not look" is never silent', () => {
    const { tools, ...noTools } = FULL_CONFIG
    const a = analyzeRunDivergence(noTools, noTools, [])
    for (const u of a.coverage.unassessed) {
      expect(u.detail && u.detail.length > 0).toBe(true)
    }
    expect(unassessedFor(a, 'tools')[0]!.detail).toContain('absence is unknown, not empty')
  })
})

// ===========================================================================
// 4. INCOMPLETE OBSERVATION — absence of evidence is not evidence of absence
// ===========================================================================

describe('observation completeness', () => {
  it('an externalized tool.call payload forbids compatible', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG, tools: [FULL_CONFIG.tools[1]] }, [
      externalizedToolCall(1),
    ])
    // We cannot see WHICH tool was called, so we cannot say it wasn't the
    // removed one.
    expect(a.proven).toEqual([])
    expect(a.coverage.eventHistoryComplete).toBe(false)
    expect(a.verdict).toBe('indeterminate')
  })

  it('an identical config with an unreadable event still cannot be compatible', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG }, [externalizedToolCall(1)])
    expect(a.proven).toEqual([])
    expect(a.speculative).toEqual([])
    expect(a.verdict).toBe('indeterminate')
  })

  it('a truncated scan forbids compatible', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG }, [toolCall(1, 'search_web', { query: 'x' })], {
      scanTruncated: true,
    })
    expect(a.coverage.eventHistoryComplete).toBe(false)
    expect(a.verdict).toBe('indeterminate')
  })

  it('a lossy OTel-derived event forbids compatible', () => {
    const ev: ObservableEvent = {
      type: 'tool.call',
      sequenceNumber: 1,
      payload: { type: 'tool.call', name: 'search_web', input: { query: 'x' } },
      provenance: { source: 'otel', lossy: true },
    }
    expect(analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG }, [ev]).verdict).toBe('indeterminate')
  })

  it('a PROOF survives an incomplete observation — incompatible outranks indeterminate', () => {
    const target = { ...FULL_CONFIG, tools: [FULL_CONFIG.tools[1]] }
    const a = analyzeRunDivergence(FULL_CONFIG, target, [
      toolCall(1, 'search_web', { query: 'x' }),
      externalizedToolCall(2),
    ])
    expect(a.verdict).toBe('incompatible')
    expect(a.coverage.eventHistoryComplete).toBe(false)
  })

  it('an uninspectable argument object is an engine_limit, not a pass', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG }, [toolCall(1, 'search_web', 'raw-string-args')])
    expect(a.proven).toEqual([])
    expect(unassessedFor(a, 'tools')[0]!.reason).toBe('engine_limit')
    expect(a.verdict).toBe('indeterminate')
  })

  it('extractRunObservation reports gap counts rather than a boolean', () => {
    const obs = extractRunObservation([externalizedToolCall(1), externalizedToolCall(2)])
    expect(obs.gapCounts['EXTERNALIZED_PAYLOAD']).toBe(2)
    expect(obs.gapCounts['UNNAMED_TOOL_CALL']).toBe(2)
    expect(obs.toolCalls).toEqual([])
    // The COUNT still increments — an unnamed call is still a call, which is
    // what makes the maxToolCalls budget proof sound on partial history.
    expect(obs.toolCallCount).toBe(2)
  })
})

// ===========================================================================
// 5. TOOL ARGUMENTS — decide what is decidable, and only that
// ===========================================================================

describe('tool_call_rejected_by_schema', () => {
  it('a newly-required parameter the recorded call omits is proven', () => {
    const target = {
      ...FULL_CONFIG,
      tools: [
        { name: 'search_web', parameters: { type: 'object', properties: { query: {}, limit: {} }, required: ['query', 'limit'] } },
        FULL_CONFIG.tools[1],
      ],
    }
    const a = analyzeRunDivergence(FULL_CONFIG, target, [toolCall(1, 'search_web', { query: 'x' })])
    const f = a.proven.find((p) => p.kind === 'tool_call_rejected_by_schema')!
    expect(f.reasonKey).toBe('tool_call_rejected_by_schema:search_web:missing:limit')
    expect(f.provenBy[0].citedEvent.sequenceNumber).toBe(1)
    expect(a.verdict).toBe('incompatible')
  })

  it('a required name absent from `properties` is still required', () => {
    // JSON Schema permits it, and reading only `properties` would drop exactly
    // the constraint most likely to break a recorded call — a false clean.
    const target = {
      ...FULL_CONFIG,
      tools: [FULL_CONFIG.tools[0], { name: 'send_email', parameters: { type: 'object', properties: { to: {} }, required: ['to', 'cc'] } }],
    }
    const a = analyzeRunDivergence(FULL_CONFIG, target, [toolCall(1, 'send_email', { to: 'a@b.c' })])
    expect(a.proven.map((p) => p.reasonKey)).toContain('tool_call_rejected_by_schema:send_email:missing:cc')
  })

  it('an undeclared argument is proven only under additionalProperties:false', () => {
    const mk = (extra: Record<string, unknown>) => ({
      ...FULL_CONFIG,
      tools: [
        { name: 'search_web', parameters: { type: 'object', properties: { query: {} }, required: ['query'], ...extra } },
        FULL_CONFIG.tools[1],
      ],
    })
    const call = [toolCall(1, 'search_web', { query: 'x', limit: 5 })]

    // Open schema: JSON Schema's default permits the extra key. No proof.
    expect(analyzeRunDivergence(FULL_CONFIG, mk({}), call).proven.filter((p) => p.kind === 'tool_call_rejected_by_schema')).toEqual([])
    // Closed schema: proven rejection.
    const strict = analyzeRunDivergence(FULL_CONFIG, mk({ additionalProperties: false }), call)
    expect(strict.proven.map((p) => p.reasonKey)).toContain('tool_call_rejected_by_schema:search_web:undeclared:limit')
  })

  it('a schema change the recorded call survives is SPECULATIVE, never "valid"', () => {
    const target = {
      ...FULL_CONFIG,
      tools: [
        { name: 'search_web', parameters: { type: 'object', properties: { query: {}, limit: {}, locale: {} }, required: ['query'] } },
        FULL_CONFIG.tools[1],
      ],
    }
    const a = analyzeRunDivergence(FULL_CONFIG, target, [toolCall(1, 'search_web', { query: 'x' })])
    expect(a.proven).toEqual([])
    const s = a.speculative.find((x) => x.kind === 'tool_schema_widened')!
    expect(s.speculativeBecause).toContain('cannot reject anything the old one accepted')
    expect(a.verdict).toBe('compatible_with_caveats')
  })

  it('a NARROWED schema the call survives is config_changed, and states the limit of the check', () => {
    const target = {
      ...FULL_CONFIG,
      tools: [
        { name: 'search_web', parameters: { type: 'object', properties: { query: {} }, required: ['query'] } },
        FULL_CONFIG.tools[1],
      ],
    }
    const a = analyzeRunDivergence(FULL_CONFIG, target, [toolCall(1, 'search_web', { query: 'x' })])
    const s = a.speculative.find((x) => x.changedConfigPath.includes('search_web'))!
    expect(s.kind).toBe('config_changed')
    expect(s.speculativeBecause).toContain('NECESSARY but not SUFFICIENT')
  })

  it('closing a previously-open schema is never counted as widening', () => {
    const target = {
      ...FULL_CONFIG,
      tools: [
        { name: 'search_web', parameters: { type: 'object', properties: { query: {}, limit: {} }, required: ['query'], additionalProperties: false } },
        FULL_CONFIG.tools[1],
      ],
    }
    const a = analyzeRunDivergence(FULL_CONFIG, target, [])
    expect(specKinds(a.speculative)).not.toContain('tool_schema_widened')
  })

  it('a tool declared by NAME ONLY yields no argument claim in either direction', () => {
    const cfg = { ...FULL_CONFIG, tools: ['search_web'] }
    const a = analyzeRunDivergence(cfg, cfg, [toolCall(1, 'search_web', { anything: 1 })])
    expect(a.proven).toEqual([])
    expect(a.speculative).toEqual([])
    expect(a.verdict).toBe('compatible')
  })
})

// ===========================================================================
// 6. MODEL AND BUDGET PROOFS
// ===========================================================================

describe('model_removed and budget_exceeded', () => {
  it('a recorded model absent from an enumerated allowed list is proven', () => {
    const source = { ...FULL_CONFIG, models: ['gpt-4o', 'gpt-4o-mini'] }
    const target = { ...FULL_CONFIG, models: ['gpt-4o-mini'] }
    const a = analyzeRunDivergence(source, target, [llmResponse(1, 10, 'gpt-4o')])
    const f = a.proven.find((p) => p.kind === 'model_removed')!
    expect(f.reasonKey).toBe('model_removed:gpt-4o')
    expect(f.provenBy[0].recordedValue).toBe('gpt-4o')
    expect(f.provenBy[0].targetValue).toBe('gpt-4o-mini')
    expect(a.verdict).toBe('incompatible')
  })

  it('a model swap the target still permits is SPECULATIVE, not proven', () => {
    const source = { ...FULL_CONFIG, models: ['gpt-4o'] }
    const target = { ...FULL_CONFIG, models: ['gpt-4o', 'gpt-5'] }
    const a = analyzeRunDivergence(source, target, [llmResponse(1, 10, 'gpt-4o')])
    expect(a.proven).toEqual([])
    expect(specKinds(a.speculative)).toContain('model_substituted')
    expect(a.speculative.find((s) => s.kind === 'model_substituted')!.speculativeBecause).toContain(
      'No structural claim about a model swap is possible',
    )
  })

  it('a generation above the target max_tokens is proven, and below it is only speculative drift', () => {
    const target = { ...FULL_CONFIG, max_tokens: 512 }
    const under = analyzeRunDivergence(FULL_CONFIG, target, [llmResponse(1, 100)])
    expect(under.proven).toEqual([])
    expect(specKinds(under.speculative)).toContain('config_changed')

    const over = analyzeRunDivergence(FULL_CONFIG, target, [llmResponse(1, 100), llmResponse(2, 900)])
    const f = over.proven.find((p) => p.kind === 'budget_exceeded')!
    expect(f.reasonKey).toBe('budget_exceeded:max_tokens:512')
    expect(f.provenBy[0].citedEvent.sequenceNumber).toBe(2)
    expect(over.verdict).toBe('incompatible')
  })

  it('a tool-call count above maxToolCalls is proven even on a TRUNCATED history', () => {
    // A count from partial history is a LOWER BOUND, and a lower bound already
    // above the ceiling is still a proof.
    const source = { ...FULL_CONFIG, maxToolCalls: 100 }
    const target = { ...FULL_CONFIG, maxToolCalls: 2 }
    const events = [toolCall(1, 'search_web', { query: 'a' }), toolCall(2, 'search_web', { query: 'b' }), toolCall(3, 'search_web', { query: 'c' })]
    const a = analyzeRunDivergence(source, target, events, { scanTruncated: true })
    expect(a.proven.map((p) => p.reasonKey)).toContain('budget_exceeded:maxToolCalls:2')
    expect(a.verdict).toBe('incompatible')
  })
})

// ===========================================================================
// 7. THE SPECULATIVE SIDE NEVER OVERSTATES
// ===========================================================================

describe('speculative findings', () => {
  it('a prompt change is flagged, never proven, never resolved, never called safe', () => {
    const a = analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG, systemPrompt: 'You are a terse assistant.' })
    const s = a.speculative.find((x) => x.kind === 'system_prompt_changed')!
    expect(s.certainty).toBe('speculative')
    expect(s.speculativeBecause).toContain('NOT DERIVABLE FROM A RECORDED HISTORY')
    expect(s.speculativeBecause).toContain('neither safe nor unsafe')
    // No prompt text leaks into the reason key — it travels into logs and
    // aggregate reports.
    expect(s.reasonKey).not.toContain('terse')
    expect(s.reasonKey).not.toContain('assistant')
  })

  it('a prompt change alone yields compatible_with_caveats — never incompatible, never compatible', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG, systemPrompt: 'different' }, [
      toolCall(1, 'search_web', { query: 'x' }),
    ])
    expect(a.proven).toEqual([])
    expect(a.verdict).toBe('compatible_with_caveats')
  })

  it('a prompt change NEVER appears in `proven`, under any pairing', () => {
    const target = { ...FULL_CONFIG, systemPrompt: 'x', tools: [FULL_CONFIG.tools[1]], max_tokens: 8 }
    const a = analyzeRunDivergence(FULL_CONFIG, target, [toolCall(1, 'search_web', { query: 'x' }), llmResponse(2, 4000)])
    expect(a.verdict).toBe('incompatible')
    expect(a.proven.every((p) => p.kind !== ('system_prompt_changed' as never))).toBe(true)
    expect(specKinds(a.speculative)).toContain('system_prompt_changed')
  })

  it('tool_added states that replay cannot speak to it', () => {
    const target = { ...FULL_CONFIG, tools: [...FULL_CONFIG.tools, { name: 'delete_database' }] }
    const s = analyzeConfigPair(FULL_CONFIG, target).speculative.find((x) => x.kind === 'tool_added')!
    expect(s.reasonKey).toBe('tool_added:delete_database')
    expect(s.speculativeBecause).toContain('never that it would have BEHAVED the same')
  })

  it('a description-only change is tool_description_changed', () => {
    const withDesc = { ...FULL_CONFIG, tools: [{ name: 'search_web', description: 'search the web' }] }
    const changed = { ...FULL_CONFIG, tools: [{ name: 'search_web', description: 'search the entire internet' }] }
    expect(specKinds(analyzeConfigPair(withDesc, changed).speculative)).toContain('tool_description_changed')
  })

  it('a capability change is speculative, and says WHY it cannot be proven', () => {
    const target = { ...FULL_CONFIG, capabilities: [] }
    const s = analyzeConfigPair(FULL_CONFIG, target).speculative.find((x) => x.changedConfigPath === 'capabilities')!
    expect(s.kind).toBe('config_changed')
    expect(s.speculativeBecause).toContain('NO EVENT TYPE RECORDS WHICH NAMED CAPABILITY PRODUCED IT')
  })

  it('every speculative finding states why it cannot be proven, and every proven one cites an event', () => {
    const target = {
      models: ['gpt-5'],
      systemPrompt: 'different',
      temperature: 0.9,
      max_tokens: 64,
      capabilities: [],
      tools: [{ name: 'send_email', parameters: { type: 'object', properties: { to: {} }, required: ['to', 'cc'] } }],
    }
    const source = { ...FULL_CONFIG, models: ['gpt-4o'] }
    const a = analyzeRunDivergence(source, target, [
      toolCall(1, 'search_web', { query: 'x' }),
      toolCall(2, 'send_email', { to: 'a@b.c' }),
      llmResponse(3, 4000, 'gpt-4o'),
    ])
    expect(a.proven.length).toBeGreaterThan(0)
    expect(a.speculative.length).toBeGreaterThan(0)
    for (const p of a.proven) {
      expect(p.certainty).toBe('proven')
      expect(p.provenBy.length).toBeGreaterThan(0)
      expect(p.provenBy[0].citedEvent.sequenceNumber).toBeGreaterThan(0)
    }
    for (const s of a.speculative) {
      expect(s.certainty).toBe('speculative')
      expect(s.speculativeBecause.length).toBeGreaterThan(0)
      expect(s.changedConfigPath.length).toBeGreaterThan(0)
      // The structural barrier: no shared `message`, and no proof field.
      expect('provenBy' in s).toBe(false)
      expect('message' in s).toBe(false)
    }
  })
})

// ===========================================================================
// 8. THE VERDICT RULE
// ===========================================================================

describe('computeDivergenceVerdict', () => {
  it('a proof outranks incomplete coverage — an incomplete scan must not hide a certainty', () => {
    expect(computeDivergenceVerdict({ provenCount: 1, speculativeCount: 0, complete: false })).toBe('incompatible')
  })
  it('nothing proven and incomplete coverage is indeterminate, not compatible', () => {
    expect(computeDivergenceVerdict({ provenCount: 0, speculativeCount: 0, complete: false })).toBe('indeterminate')
  })
  it('speculation alone is compatible_with_caveats', () => {
    expect(computeDivergenceVerdict({ provenCount: 0, speculativeCount: 3, complete: true })).toBe('compatible_with_caveats')
  })
  it('nothing at all, fully covered, is compatible', () => {
    expect(computeDivergenceVerdict({ provenCount: 0, speculativeCount: 0, complete: true })).toBe('compatible')
  })
})

// ===========================================================================
// 9. FLEET GROUPING
// ===========================================================================

describe('fleet grouping', () => {
  const target = { ...FULL_CONFIG, tools: [FULL_CONFIG.tools[1]], model: 'gpt-5' }
  const delta = analyzeConfigPair(FULL_CONFIG, target)
  const run = (events: ObservableEvent[]) => analyzeRunAgainstDelta(delta, extractRunObservation(events))
  const fullWindow = { runsScanned: 0, runsSkippedForBudget: 0, scanTruncated: false }

  it('340 runs broken for ONE reason collapse to ONE reason with affectedRunCount 340', () => {
    const analyses = Array.from({ length: 340 }, (_, i) => ({
      runId: `run_${i}`,
      analysis: run([toolCall(1, 'search_web', { query: 'x' })]),
    }))
    const fleet = foldFleetDivergence(analyses, { ...fullWindow, runsScanned: 340 })

    expect(fleet.window.runsAnalyzed).toBe(340)
    expect(fleet.runsWithProvenDivergence).toBe(340)
    expect(fleet.provenReasons).toHaveLength(1)
    expect(fleet.provenReasons[0]!.affectedRunCount).toBe(340)
    expect(fleet.provenReasons[0]!.representativeRunIds).toHaveLength(5)
    // The exemplar is a REAL finding with a REAL proof, not a summary.
    expect(fleet.provenReasons[0]!.exemplar.provenBy[0].recordedValue).toBe('search_web')
    expect(fleet.verdict).toBe('incompatible')
  })

  it('distinct reasons stay distinct, most-affecting first', () => {
    const t2 = {
      ...FULL_CONFIG,
      tools: [{ name: 'send_email', parameters: { type: 'object', properties: { to: {} }, required: ['to', 'cc'] } }],
    }
    const d2 = analyzeConfigPair(FULL_CONFIG, t2)
    const mk = (events: ObservableEvent[]) => analyzeRunAgainstDelta(d2, extractRunObservation(events))
    const fleet = foldFleetDivergence(
      [
        { runId: 'a', analysis: mk([toolCall(1, 'search_web', { query: 'x' })]) },
        { runId: 'b', analysis: mk([toolCall(1, 'search_web', { query: 'x' })]) },
        { runId: 'c', analysis: mk([toolCall(1, 'send_email', { to: 'x' })]) },
      ],
      { ...fullWindow, runsScanned: 3 },
    )
    expect(fleet.provenReasons.map((r) => r.reasonKey)).toEqual([
      'tool_removed:search_web',
      'tool_call_rejected_by_schema:send_email:missing:cc',
    ])
    expect(fleet.provenReasons[0]!.affectedRunCount).toBe(2)
    expect(fleet.provenReasons[1]!.affectedRunCount).toBe(1)
  })

  it('a repeated reason WITHIN one run counts that run once', () => {
    const fleet = foldFleetDivergence(
      [{ runId: 'a', analysis: run([toolCall(1, 'search_web'), toolCall(2, 'search_web'), toolCall(3, 'search_web')]) }],
      { ...fullWindow, runsScanned: 1 },
    )
    expect(fleet.provenReasons[0]!.affectedRunCount).toBe(1)
  })

  it('version-pair speculation applies to every analysed run', () => {
    const fleet = foldFleetDivergence(
      [
        { runId: 'a', analysis: run([toolCall(1, 'search_web')]) },
        { runId: 'b', analysis: run([]) },
      ],
      { ...fullWindow, runsScanned: 2 },
    )
    const model = fleet.speculativeReasons.find((r) => r.kind === 'model_substituted')!
    expect(model.affectedRunCount).toBe(2)
  })

  it('a truncated scan can never be compatible, even with nothing found', () => {
    const same = analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG })
    const clean = analyzeRunAgainstDelta(same, extractRunObservation([toolCall(1, 'search_web', { query: 'q' })]))
    const fleet = foldFleetDivergence([{ runId: 'a', analysis: clean }], { runsScanned: 10_000, runsSkippedForBudget: 0, scanTruncated: true })
    expect(fleet.provenReasons).toEqual([])
    expect(isFleetScanComplete(fleet.window)).toBe(false)
    expect(fleet.verdict).toBe('indeterminate')
  })

  it('a run that assessed NOTHING counts as unassessable, not clean', () => {
    const noTarget = analyzeRunAgainstDelta(analyzeConfigPair(FULL_CONFIG, undefined), extractRunObservation([]))
    const fleet = foldFleetDivergence([{ runId: 'a', analysis: noTarget }], { ...fullWindow, runsScanned: 1 })
    expect(fleet.window.runsUnassessable).toBe(1)
    expect(fleet.verdict).toBe('indeterminate')
  })

  it('an all-clean fleet over a complete scan is compatible', () => {
    const same = analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG })
    const fleet = foldFleetDivergence(
      ['a', 'b', 'c'].map((runId) => ({
        runId,
        analysis: analyzeRunAgainstDelta(same, extractRunObservation([toolCall(1, 'search_web', { query: 'q' })])),
      })),
      { runsScanned: 3, runsSkippedForBudget: 0, scanTruncated: false },
    )
    expect(fleet.provenReasons).toEqual([])
    expect(fleet.speculativeReasons).toEqual([])
    expect(fleet.verdict).toBe('compatible')
  })

  it('merging pages is EXACT because reason keys are run-independent', () => {
    const page = (ids: string[], truncated: boolean) =>
      foldFleetDivergence(
        ids.map((runId) => ({ runId, analysis: run([toolCall(1, 'search_web', { query: 'x' })]) })),
        { runsScanned: ids.length, runsSkippedForBudget: 0, scanTruncated: truncated },
      )
    const merged = mergeFleetAnalyses([page(['a', 'b'], true), page(['c', 'd', 'e'], false)])

    expect(merged.window.runsAnalyzed).toBe(5)
    expect(merged.runsWithProvenDivergence).toBe(5)
    expect(merged.provenReasons[0]!.affectedRunCount).toBe(5)
    expect(merged.speculativeReasons.find((r) => r.kind === 'model_substituted')!.affectedRunCount).toBe(5)
    // A truncated page poisons the merged completeness, as it must.
    expect(merged.window.scanTruncated).toBe(true)

    const oneShot = page(['a', 'b', 'c', 'd', 'e'], false)
    expect(merged.provenReasons.map((r) => [r.reasonKey, r.affectedRunCount])).toEqual(
      oneShot.provenReasons.map((r) => [r.reasonKey, r.affectedRunCount]),
    )
  })
})

// ===========================================================================
// 9b. REGRESSIONS — every one of these shipped, and every one was a live
//     false-clean or false-proof found by Team D's adversarial suite.
// ===========================================================================

describe('regressions', () => {
  const window = { runsScanned: 0, runsSkippedForBudget: 0, scanTruncated: false }

  it('fleet-fold-ignores-per-run-history-truncation: per-run truncation reaches the fleet verdict', () => {
    // THE FALSE CLEAN, ON THE DEFAULT PATH. Tier 3 reads at most 200 events per
    // run, so any longer run is truncated by construction. 25 runs each
    // honestly `indeterminate` used to fold to `compatible`.
    const delta = analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG })
    const analyses = Array.from({ length: 25 }, (_, i) => ({
      runId: `r${i}`,
      analysis: analyzeRunAgainstDelta(delta, extractRunObservation([toolCall(1, 'search_web', { query: 'q' })], { scanTruncated: true })),
    }))
    expect(analyses[0]!.analysis.verdict).toBe('indeterminate')
    expect(analyses[0]!.analysis.coverage.eventHistoryComplete).toBe(false)

    const fleet = foldFleetDivergence(analyses, { ...window, runsScanned: 25 })
    expect(fleet.verdict).toBe('indeterminate')
    expect(fleet.verdict).not.toBe('compatible')
    // Counted as "not fully looked at" — the contract's channel for it — while
    // still distinguishable from "could not look at all".
    expect(fleet.window.runsUnassessable).toBe(25)
    expect(fleet.runsPartiallyAnalyzed).toBe(25)
    expect(isFleetScanComplete(fleet.window)).toBe(false)
  })

  it('fleet-fold: an unassessable run and a partially-analysed one stay distinguishable', () => {
    const complete = analyzeRunAgainstDelta(
      analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG }),
      extractRunObservation([toolCall(1, 'search_web', { query: 'q' })]),
    )
    const partial = analyzeRunAgainstDelta(
      analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG }),
      extractRunObservation([toolCall(1, 'search_web', { query: 'q' })], { scanTruncated: true }),
    )
    const nothing = analyzeRunAgainstDelta(analyzeConfigPair(FULL_CONFIG, undefined), extractRunObservation([]))
    const fleet = foldFleetDivergence(
      [{ runId: 'a', analysis: complete }, { runId: 'b', analysis: partial }, { runId: 'c', analysis: nothing }],
      { ...window, runsScanned: 3 },
    )
    expect(fleet.window.runsUnassessable).toBe(2)
    expect(fleet.runsPartiallyAnalyzed).toBe(1)
  })

  it('empty-fleet-fold-returns-compatible: zero runs is not a green light', () => {
    // Reachable whenever a version's runs have aged out of retention (ADR-001),
    // which for a fleet of agents is routine.
    const fleet = foldFleetDivergence([], { runsScanned: 0, runsSkippedForBudget: 0, scanTruncated: false })
    expect(fleet.verdict).toBe('indeterminate')
    expect(fleet.verdict).not.toBe('compatible')
    expect(isFleetScanComplete(fleet.window)).toBe(false)
  })

  it('tool-map-string-value-misparsed-as-tool-name: the KEY is the name, the string is a description', () => {
    // FALSE PROOF. `{search_web: "Search the web"}` used to declare a tool
    // named "Search the web", so a run calling `search_web` was proven
    // `tool_removed` about a tool the target plainly declares.
    const target = { ...FULL_CONFIG, tools: { search_web: 'Search the web' } }
    const parsed = readConfigSnapshot(target).tools
    expect(parsed.status).toBe('read')
    expect(parsed.value).toEqual([{ name: 'search_web', params: null, closed: null, description: 'Search the web' }])

    const a = analyzeRunDivergence(FULL_CONFIG, target, [toolCall(1, 'search_web', { query: 'q' })])
    expect(a.proven).toEqual([])
    expect(a.verdict).not.toBe('incompatible')
  })

  it('tool-map-string-value: the ARRAY form still reads the string as the name', () => {
    // The two branches genuinely mean different things; fixing one must not
    // break the other.
    expect(readConfigSnapshot({ tools: ['search_web'] }).tools.value).toEqual([
      { name: 'search_web', params: null, closed: null },
    ])
  })

  it('max-tokens-alias-last-write-wins: conflicting aliases are ambiguous, not decidable', () => {
    // `{max_tokens: 4000, max_output_tokens: 100}` used to resolve to 100 by
    // key-list order, turning a 500-token generation into a PROVEN
    // budget_exceeded. A proof must never rest on a coin flip.
    const cfg = readConfigSnapshot({ max_tokens: 4000, max_output_tokens: 100 })
    expect(cfg.budgets.status).toBe('malformed')
    expect(cfg.budgets.note).toContain('ambiguous')

    const target = { ...FULL_CONFIG, max_tokens: 4000, max_output_tokens: 100 }
    const a = analyzeRunDivergence(FULL_CONFIG, target, [llmResponse(1, 500)])
    expect(a.proven).toEqual([])
    expect(unassessedFor(a, 'budgets')[0]!.reason).toBe('unsupported_config_shape')
    expect(a.verdict).toBe('indeterminate')
  })

  it('max-tokens-alias: aliases that AGREE are not a conflict', () => {
    const cfg = readConfigSnapshot({ max_tokens: 4000, maxTokens: 4000 })
    expect(cfg.budgets.status).toBe('read')
    expect(cfg.budgets.value).toEqual({ max_tokens: 4000 })
  })

  it('namespaced-tool-name-truncated-in-proven-claim: the claim carries the whole name', () => {
    // `key.slice(0, key.indexOf(":"))` rendered `github:search` as "github" in
    // the one sentence an operator reads to decide a deploy.
    const src = { ...FULL_CONFIG, tools: [{ name: 'github:search', parameters: { type: 'object', properties: { q: {} }, required: ['q'] } }] }
    const tgt = { ...FULL_CONFIG, tools: [{ name: 'github:search', parameters: { type: 'object', properties: { q: {} }, required: ['q', 'repo'] } }] }
    const a = analyzeRunDivergence(src, tgt, [toolCall(1, 'github:search', { q: 'x' })])
    expect(a.proven[0]!.provenClaim).toContain('"github:search"')
    expect(a.proven[0]!.provenClaim).not.toContain('"github"')
    expect(a.proven[0]!.reasonKey).toBe('tool_call_rejected_by_schema:github:search:missing:repo')
  })
})

// ===========================================================================
// 9c. CONTRACTS 0.16.0 — imported vocabulary, required `dimension`, and the
//     first-class indeterminate channel.
// ===========================================================================

describe('contracts integration', () => {
  it('every finding carries the dimension it belongs to', () => {
    const target = {
      models: ['gpt-5'], systemPrompt: 'different', temperature: 0.9, max_tokens: 64, capabilities: [],
      tools: [{ name: 'send_email', parameters: { type: 'object', properties: { to: {} }, required: ['to', 'cc'] } }],
    }
    const a = analyzeRunDivergence({ ...FULL_CONFIG, models: ['gpt-4o'] }, target, [
      toolCall(1, 'search_web', { query: 'x' }),
      toolCall(2, 'send_email', { to: 'a@b.c' }),
      llmResponse(3, 4000, 'gpt-4o'),
    ])
    for (const f of [...a.proven, ...a.speculative, ...a.indeterminate]) {
      expect(DIVERGENCE_DIMENSIONS).toContain(f.dimension)
    }
    expect(a.proven.find((p) => p.kind === 'tool_removed')!.dimension).toBe('tools')
    expect(a.proven.find((p) => p.kind === 'model_removed')!.dimension).toBe('model')
    expect(a.proven.find((p) => p.kind === 'budget_exceeded')!.dimension).toBe('budgets')
    expect(a.speculative.find((s) => s.kind === 'system_prompt_changed')!.dimension).toBe('system_prompt')
  })

  it('an externalized tool.call payload gets a first-class indeterminate finding, not just a boolean', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG, tools: [FULL_CONFIG.tools[1]] }, [
      externalizedToolCall(1),
    ])
    const i = a.indeterminate.find((x) => x.kind === 'evidence_externalized')!
    expect(i.certainty).toBe('indeterminate')
    expect(i.dimension).toBe('tools')
    expect(i.undecidedQuestion).toContain('which tools')
    expect(i.unknownBecause).toContain('10 KB inline ceiling')
    expect(i.remedy).toBeTruthy()
    // The structural barriers: no claim field, no concern field, no proof.
    expect('provenClaim' in i).toBe(false)
    expect('speculativeConcern' in i).toBe(false)
    expect('provenBy' in i).toBe(false)
  })

  it('a truncated scan gets an indeterminate finding whose remedy is to page to completion', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG }, [toolCall(1, 'search_web', { query: 'q' })], {
      scanTruncated: true,
    })
    const i = a.indeterminate.find((x) => x.kind === 'recorded_history_incomplete')!
    expect(i.remedy).toContain('nextEventCursor')
  })

  it('an UNDECLARED dimension stays in coverage only — it is not double-counted as indeterminate', () => {
    // `IndeterminateDivergenceKind` has no "never declared" member: that state
    // is `undeclared` in the coverage/DimensionState channel, whose remedy is
    // "declare it". Emitting it in both would inflate the fleet's distinct
    // reason count with the same fact twice.
    const { capabilities, ...noCaps } = FULL_CONFIG
    const a = analyzeRunDivergence(noCaps, noCaps, [])
    expect(unassessedFor(a, 'capabilities')[0]!.reason).toBe('target_dimension_absent')
    expect(a.indeterminate.map((i) => i.dimension)).not.toContain('capabilities')
  })

  it('an unreadable target shape DOES become indeterminate, with a remedy', () => {
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG, tools: [{ name: 'x' }, 42] }, [])
    const i = a.indeterminate.find((x) => x.kind === 'target_config_unreadable')!
    expect(i.dimension).toBe('tools')
    expect(i.remedy).toContain('AgentConfigSnapshot')
  })

  it('fleet grouping keeps indeterminate reasons in their own array', () => {
    const delta = analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG })
    const analyses = ['a', 'b', 'c'].map((runId) => ({
      runId,
      analysis: analyzeRunAgainstDelta(delta, extractRunObservation([externalizedToolCall(1)])),
    }))
    const fleet = foldFleetDivergence(analyses, { runsScanned: 3, runsSkippedForBudget: 0, scanTruncated: false })
    expect(fleet.provenReasons).toEqual([])
    expect(fleet.indeterminateReasons).toHaveLength(1)
    expect(fleet.indeterminateReasons[0]!.affectedRunCount).toBe(3)
    expect(fleet.indeterminateReasons[0]!.certainty).toBe('indeterminate')
    expect(fleet.verdict).toBe('indeterminate')
  })

  it('runs skipped for budget are their own field and defeat completeness', () => {
    const delta = analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG })
    const clean = analyzeRunAgainstDelta(delta, extractRunObservation([toolCall(1, 'search_web', { query: 'q' })]))
    const fleet = foldFleetDivergence([{ runId: 'a', analysis: clean }], {
      runsScanned: 50, runsSkippedForBudget: 49, scanTruncated: false,
    })
    expect(fleet.window.runsSkippedForBudget).toBe(49)
    expect(isFleetScanComplete(fleet.window)).toBe(false)
    expect(fleet.verdict).toBe('indeterminate')
  })

  it('a full clean page that still has a nextCursor is not a finished scan', () => {
    const delta = analyzeConfigPair(FULL_CONFIG, { ...FULL_CONFIG })
    const clean = analyzeRunAgainstDelta(delta, extractRunObservation([toolCall(1, 'search_web', { query: 'q' })]))
    const fleet = foldFleetDivergence([{ runId: 'a', analysis: clean }], {
      runsScanned: 1, runsSkippedForBudget: 0, scanTruncated: false, nextCursor: 'more',
    })
    expect(fleet.verdict).toBe('indeterminate')
  })
})

describe('eventsExamined soundness (contracts 0.16.1)', () => {
  it('a run whose history was never read cannot be compatible', () => {
    // The positive clause. An analysis that examined nothing satisfies every
    // negative clause — nothing truncated, nothing unassessed — and used to
    // clear the run.
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG }, [])
    expect(a.coverage.eventsExamined).toBe(0)
    expect(a.verdict).toBe('indeterminate')
    expect(isDivergenceCoverageComplete(a.coverage)).toBe(false)
  })

  it('the engine never treats zero examined events as "there was nothing to read"', () => {
    // THE PRECONDITION THAT MAKES THE CONTRACT'S CLAUSE SOUND. Event Log Rule 5
    // guarantees a RUN_STARTED on every run, so `run.started` is in the scan's
    // type filter purely so that a genuinely complete run with no tool calls
    // and no model calls still returns a row. Without it, that run reports
    // eventsExamined: 0 and is permanently indeterminate for a reason that is
    // an artifact of our filter rather than of the recording.
    expect(OBSERVED_EVENT_TYPES).toContain('run.started')

    const quietRun: ObservableEvent[] = [{ type: 'run.started', sequenceNumber: 1, payload: { type: 'run.started' } }]
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG }, quietRun)
    expect(a.coverage.eventsExamined).toBe(1)
    expect(a.verdict).toBe('compatible')
  })

  it('a run.started row contributes no facts, only evidence that the log was read', () => {
    const obs = extractRunObservation([{ type: 'run.started', sequenceNumber: 1, payload: { type: 'run.started' } }])
    expect(obs.toolCalls).toEqual([])
    expect(obs.modelUses).toEqual([])
    expect(obs.toolCallCount).toBe(0)
    expect(obs.gaps).toEqual([])
    expect(obs.eventsExamined).toBe(1)
  })
})

// ===========================================================================
// 10. TOLERANT CONFIG READING
// ===========================================================================

describe('tolerant configSnapshot reading', () => {
  it('reads OpenAI-style function tool declarations', () => {
    const facet = readConfigSnapshot({
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { a: {} }, required: ['a'] } } }],
    }).tools
    expect(facet.status).toBe('read')
    expect(facet.value).toEqual([{ name: 'f', params: [{ name: 'a', required: true }], closed: null }])
  })

  it('reads a name-keyed tool map', () => {
    const facet = readConfigSnapshot({ tools: { alpha: {}, beta: { parameters: { type: 'object', properties: { x: {} }, required: [] } } } }).tools
    expect(facet.status).toBe('read')
    expect(facet.value!.map((t) => t.name).sort()).toEqual(['alpha', 'beta'])
  })

  it('reads nested containers one level deep, and no deeper', () => {
    expect(readConfigSnapshot({ llm: { model: 'claude-x' } }).models.value!.list).toEqual(['claude-x'])
    expect(readConfigSnapshot({ a: { b: { model: 'claude-x' } } }).models.status).toBe('absent')
  })

  it('canonicalises parameter aliases so a rename is not reported as drift', () => {
    expect(analyzeConfigPair({ maxTokens: 100 }, { max_tokens: 100 }).speculative).toEqual([])
    expect(analyzeConfigPair({ topP: 0.9 }, { top_p: 0.9 }).speculative).toEqual([])
  })

  it('separates hard budgets from decoding parameters', () => {
    const cfg = readConfigSnapshot({ max_tokens: 100, temperature: 0.5 })
    expect(cfg.budgets.value).toEqual({ max_tokens: 100 })
    expect(cfg.decoding.value).toEqual({ temperature: 0.5 })
  })

  it('reads a message-array prompt without interpreting it', () => {
    const facet = readConfigSnapshot({ system: [{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }] }).prompt
    expect(facet.value).toBe('a\nb')
  })

  it('a non-string model is malformed, not absent', () => {
    expect(readConfigSnapshot({ model: 7 }).models.status).toBe('malformed')
  })
})

// ===========================================================================
// 11. PURITY
// ===========================================================================

describe('purity', () => {
  it('is deterministic and does not mutate its inputs', () => {
    const source = JSON.parse(JSON.stringify(FULL_CONFIG))
    const target = JSON.parse(JSON.stringify({ ...FULL_CONFIG, model: 'gpt-5' }))
    const events = [toolCall(1, 'search_web', { query: 'x' }), llmResponse(2, 50)]
    const sourceBefore = JSON.stringify(source)
    const eventsBefore = JSON.stringify(events)

    const a = analyzeRunDivergence(source, target, events)
    const b = analyzeRunDivergence(source, target, events)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(source)).toBe(sourceBefore)
    expect(JSON.stringify(events)).toBe(eventsBefore)
  })
})

// ===========================================================================
// 12. STRUCTURED SNAPSHOTS (AgentConfigSnapshot) — the answer to "shrugging"
// ===========================================================================

const SCHEMA = 'afr.agent-config/1'

describe('structured configSnapshot', () => {
  it('`tools: none` is a COMPLETE claim and proves every recorded call removed', () => {
    // Unreachable under the free-form reader: an absent tool list could never
    // mean "there are none".
    const baseline = { $schema: SCHEMA, tools: { declared: 'enumerated', tools: [{ name: 'search_web' }] } }
    const target = { $schema: SCHEMA, tools: { declared: 'none' } }
    const a = analyzeRunDivergence(baseline, target, [toolCall(1, 'search_web', { query: 'q' })])
    expect(a.proven.map((p) => p.reasonKey)).toContain('tool_removed:search_web')
    expect(a.verdict).toBe('incompatible')
  })

  it('`budgets: unbounded` is assessed AND clean, not permanently unanswered', () => {
    const cfg = {
      $schema: SCHEMA,
      tools: { declared: 'none' },
      model: { declared: 'enumerated', models: ['gpt-4o'] },
      budgets: { declared: 'unbounded' },
      decodingParams: { declared: 'defaults' },
      systemPrompt: { declared: 'none' },
      capabilities: { declared: 'none' },
    }
    const a = analyzeRunDivergence(cfg, cfg, [llmResponse(1, 999999)])
    expect(a.coverage.assessed.sort()).toEqual([...DIVERGENCE_DIMENSIONS].sort())
    expect(a.coverage.unassessed).toEqual([])
    expect(a.proven).toEqual([])
    expect(a.verdict).toBe('compatible')
  })

  it('`partial` is readable and comparable but NEVER proof-bearing', () => {
    const baseline = { $schema: SCHEMA, tools: { declared: 'partial', tools: [{ name: 'search_web' }] } }
    const target = { $schema: SCHEMA, tools: { declared: 'partial', tools: [] } }
    const a = analyzeRunDivergence(baseline, target, [toolCall(1, 'search_web', { query: 'q' })])
    // "These exist; there may be others" cannot condemn a healthy version.
    expect(a.proven).toEqual([])
    const i = a.indeterminate.find((x) => x.reasonKey === 'partial_declaration:tools')!
    expect(i.unknownBecause).toContain('PARTIAL')
    expect(i.remedy).toContain('enumerated')
    expect(a.verdict).toBe('indeterminate')
  })

  it('the prompt travels as a digest, and a digest change is still only speculative', () => {
    const mk = (sha: string) => ({
      $schema: SCHEMA,
      systemPrompt: { declared: 'digest', sha256: sha, length: 120 },
    })
    const a = analyzeConfigPair(mk('aaa'), mk('bbb'))
    expect(a.speculative.map((x) => x.kind)).toContain('system_prompt_changed')
    expect(a.proven ?? []).toEqual([])
    // No prompt text exists anywhere to leak.
    expect(JSON.stringify(a)).not.toContain('You are')
  })

  it('an unmarked snapshot still uses the free-form reader, unchanged', () => {
    // The marker gates the structured path; nothing is reinterpreted under a
    // producer who did not opt in.
    expect(readConfigSnapshot(FULL_CONFIG).structured).toBe(false)
    expect(readConfigSnapshot({ $schema: SCHEMA }).structured).toBe(true)
    const a = analyzeRunDivergence(FULL_CONFIG, { ...FULL_CONFIG, tools: [FULL_CONFIG.tools[1]] }, [
      toolCall(1, 'search_web', { query: 'q' }),
    ])
    expect(a.proven.map((p) => p.reasonKey)).toContain('tool_removed:search_web')
  })

  it('an omitted dimension is still an unmade claim, not an empty one', () => {
    const cfg = { $schema: SCHEMA, tools: { declared: 'none' } }
    const a = analyzeRunDivergence(cfg, cfg, [toolCall(1, 'x')])
    expect(a.coverage.assessed).toEqual(['tools'])
    expect(a.coverage.unassessed.map((u) => u.dimension).sort()).toEqual([
      'budgets', 'capabilities', 'decoding_params', 'model', 'system_prompt',
    ])
  })
})

// ===========================================================================
// 13. THE EMPTY SET — unreadable evidence that still constrains the answer
// ===========================================================================

describe('empty-set proofs', () => {
  it('an unnamed tool call against an EMPTY target toolset is proven, not indeterminate', () => {
    // Nothing whatsoever is a member of the empty set. The event TYPE survives
    // externalization, so knowing THAT a tool was called is enough.
    const baseline = { $schema: SCHEMA, tools: { declared: 'enumerated', tools: [{ name: 'search_web' }] } }
    const target = { $schema: SCHEMA, tools: { declared: 'none' } }
    const a = analyzeRunDivergence(baseline, target, [externalizedToolCall(1)])
    const f = a.proven.find((p) => p.reasonKey === 'tool_removed:<any>')!
    expect(f.kind).toBe('tool_removed')
    expect(f.provenBy[0].citedEvent.sequenceNumber).toBe(1)
    expect(f.provenBy[0].targetValue).toBeNull()
    expect(a.verdict).toBe('incompatible')
    // The question is closed, so it is no longer reported as open.
    expect(a.indeterminate.map((i) => i.kind)).not.toContain('evidence_externalized')
  })

  it('BOUNDARY: against a NON-EMPTY target toolset the engine still declines', () => {
    // The unnamed call may have been to a tool the target still declares.
    // Overreaching here would be a false proof.
    const baseline = { $schema: SCHEMA, tools: { declared: 'enumerated', tools: [{ name: 'a' }, { name: 'b' }] } }
    const target = { $schema: SCHEMA, tools: { declared: 'enumerated', tools: [{ name: 'b' }] } }
    const a = analyzeRunDivergence(baseline, target, [externalizedToolCall(1)])
    expect(a.proven).toEqual([])
    expect(a.indeterminate.map((i) => i.kind)).toContain('evidence_externalized')
    expect(a.verdict).toBe('indeterminate')
  })

  it('an unreadable model against an EMPTY permitted model set is proven', () => {
    const baseline = { $schema: SCHEMA, model: { declared: 'enumerated', models: ['gpt-4o'] } }
    const target = { $schema: SCHEMA, model: { declared: 'enumerated', models: [] } }
    const ev: ObservableEvent = {
      type: 'llm.request', sequenceNumber: 3,
      payload: { type: '_externalized', originalType: 'llm.request', _artifact: { artifactId: 'a' } },
    }
    const a = analyzeRunDivergence(baseline, target, [ev])
    const f = a.proven.find((p) => p.reasonKey === 'model_removed:<any>')!
    expect(f.provenBy[0].citedEvent.sequenceNumber).toBe(3)
    expect(a.verdict).toBe('incompatible')
  })

  it('BOUNDARY: a non-empty permitted model set still declines on an unreadable model', () => {
    const baseline = { $schema: SCHEMA, model: { declared: 'enumerated', models: ['gpt-4o'] } }
    const target = { $schema: SCHEMA, model: { declared: 'enumerated', models: ['gpt-5'] } }
    const ev: ObservableEvent = {
      type: 'llm.request', sequenceNumber: 3,
      payload: { type: '_externalized', originalType: 'llm.request', _artifact: { artifactId: 'a' } },
    }
    expect(analyzeRunDivergence(baseline, target, [ev]).proven).toEqual([])
  })

  it('a PARTIAL empty toolset does NOT get the empty-set proof', () => {
    // `partial` with an empty list means "we captured none of them", not
    // "there are none". The two must not collapse.
    const baseline = { $schema: SCHEMA, tools: { declared: 'enumerated', tools: [{ name: 'a' }] } }
    const target = { $schema: SCHEMA, tools: { declared: 'partial', tools: [] } }
    const a = analyzeRunDivergence(baseline, target, [externalizedToolCall(1)])
    expect(a.proven).toEqual([])
  })
})
