import { describe, it, expect } from 'vitest'

import { buildRunDiff, MAX_EVENTS_PER_DIFF } from '../../apps/web/src/lib/replay/diff.js'
import {
  runARef,
  runBRef,
  runAEvents,
  runBEvents,
} from '../fixtures/events.js'

import type { Event, RunDiff } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Creates a minimal run.started event at the given sequence number. */
function startEvent(seq: number, runId = 'run-a'): Event {
  return makeEvent({
    id: `evt-start-${runId}-${seq}`,
    runId,
    type: 'run.started',
    sequenceNumber: seq,
    timestamp: 1_000_000_000_000 + seq * 1000,
    payload: { type: 'run.started', input: { task: 'test' }, config: {} },
  })
}

/** Creates a minimal run.completed event at the given sequence number. */
function completedEvent(seq: number, runId = 'run-a'): Event {
  return makeEvent({
    id: `evt-done-${runId}-${seq}`,
    runId,
    type: 'run.completed',
    sequenceNumber: seq,
    timestamp: 1_000_000_000_000 + seq * 1000,
    payload: { type: 'run.completed', output: { answer: 'done' }, duration_ms: 1000 },
  })
}

// ---------------------------------------------------------------------------
// Test 1: Identical runs
// ---------------------------------------------------------------------------

