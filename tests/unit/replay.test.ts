import { describe, it, expect } from 'vitest'
import { buildReplayProjection } from '../../apps/web/src/lib/replay/projection.js'
import {
  successfulRun,
  successfulRunEvents,
  failedToolRun,
  failedToolRunEvents,
  partialRun,
  partialRunEvents,
  nestedRun,
  nestedRunEvents,
} from '../fixtures/events.js'
import type { Event, Run } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Makes a minimal Run for use in isolated tests. */
function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-test',
    orgId: 'org-test-001',
    projectId: 'proj-001',
    agentId: 'agent-001',
    status: 'completed',
    startedAt: 1_000_000_000_000,
    metadata: {},
    tags: [],
    ...overrides,
  }
}

/** Makes a minimal Event for use in isolated tests. */
function makeEvent(overrides: Partial<Event>): Event {
  return {
    id: 'evt-x',
    runId: 'run-test',
    orgId: 'org-test-001',
    type: 'custom',
    sequenceNumber: 1,
    timestamp: 1_000_000_001_000,
    payload: { type: 'custom', data: null },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test 1: Empty events
// ---------------------------------------------------------------------------

describe('buildReplayProjection — empty events', () => {
  it('returns frames: [] when events array is empty', () => {
    const result = buildReplayProjection(makeRun(), [])
    expect(result.frames).toEqual([])
  })

  it('returns totalEvents: 0 when events array is empty', () => {
    const result = buildReplayProjection(makeRun(), [])
    expect(result.totalEvents).toBe(0)
  })

  it('returns duration_ms: 0 when events array is empty', () => {
    const result = buildReplayProjection(makeRun(), [])
    expect(result.duration_ms).toBe(0)
  })

  it('returns isComplete: false when events array is empty', () => {
    const result = buildReplayProjection(makeRun(), [])
    expect(result.isComplete).toBe(false)
  })

  it('returns isFailed: false when events array is empty', () => {
    const result = buildReplayProjection(makeRun(), [])
    expect(result.isFailed).toBe(false)
  })

  it('sets runId from the run record', () => {
    const result = buildReplayProjection(makeRun({ id: 'run-xyz' }), [])
    expect(result.runId).toBe('run-xyz')
  })
})

// ---------------------------------------------------------------------------
// Test 2: Successful run
// ---------------------------------------------------------------------------

describe('buildReplayProjection — successful run', () => {
  it('produces the correct frame count', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    expect(result.frames).toHaveLength(successfulRunEvents.length)
  })

  it('totalEvents equals the number of input events', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    expect(result.totalEvents).toBe(successfulRunEvents.length)
  })

  it('isComplete is true when run.completed event is present', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    expect(result.isComplete).toBe(true)
  })

  it('isFailed is false for a successful run', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    expect(result.isFailed).toBe(false)
  })

  it('elapsed_ms increases monotonically across frames', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    for (let i = 1; i < result.frames.length; i++) {
      expect(result.frames[i]!.elapsed_ms).toBeGreaterThanOrEqual(
        result.frames[i - 1]!.elapsed_ms
      )
    }
  })

  it('first frame has elapsed_ms of 0', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    expect(result.frames[0]!.elapsed_ms).toBe(0)
  })

  it('duration_ms equals timestamp difference between first and last event', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    const first = successfulRunEvents[0]!.timestamp
    const last = successfulRunEvents[successfulRunEvents.length - 1]!.timestamp
    expect(result.duration_ms).toBe(last - first)
  })
})

// ---------------------------------------------------------------------------
// Test 3: Actor assignment
// ---------------------------------------------------------------------------

