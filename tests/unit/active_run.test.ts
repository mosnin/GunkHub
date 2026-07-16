import { isTerminalStatus } from '@agent-flight-recorder/contracts'
import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for the active run monitoring features introduced in
// Prompt 18: auto-advance window computation, live polling event deduplication,
// terminal status detection, and the isLive activation rule.
//
// All logic is either inlined or imported from @agent-flight-recorder/contracts.
// No React, no DOM, no network calls.
// ---------------------------------------------------------------------------

const WINDOW_SIZE = 100

// ---------------------------------------------------------------------------
// Group 1: Auto-advance window computation
//
// After handleLoadMore completes, Timeline and EventInspector both set:
//   windowStart = Math.max(0, newTotal - WINDOW_SIZE)
// This ensures the newly loaded events are immediately visible.
// ---------------------------------------------------------------------------

describe('Auto-advance window computation', () => {
  it('newTotal <= 100 yields windowStart = 0', () => {
    const newTotal = 80
    const newWindowStart = Math.max(0, newTotal - WINDOW_SIZE)
    expect(newWindowStart).toBe(0)
  })

  it('newTotal = 150 yields windowStart = 50', () => {
    const newTotal = 150
    const newWindowStart = Math.max(0, newTotal - WINDOW_SIZE)
    expect(newWindowStart).toBe(50)
  })

  it('newTotal = 300 yields windowStart = 200', () => {
    const newTotal = 300
    const newWindowStart = Math.max(0, newTotal - WINDOW_SIZE)
    expect(newWindowStart).toBe(200)
  })

  it('newTotal = 100 yields windowStart = 0 (boundary: exactly one window)', () => {
    const newTotal = 100
    const newWindowStart = Math.max(0, newTotal - WINDOW_SIZE)
    expect(newWindowStart).toBe(0)
  })

  it('newTotal = 101 yields windowStart = 1 (one past boundary)', () => {
    const newTotal = 101
    const newWindowStart = Math.max(0, newTotal - WINDOW_SIZE)
    expect(newWindowStart).toBe(1)
  })

  it('newTotal = 1 yields windowStart = 0 (single event)', () => {
    const newTotal = 1
    const newWindowStart = Math.max(0, newTotal - WINDOW_SIZE)
    expect(newWindowStart).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Group 2: Event deduplication for live polling
//
// The no-cursor polling path re-fetches from start and deduplicates so that
// events already present in allEvents are not appended again:
//   brandNew = polledEvents.filter(e => !existingIds.has(e.id))
// ---------------------------------------------------------------------------

interface MinimalEvent {
  id: string
  sequenceNumber: number
}

function deduplicate(
  existingEvents: MinimalEvent[],
  polledEvents: MinimalEvent[],
): MinimalEvent[] {
  const existingIds = new Set(existingEvents.map((e) => e.id))
  return polledEvents.filter((e) => !existingIds.has(e.id))
}

describe('Event deduplication for live polling', () => {
  it('empty existing set: all polled events are brand new', () => {
    const polled: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
    ]
    const brandNew = deduplicate([], polled)
    expect(brandNew).toEqual(polled)
  })

  it('existing set contains all polled events: no new events returned', () => {
    const existing: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
    ]
    const polled: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
    ]
    const brandNew = deduplicate(existing, polled)
    expect(brandNew).toHaveLength(0)
  })

  it('partial overlap: only non-overlapping polled events are returned', () => {
    const existing: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
    ]
    const polled: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
      { id: 'evt-3', sequenceNumber: 3 },
      { id: 'evt-4', sequenceNumber: 4 },
    ]
    const brandNew = deduplicate(existing, polled)
    expect(brandNew).toHaveLength(2)
    expect(brandNew.map((e) => e.id)).toEqual(['evt-3', 'evt-4'])
  })

  it('polled events in same order as existing: correctly filters duplicates', () => {
    const existing: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
      { id: 'evt-3', sequenceNumber: 3 },
    ]
    const polled: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
      { id: 'evt-3', sequenceNumber: 3 },
    ]
    const brandNew = deduplicate(existing, polled)
    expect(brandNew).toHaveLength(0)
  })

  it('new events have higher sequence numbers than existing ones', () => {
    const existing: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
    ]
    const polled: MinimalEvent[] = [
      { id: 'evt-1', sequenceNumber: 1 },
      { id: 'evt-2', sequenceNumber: 2 },
      { id: 'evt-3', sequenceNumber: 3 },
    ]
    const brandNew = deduplicate(existing, polled)
    expect(brandNew).toHaveLength(1)
    expect(brandNew[0].sequenceNumber).toBeGreaterThan(
      Math.max(...existing.map((e) => e.sequenceNumber)),
    )
  })
})

// ---------------------------------------------------------------------------
// Group 3: Terminal status detection
//
// Uses isTerminalStatus from @agent-flight-recorder/contracts directly.
// ---------------------------------------------------------------------------

describe('Terminal status detection', () => {
  it("'running' is not terminal", () => {
    expect(isTerminalStatus('running')).toBe(false)
  })

  it("'pending' is not terminal", () => {
    expect(isTerminalStatus('pending')).toBe(false)
  })

  it("'completed' is terminal", () => {
    expect(isTerminalStatus('completed')).toBe(true)
  })

  it("'failed' is terminal", () => {
    expect(isTerminalStatus('failed')).toBe(true)
  })

  it("'cancelled' is terminal", () => {
    expect(isTerminalStatus('cancelled')).toBe(true)
  })

  it("'timed_out' is terminal", () => {
    expect(isTerminalStatus('timed_out')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group 4: isLive activation rule
//
// page.tsx derives isLive = run.status === 'running' and passes it to
// RunHeader, Timeline, and EventInspector.
// ---------------------------------------------------------------------------

type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

function computeIsLive(status: RunStatus): boolean {
  return status === 'running'
}

describe('isLive activation rule', () => {
  it("status === 'running' → isLive is true", () => {
    expect(computeIsLive('running')).toBe(true)
  })

  it("status === 'completed' → isLive is false", () => {
    expect(computeIsLive('completed')).toBe(false)
  })

  it("status === 'pending' → isLive is false", () => {
    expect(computeIsLive('pending')).toBe(false)
  })

  it("status === 'failed' → isLive is false", () => {
    expect(computeIsLive('failed')).toBe(false)
  })
})