describe('buildRunDiff — identical runs', () => {
  it('all EventDiffs have kind="same" when runs are identical', () => {
    // Use the same events for both sides — same payload, same type, same structure.
    const result = buildRunDiff('run-a', 'run-a', runAEvents, runAEvents)
    for (const diff of result.eventDiffs) {
      expect(diff.kind).toBe('same')
    }
  })

  it('summary.same equals the total event count', () => {
    const result = buildRunDiff('run-a', 'run-a', runAEvents, runAEvents)
    expect(result.summary.same).toBe(runAEvents.length)
  })

  it('summary.added is 0 for identical runs', () => {
    const result = buildRunDiff('run-a', 'run-a', runAEvents, runAEvents)
    expect(result.summary.added).toBe(0)
  })

  it('summary.removed is 0 for identical runs', () => {
    const result = buildRunDiff('run-a', 'run-a', runAEvents, runAEvents)
    expect(result.summary.removed).toBe(0)
  })

  it('summary.changed is 0 for identical runs', () => {
    const result = buildRunDiff('run-a', 'run-a', runAEvents, runAEvents)
    expect(result.summary.changed).toBe(0)
  })

  it('statusChanged is false for identical runs', () => {
    const result = buildRunDiff('run-a', 'run-a', runAEvents, runAEvents)
    expect(result.summary.statusChanged).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 2: Run A longer than run B — extra A events are kind="removed"
// ---------------------------------------------------------------------------

describe('buildRunDiff — run A longer than run B', () => {
  it('extra events from A are kind="removed"', () => {
    const leftEvents = [
      startEvent(1, 'run-l'),
      completedEvent(2, 'run-l'),
      makeEvent({ id: 'extra', runId: 'run-l', sequenceNumber: 3, timestamp: 1_000_000_003_000 }),
    ]
    const rightEvents = [
      startEvent(1, 'run-r'),
      completedEvent(2, 'run-r'),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const lastDiff = result.eventDiffs[2]!
    expect(lastDiff.kind).toBe('removed')
  })

  it('removed events have leftEvent set', () => {
    const leftEvents = [
      startEvent(1, 'run-l'),
      makeEvent({ id: 'extra-l', runId: 'run-l', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
    ]
    const rightEvents = [startEvent(1, 'run-r')]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const removedDiff = result.eventDiffs.find(d => d.kind === 'removed')!
    expect(removedDiff.leftEvent).toBeDefined()
  })

  it('removed events have no rightEvent', () => {
    const leftEvents = [
      startEvent(1, 'run-l'),
      makeEvent({ id: 'extra-l', runId: 'run-l', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
    ]
    const rightEvents = [startEvent(1, 'run-r')]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const removedDiff = result.eventDiffs.find(d => d.kind === 'removed')!
    expect(removedDiff.rightEvent).toBeUndefined()
  })

  it('summary.removed equals the count of extra events in A', () => {
    const leftEvents = [
      startEvent(1, 'run-l'),
      makeEvent({ id: 'el2', runId: 'run-l', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
      makeEvent({ id: 'el3', runId: 'run-l', sequenceNumber: 3, timestamp: 1_000_000_003_000 }),
    ]
    const rightEvents = [startEvent(1, 'run-r')]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    expect(result.summary.removed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Test 3: Run B longer than run A — extra B events are kind="added"
// ---------------------------------------------------------------------------

describe('buildRunDiff — run B longer than run A', () => {
  it('extra events from B are kind="added"', () => {
    const leftEvents = [startEvent(1, 'run-l')]
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'extra-r', runId: 'run-r', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const lastDiff = result.eventDiffs[1]!
    expect(lastDiff.kind).toBe('added')
  })

  it('added events have rightEvent set', () => {
    const leftEvents = [startEvent(1, 'run-l')]
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'extra-r', runId: 'run-r', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const addedDiff = result.eventDiffs.find(d => d.kind === 'added')!
    expect(addedDiff.rightEvent).toBeDefined()
  })

  it('added events have no leftEvent', () => {
    const leftEvents = [startEvent(1, 'run-l')]
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'extra-r', runId: 'run-r', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const addedDiff = result.eventDiffs.find(d => d.kind === 'added')!
    expect(addedDiff.leftEvent).toBeUndefined()
  })

  it('summary.added equals the count of extra events in B', () => {
    const leftEvents = [startEvent(1, 'run-l')]
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'er2', runId: 'run-r', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
      makeEvent({ id: 'er3', runId: 'run-r', sequenceNumber: 3, timestamp: 1_000_000_003_000 }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    expect(result.summary.added).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Test 4: Type mismatch at position 2
// ---------------------------------------------------------------------------

describe('buildRunDiff — type mismatch', () => {
  it('EventDiff at position 1 (index 1) has kind="changed" when types differ', () => {
    const leftEvents = [
      startEvent(1, 'run-l'),
      makeEvent({ id: 'el2', runId: 'run-l', type: 'llm.request', sequenceNumber: 2, timestamp: 1_000_000_002_000, payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } }),
    ]
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'er2', runId: 'run-r', type: 'tool.call', sequenceNumber: 2, timestamp: 1_000_000_002_000, payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' } }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    expect(result.eventDiffs[1]!.kind).toBe('changed')
  })

  it('changes array includes type field change when types differ', () => {
    const leftEvents = [
      startEvent(1, 'run-l'),
      makeEvent({ id: 'el2', runId: 'run-l', type: 'llm.request', sequenceNumber: 2, timestamp: 1_000_000_002_000, payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } }),
    ]
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'er2', runId: 'run-r', type: 'tool.call', sequenceNumber: 2, timestamp: 1_000_000_002_000, payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' } }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const changedDiff = result.eventDiffs[1]!
    const typeChange = changedDiff.changes?.find(c => c.path === 'type')
    expect(typeChange).toBeDefined()
    expect(typeChange!.left).toBe('llm.request')
    expect(typeChange!.right).toBe('tool.call')
  })

  it('both leftEvent and rightEvent are set on a changed diff', () => {
    const leftEvents = [
      startEvent(1, 'run-l'),
      makeEvent({ id: 'el2', runId: 'run-l', type: 'llm.request', sequenceNumber: 2, timestamp: 1_000_000_002_000, payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } }),
    ]
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'er2', runId: 'run-r', type: 'tool.call', sequenceNumber: 2, timestamp: 1_000_000_002_000, payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' } }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const changedDiff = result.eventDiffs[1]!
    expect(changedDiff.leftEvent).toBeDefined()
    expect(changedDiff.rightEvent).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Test 5: Payload mismatch
// ---------------------------------------------------------------------------

describe('buildRunDiff — payload mismatch', () => {
  it('kind="changed" when payloads differ but types match', () => {
    const leftEvents = [
      makeEvent({ id: 'el1', runId: 'run-l', type: 'llm.request', sequenceNumber: 1, timestamp: 1_000_000_001_000, payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } }),
    ]
    const rightEvents = [
      makeEvent({ id: 'er1', runId: 'run-r', type: 'llm.request', sequenceNumber: 1, timestamp: 1_000_000_001_000, payload: { type: 'llm.request', model: 'gpt-4-turbo', messages: [] } }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    expect(result.eventDiffs[0]!.kind).toBe('changed')
  })

  it('changes array includes the differing payload field', () => {
    const leftEvents = [
      makeEvent({ id: 'el1', runId: 'run-l', type: 'llm.request', sequenceNumber: 1, timestamp: 1_000_000_001_000, payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } }),
    ]
    const rightEvents = [
      makeEvent({ id: 'er1', runId: 'run-r', type: 'llm.request', sequenceNumber: 1, timestamp: 1_000_000_001_000, payload: { type: 'llm.request', model: 'gpt-4-turbo', messages: [] } }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    const changedDiff = result.eventDiffs[0]!
    const modelChange = changedDiff.changes?.find(c => c.path === 'payload.model')
    expect(modelChange).toBeDefined()
    expect(modelChange!.left).toBe('gpt-4o')
    expect(modelChange!.right).toBe('gpt-4-turbo')
  })

  it('summary.changed increments for each changed position', () => {
    const leftEvents = [
      makeEvent({ id: 'el1', runId: 'run-l', type: 'llm.request', sequenceNumber: 1, timestamp: 1_000_000_001_000, payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } }),
      makeEvent({ id: 'el2', runId: 'run-l', type: 'llm.request', sequenceNumber: 2, timestamp: 1_000_000_002_000, payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } }),
    ]
    const rightEvents = [
      makeEvent({ id: 'er1', runId: 'run-r', type: 'llm.request', sequenceNumber: 1, timestamp: 1_000_000_001_000, payload: { type: 'llm.request', model: 'gpt-4-turbo', messages: [] } }),
      makeEvent({ id: 'er2', runId: 'run-r', type: 'llm.request', sequenceNumber: 2, timestamp: 1_000_000_002_000, payload: { type: 'llm.request', model: 'gpt-4-turbo', messages: [] } }),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    expect(result.summary.changed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Test 6: statusChanged
// ---------------------------------------------------------------------------

describe('buildRunDiff — statusChanged', () => {
  it('statusChanged is true when terminal event type differs', () => {
    // Run A ends with run.completed, Run B ends with run.failed
    const result = buildRunDiff(runARef.id, runBRef.id, runAEvents, runBEvents)
    expect(result.summary.statusChanged).toBe(true)
  })

  it('statusChanged is false when both runs end with the same event type', () => {
    const leftEvents = [startEvent(1, 'run-l'), completedEvent(2, 'run-l')]
    const rightEvents = [startEvent(1, 'run-r'), completedEvent(2, 'run-r')]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    expect(result.summary.statusChanged).toBe(false)
  })

  it('statusChanged is true when run A ends with run.completed and B has no terminal event', () => {
    const leftEvents = [startEvent(1, 'run-l'), completedEvent(2, 'run-l')]
    const rightEvents = [startEvent(1, 'run-r')] // no terminal event
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    // Last event of B is run.started, last of A is run.completed — they differ
    expect(result.summary.statusChanged).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 7: Empty left run
// ---------------------------------------------------------------------------

describe('buildRunDiff — empty left run', () => {
  it('all right events are kind="added"', () => {
    const rightEvents = [startEvent(1, 'run-r'), completedEvent(2, 'run-r')]
    const result = buildRunDiff('run-l', 'run-r', [], rightEvents)
    for (const diff of result.eventDiffs) {
      expect(diff.kind).toBe('added')
    }
  })

  it('summary.added equals the number of right events', () => {
    const rightEvents = [startEvent(1, 'run-r'), completedEvent(2, 'run-r')]
    const result = buildRunDiff('run-l', 'run-r', [], rightEvents)
    expect(result.summary.added).toBe(rightEvents.length)
  })

  it('summary.removed is 0', () => {
    const rightEvents = [startEvent(1, 'run-r'), completedEvent(2, 'run-r')]
    const result = buildRunDiff('run-l', 'run-r', [], rightEvents)
    expect(result.summary.removed).toBe(0)
  })

  it('summary.same is 0', () => {
    const rightEvents = [startEvent(1, 'run-r'), completedEvent(2, 'run-r')]
    const result = buildRunDiff('run-l', 'run-r', [], rightEvents)
    expect(result.summary.same).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Test 8: Empty right run
// ---------------------------------------------------------------------------

describe('buildRunDiff — empty right run', () => {
  it('all left events are kind="removed"', () => {
    const leftEvents = [startEvent(1, 'run-l'), completedEvent(2, 'run-l')]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, [])
    for (const diff of result.eventDiffs) {
      expect(diff.kind).toBe('removed')
    }
  })

  it('summary.removed equals the number of left events', () => {
    const leftEvents = [startEvent(1, 'run-l'), completedEvent(2, 'run-l')]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, [])
    expect(result.summary.removed).toBe(leftEvents.length)
  })

  it('summary.added is 0', () => {
    const leftEvents = [startEvent(1, 'run-l'), completedEvent(2, 'run-l')]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, [])
    expect(result.summary.added).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Test 9: Two similar runs with one divergence (scenario 6)
// ---------------------------------------------------------------------------

describe('buildRunDiff — two similar runs with one divergence', () => {
  it('first 4 events (positions 1-4) are all kind="same"', () => {
    const result = buildRunDiff(runARef.id, runBRef.id, runAEvents, runBEvents)
    // Positions 0-3 (sequenceNumbers 1-4) are identical between A and B
    for (let i = 0; i < 4; i++) {
      expect(result.eventDiffs[i]!.kind).toBe('same')
    }
  })

  it('divergence first appears at position 4 (index 4, sequenceNumber 5)', () => {
    const result = buildRunDiff(runARef.id, runBRef.id, runAEvents, runBEvents)
    // Position 4 (seq 5): A has tool.result, B has tool.error
    const firstDivergence = result.eventDiffs.find(d => d.kind !== 'same')
    expect(firstDivergence).toBeDefined()
    expect(firstDivergence!.sequenceNumber).toBe(5)
  })

  it('divergent position has kind="changed"', () => {
    const result = buildRunDiff(runARef.id, runBRef.id, runAEvents, runBEvents)
    const firstDivergence = result.eventDiffs.find(d => d.kind !== 'same')!
    expect(firstDivergence.kind).toBe('changed')
  })

  it('divergent event type change is detected in changes array', () => {
    const result = buildRunDiff(runARef.id, runBRef.id, runAEvents, runBEvents)
    const changedDiffs = result.eventDiffs.filter(d => d.kind === 'changed')
    const firstChanged = changedDiffs[0]!
    const typeChange = firstChanged.changes?.find(c => c.path === 'type')
    expect(typeChange).toBeDefined()
    expect(typeChange!.left).toBe('tool.result')
    expect(typeChange!.right).toBe('tool.error')
  })

  it('result has correct leftRunId and rightRunId', () => {
    const result = buildRunDiff(runARef.id, runBRef.id, runAEvents, runBEvents)
    expect(result.leftRunId).toBe(runARef.id)
    expect(result.rightRunId).toBe(runBRef.id)
  })
})

// ---------------------------------------------------------------------------
// Test 10: Summary counts
// ---------------------------------------------------------------------------

describe('buildRunDiff — summary counts', () => {
  it('added + removed + changed + same equals eventDiffs.length', () => {
    const result = buildRunDiff(runARef.id, runBRef.id, runAEvents, runBEvents)
    const { added, removed, changed, same } = result.summary
    expect(added + removed + changed + same).toBe(result.eventDiffs.length)
  })

  it('sum invariant holds for identical runs', () => {
    const result = buildRunDiff('r', 'r', runAEvents, runAEvents)
    const { added, removed, changed, same } = result.summary
    expect(added + removed + changed + same).toBe(result.eventDiffs.length)
  })

  it('sum invariant holds when left is empty', () => {
    const result = buildRunDiff('r-l', 'r-r', [], runAEvents)
    const { added, removed, changed, same } = result.summary
    expect(added + removed + changed + same).toBe(result.eventDiffs.length)
  })

  it('sum invariant holds when right is empty', () => {
    const result = buildRunDiff('r-l', 'r-r', runAEvents, [])
    const { added, removed, changed, same } = result.summary
    expect(added + removed + changed + same).toBe(result.eventDiffs.length)
  })

  it('sum invariant holds for scenario 6 divergence', () => {
    const result = buildRunDiff(runARef.id, runBRef.id, runAEvents, runBEvents)
    const { added, removed, changed, same } = result.summary
    expect(added + removed + changed + same).toBe(result.eventDiffs.length)
  })

  it('out-of-order events do not break the sum invariant', () => {
    const reversed = [...runAEvents].reverse()
    const result = buildRunDiff(runARef.id, runBRef.id, reversed, runBEvents)
    const { added, removed, changed, same } = result.summary
    expect(added + removed + changed + same).toBe(result.eventDiffs.length)
  })

  it('both empty runs produce eventDiffs of length 0', () => {
    const result = buildRunDiff('r-l', 'r-r', [], [])
    expect(result.eventDiffs).toHaveLength(0)
    const { added, removed, changed, same } = result.summary
    expect(added + removed + changed + same).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Additional structural tests
// ---------------------------------------------------------------------------

describe('buildRunDiff — structural invariants', () => {
  it('eventDiffs are produced in sequenceNumber order (left-side driven)', () => {
    const leftEvents = [
      startEvent(1, 'run-l'),
      makeEvent({ id: 'el2', runId: 'run-l', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
      completedEvent(3, 'run-l'),
    ]
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'er2', runId: 'run-r', sequenceNumber: 2, timestamp: 1_000_000_002_000 }),
      completedEvent(3, 'run-r'),
    ]
    const result = buildRunDiff('run-l', 'run-r', leftEvents, rightEvents)
    // sequenceNumber should be non-decreasing across diffs
    for (let i = 1; i < result.eventDiffs.length; i++) {
      expect(result.eventDiffs[i]!.sequenceNumber).toBeGreaterThanOrEqual(
        result.eventDiffs[i - 1]!.sequenceNumber
      )
    }
  })

  it('out-of-order input events are sorted before diffing', () => {
    // Provide left events in reverse order — result should be same as sorted
    const leftInOrder = [
      startEvent(1, 'run-l'),
      makeEvent({ id: 'el2', runId: 'run-l', sequenceNumber: 2, timestamp: 1_000_000_002_000, type: 'custom', payload: { type: 'custom', data: 'x' } }),
    ]
    const leftReversed = [...leftInOrder].reverse()
    const rightEvents = [
      startEvent(1, 'run-r'),
      makeEvent({ id: 'er2', runId: 'run-r', sequenceNumber: 2, timestamp: 1_000_000_002_000, type: 'custom', payload: { type: 'custom', data: 'x' } }),
    ]
    const resultOrdered = buildRunDiff('run-l', 'run-r', leftInOrder, rightEvents)
    const resultReversed = buildRunDiff('run-l', 'run-r', leftReversed, rightEvents)
    // Both should produce the same number of diffs with the same kinds
    expect(resultOrdered.eventDiffs.map(d => d.kind)).toEqual(resultReversed.eventDiffs.map(d => d.kind))
  })
})

// ---------------------------------------------------------------------------
// Diff truncation
// ---------------------------------------------------------------------------

describe('Diff truncation', () => {
  it('RunDiff accepts truncated: true', () => {
    const diff: RunDiff = {
      leftRunId: 'run-a',
      rightRunId: 'run-b',
      eventDiffs: [],
      summary: { added: 0, removed: 0, changed: 0, same: 0, statusChanged: false },
      truncated: true,
    }
    expect(diff.truncated).toBe(true)
  })

  it('RunDiff truncated defaults to undefined when not set', () => {
    const diff: RunDiff = {
      leftRunId: 'run-a',
      rightRunId: 'run-b',
      eventDiffs: [],
      summary: { added: 0, removed: 0, changed: 0, same: 0, statusChanged: false },
    }
    expect(diff.truncated).toBeUndefined()
  })

  it('MAX_EVENTS_PER_DIFF is 10000', () => {
    expect(MAX_EVENTS_PER_DIFF).toBe(10_000)
  })

  it('MAX_EVENTS_PER_DIFF is positive', () => {
    expect(MAX_EVENTS_PER_DIFF).toBeGreaterThan(0)
  })

  it('buildRunDiff on truncated input still produces valid summary', () => {
    // Even when events are truncated to MAX_EVENTS_PER_DIFF, buildRunDiff
    // should produce a consistent summary for the subset it receives.
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ sequenceNumber: i + 1, type: 'tool.call', runId: 'run-a' })
    )
    const diff = buildRunDiff('run-a', 'run-b', events, events)
    expect(diff.summary.same).toBe(5)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.changed).toBe(0)
    expect(diff.truncated).toBeUndefined() // buildRunDiff itself doesn't set truncated
  })
})