describe('buildReplayProjection — actor assignment', () => {
  it('llm.request event gets actor="llm"', () => {
    const events = [makeEvent({ type: 'llm.request', id: 'e1', payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('llm')
  })

  it('llm.response event gets actor="llm"', () => {
    const events = [makeEvent({ type: 'llm.response', id: 'e1', payload: { type: 'llm.response', model: 'gpt-4o', content: 'hi', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, finish_reason: 'stop' } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('llm')
  })

  it('tool.call event gets actor="tool"', () => {
    const events = [makeEvent({ type: 'tool.call', id: 'e1', payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('tool')
  })

  it('tool.result event gets actor="tool"', () => {
    const events = [makeEvent({ type: 'tool.result', id: 'e1', payload: { type: 'tool.result', call_id: 'c1', output: {}, duration_ms: 10 } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('tool')
  })

  it('run.started event gets actor="system"', () => {
    const events = [makeEvent({ type: 'run.started', id: 'e1', payload: { type: 'run.started', input: {}, config: {} } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('system')
  })

  it('run.completed event gets actor="system"', () => {
    const events = [makeEvent({ type: 'run.completed', id: 'e1', payload: { type: 'run.completed', output: {}, duration_ms: 1000 } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('system')
  })

  it('http.request event gets actor="http"', () => {
    const events = [makeEvent({ type: 'http.request', id: 'e1', payload: { type: 'http.request', method: 'GET', url: 'https://example.com', headers_redacted: [] } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('http')
  })

  it('memory.read event gets actor="memory"', () => {
    const events = [makeEvent({ type: 'memory.read', id: 'e1', payload: { type: 'memory.read', key: 'ctx' } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('memory')
  })

  it('retrieval.query event gets actor="retrieval"', () => {
    const events = [makeEvent({ type: 'retrieval.query', id: 'e1', payload: { type: 'retrieval.query', query: 'docs about X' } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('retrieval')
  })

  it('custom event gets actor="unknown"', () => {
    const events = [makeEvent({ type: 'custom', id: 'e1', payload: { type: 'custom', data: null } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.actor).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// Test 4: Status assignment
// ---------------------------------------------------------------------------

describe('buildReplayProjection — status assignment', () => {
  it('tool.error event gets status="error"', () => {
    const events = [makeEvent({ type: 'tool.error', id: 'e1', payload: { type: 'tool.error', error: { message: 'oops' } } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.status).toBe('error')
  })

  it('llm.error event gets status="error"', () => {
    const events = [makeEvent({ type: 'llm.error', id: 'e1', payload: { type: 'llm.error', error: { message: 'bad request' } } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.status).toBe('error')
  })

  it('run.completed event gets status="terminal"', () => {
    const events = [makeEvent({ type: 'run.completed', id: 'e1', payload: { type: 'run.completed', output: {}, duration_ms: 100 } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.status).toBe('terminal')
  })

  it('run.failed event gets status="terminal"', () => {
    const events = [makeEvent({ type: 'run.failed', id: 'e1', payload: { type: 'run.failed', error: { message: 'failure' }, duration_ms: 100 } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.status).toBe('terminal')
  })

  it('run.cancelled event gets status="terminal"', () => {
    const events = [makeEvent({ type: 'run.cancelled', id: 'e1', payload: { type: 'run.cancelled' } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.status).toBe('terminal')
  })

  it('llm.request event gets status="ok"', () => {
    const events = [makeEvent({ type: 'llm.request', id: 'e1', payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.status).toBe('ok')
  })

  it('tool.call event gets status="ok"', () => {
    const events = [makeEvent({ type: 'tool.call', id: 'e1', payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' } })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Test 5: Depth computation
// ---------------------------------------------------------------------------

describe('buildReplayProjection — depth computation', () => {
  it('root events (no parentEventId) get depth=0', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    // evt-001: run.started, no parent
    const frame = result.frames.find(f => f.event.id === 'evt-001')
    expect(frame!.depth).toBe(0)
  })

  it('llm.request (no parent) gets depth=0', () => {
    const result = buildReplayProjection(successfulRun, successfulRunEvents)
    const frame = result.frames.find(f => f.event.id === 'evt-002')
    expect(frame!.depth).toBe(0)
  })

  it('direct child events get depth=1', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    // evt-043 (llm.response) has parent evt-042 (llm.request) — 1 hop up the chain
    const frame = result.frames.find(f => f.event.id === 'evt-043')
    expect(frame!.depth).toBe(1)
  })

  it('grandchild events get depth=3 (chain: http.request → tool.call → llm.response → llm.request)', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    // evt-045 (http.request) → parent evt-044 (tool.call) → parent evt-043 (llm.response) → parent evt-042 (llm.request) → no parent
    // That is 3 hops up the chain, so depth=3
    const frame = result.frames.find(f => f.event.id === 'evt-045')
    expect(frame!.depth).toBe(3)
  })

  it('http.response nested under tool.call gets depth=3', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    // evt-046 → evt-044 → evt-043 → evt-042 → stop: 3 hops
    const frame = result.frames.find(f => f.event.id === 'evt-046')
    expect(frame!.depth).toBe(3)
  })

  it('tool.result nested under tool.call gets depth=3', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    // evt-047 → evt-044 → evt-043 → evt-042 → stop: 3 hops
    const frame = result.frames.find(f => f.event.id === 'evt-047')
    expect(frame!.depth).toBe(3)
  })

  it('nested run — tool.call (depth=2) is correctly computed', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    // evt-044 (tool.call) → parent evt-043 (llm.response) → parent evt-042 (llm.request) → no parent
    // That is 2 hops, so depth=2
    const frame = result.frames.find(f => f.event.id === 'evt-044')
    expect(frame!.depth).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Test 6: Cycle guard
// ---------------------------------------------------------------------------

describe('buildReplayProjection — cycle guard', () => {
  it('does not infinite-loop when events have circular parentEventId references', () => {
    // evt-A → parent: evt-B, evt-B → parent: evt-A (mutual cycle)
    const events: Event[] = [
      makeEvent({ id: 'evt-A', sequenceNumber: 1, timestamp: 1_000_000_001_000, parentEventId: 'evt-B' }),
      makeEvent({ id: 'evt-B', sequenceNumber: 2, timestamp: 1_000_000_002_000, parentEventId: 'evt-A' }),
    ]
    // This must complete without hanging.
    expect(() => buildReplayProjection(makeRun(), events)).not.toThrow()
  })

  it('cyclic events get a finite depth value', () => {
    const events: Event[] = [
      makeEvent({ id: 'evt-A', sequenceNumber: 1, timestamp: 1_000_000_001_000, parentEventId: 'evt-B' }),
      makeEvent({ id: 'evt-B', sequenceNumber: 2, timestamp: 1_000_000_002_000, parentEventId: 'evt-A' }),
    ]
    const result = buildReplayProjection(makeRun(), events)
    for (const frame of result.frames) {
      expect(Number.isFinite(frame.depth)).toBe(true)
    }
  })

  it('self-referential parentEventId does not infinite-loop', () => {
    const events: Event[] = [
      makeEvent({ id: 'evt-self', sequenceNumber: 1, timestamp: 1_000_000_001_000, parentEventId: 'evt-self' }),
    ]
    expect(() => buildReplayProjection(makeRun(), events)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Test 7: PayloadPreview
// ---------------------------------------------------------------------------

describe('buildReplayProjection — payloadPreview', () => {
  it('llm.request preview contains model name', () => {
    const events = [makeEvent({
      type: 'llm.request',
      id: 'e1',
      payload: { type: 'llm.request', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.payloadPreview).toContain('gpt-4o')
  })

  it('llm.request preview contains message count', () => {
    const events = [makeEvent({
      type: 'llm.request',
      id: 'e1',
      payload: { type: 'llm.request', model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }, { role: 'system', content: 'you are helpful' }] },
    })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.payloadPreview).toContain('2')
  })

  it('tool.call preview contains tool name', () => {
    const events = [makeEvent({
      type: 'tool.call',
      id: 'e1',
      payload: { type: 'tool.call', name: 'search_database', input: {}, call_id: 'c1' },
    })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.payloadPreview).toContain('search_database')
  })

  it('tool.error preview contains error message', () => {
    const events = [makeEvent({
      type: 'tool.error',
      id: 'e1',
      payload: { type: 'tool.error', error: { message: 'Connection timeout' } },
    })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.payloadPreview).toContain('Connection timeout')
  })

  it('http.request preview contains method and URL', () => {
    const events = [makeEvent({
      type: 'http.request',
      id: 'e1',
      payload: { type: 'http.request', method: 'POST', url: 'https://api.example.com/data', headers_redacted: [] },
    })]
    const result = buildReplayProjection(makeRun(), events)
    const preview = result.frames[0]!.payloadPreview
    expect(preview).toContain('POST')
    expect(preview).toContain('https://api.example.com/data')
  })

  it('payloadPreview is truncated to at most 80 characters', () => {
    const longUrl = 'https://api.example.com/' + 'x'.repeat(100)
    const events = [makeEvent({
      type: 'http.request',
      id: 'e1',
      payload: { type: 'http.request', method: 'GET', url: longUrl, headers_redacted: [] },
    })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.payloadPreview.length).toBeLessThanOrEqual(80)
  })
})

// ---------------------------------------------------------------------------
// Test 8: Failed run
// ---------------------------------------------------------------------------

describe('buildReplayProjection — failed run', () => {
  it('isFailed is true when run.failed event is present', () => {
    const result = buildReplayProjection(failedToolRun, failedToolRunEvents)
    expect(result.isFailed).toBe(true)
  })

  it('isComplete is true when run.failed event is present (run did terminate)', () => {
    const result = buildReplayProjection(failedToolRun, failedToolRunEvents)
    expect(result.isComplete).toBe(true)
  })

  it('failed run — frame for run.failed has status="terminal"', () => {
    const result = buildReplayProjection(failedToolRun, failedToolRunEvents)
    const failedFrame = result.frames.find(f => f.event.type === 'run.failed')
    expect(failedFrame!.status).toBe('terminal')
  })

  it('failed run — frame for tool.error has status="error"', () => {
    const result = buildReplayProjection(failedToolRun, failedToolRunEvents)
    const errorFrame = result.frames.find(f => f.event.type === 'tool.error')
    expect(errorFrame!.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// Test 9: Out-of-order events
// ---------------------------------------------------------------------------

describe('buildReplayProjection — out-of-order events', () => {
  it('sorts events by sequenceNumber regardless of input order', () => {
    // Provide events in reverse order.
    const reversed = [...successfulRunEvents].reverse()
    const result = buildReplayProjection(successfulRun, reversed)
    for (let i = 1; i < result.frames.length; i++) {
      expect(result.frames[i]!.event.sequenceNumber).toBeGreaterThan(
        result.frames[i - 1]!.event.sequenceNumber
      )
    }
  })

  it('frame indices reflect sorted order (index 0 = lowest sequenceNumber)', () => {
    const reversed = [...successfulRunEvents].reverse()
    const result = buildReplayProjection(successfulRun, reversed)
    expect(result.frames[0]!.event.sequenceNumber).toBe(1)
    expect(result.frames[0]!.index).toBe(0)
  })

  it('elapsed_ms is still monotonically non-decreasing after sort', () => {
    const scrambled = [
      successfulRunEvents[4]!,
      successfulRunEvents[2]!,
      successfulRunEvents[0]!,
      successfulRunEvents[5]!,
      successfulRunEvents[1]!,
      successfulRunEvents[3]!,
    ]
    const result = buildReplayProjection(successfulRun, scrambled)
    for (let i = 1; i < result.frames.length; i++) {
      expect(result.frames[i]!.elapsed_ms).toBeGreaterThanOrEqual(
        result.frames[i - 1]!.elapsed_ms
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Test 10: Nested events scenario (scenario 5)
// ---------------------------------------------------------------------------

describe('buildReplayProjection — nested events', () => {
  it('depth=1 events are correctly identified', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    const depthOneFrames = result.frames.filter(f => f.depth === 1)
    // evt-043 (llm.response → parent: evt-042 only, 1 hop)
    expect(depthOneFrames.length).toBeGreaterThanOrEqual(1)
  })

  it('depth=3 events are correctly identified', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    const depthThreeFrames = result.frames.filter(f => f.depth === 3)
    // http.request, http.response, tool.result: each traverses tool.call → llm.response → llm.request = 3 hops
    expect(depthThreeFrames.length).toBeGreaterThanOrEqual(3)
  })

  it('root events have depth=0', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    const rootFrames = result.frames.filter(f => f.depth === 0)
    // run.started, llm.request, run.completed have no parent
    expect(rootFrames.length).toBeGreaterThanOrEqual(1)
  })

  it('produces correct total event count', () => {
    const result = buildReplayProjection(nestedRun, nestedRunEvents)
    expect(result.totalEvents).toBe(nestedRunEvents.length)
  })
})

// ---------------------------------------------------------------------------
// Test: Partial run
// ---------------------------------------------------------------------------

describe('buildReplayProjection — partial run', () => {
  it('isComplete is false when no terminal event exists', () => {
    const result = buildReplayProjection(partialRun, partialRunEvents)
    expect(result.isComplete).toBe(false)
  })

  it('isFailed is false when no failed event exists', () => {
    const result = buildReplayProjection(partialRun, partialRunEvents)
    expect(result.isFailed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test: Single-event run
// ---------------------------------------------------------------------------

describe('buildReplayProjection — single event', () => {
  it('duration_ms is 0 for a single event', () => {
    const events = [makeEvent({ sequenceNumber: 1, timestamp: 1_000_000_001_000 })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.duration_ms).toBe(0)
  })

  it('elapsed_ms of the single frame is 0', () => {
    const events = [makeEvent({ sequenceNumber: 1, timestamp: 1_000_000_001_000 })]
    const result = buildReplayProjection(makeRun(), events)
    expect(result.frames[0]!.elapsed_ms).toBe(0)
  })
})
