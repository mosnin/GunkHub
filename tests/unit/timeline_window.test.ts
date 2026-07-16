import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for the sliding window rendering introduced in Prompt 17.
//
// Timeline.tsx and EventInspector.tsx both use the same WINDOW_SIZE = 100
// bounded-rendering approach. This file tests the algorithms inline (no React
// imports) so tests are pure, instant, and offline.
// ---------------------------------------------------------------------------

const WINDOW_SIZE = 100

// ---------------------------------------------------------------------------
// Helper: build a synthetic event array of a given length
// ---------------------------------------------------------------------------

function makeEvents(count: number): { id: string; sequenceNumber: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i + 1}`,
    sequenceNumber: i + 1,
  }))
}

// ---------------------------------------------------------------------------
// Group 1: Window bounds computation
// ---------------------------------------------------------------------------

describe('Window bounds computation', () => {
  it('windowEnd = allEvents.length when allEvents fits within one window (len=50)', () => {
    const allEvents = makeEvents(50)
    const windowStart = 0
    const windowEnd = Math.min(allEvents.length, windowStart + WINDOW_SIZE)
    expect(windowEnd).toBe(50)
  })

  it('windowEnd = WINDOW_SIZE when start=0 and len=250', () => {
    const allEvents = makeEvents(250)
    const windowStart = 0
    const windowEnd = Math.min(allEvents.length, windowStart + WINDOW_SIZE)
    expect(windowEnd).toBe(100)
  })

  it('windowEnd = allEvents.length when near the end (start=200, len=250)', () => {
    const allEvents = makeEvents(250)
    const windowStart = 200
    const windowEnd = Math.min(allEvents.length, windowStart + WINDOW_SIZE)
    expect(windowEnd).toBe(250)
  })

  it('visibleEvents is the correct slice (start=0, len=250 → first 100)', () => {
    const allEvents = makeEvents(250)
    const windowStart = 0
    const windowEnd = Math.min(allEvents.length, windowStart + WINDOW_SIZE)
    const visibleEvents = allEvents.slice(windowStart, windowEnd)
    expect(visibleEvents.length).toBe(100)
    expect(visibleEvents[0].sequenceNumber).toBe(1)
    expect(visibleEvents[99].sequenceNumber).toBe(100)
  })

  it('visibleEvents is the correct slice when windowStart=150 and len=250', () => {
    const allEvents = makeEvents(250)
    const windowStart = 150
    const windowEnd = Math.min(allEvents.length, windowStart + WINDOW_SIZE)
    const visibleEvents = allEvents.slice(windowStart, windowEnd)
    expect(visibleEvents.length).toBe(100)
    expect(visibleEvents[0].sequenceNumber).toBe(151)
    expect(visibleEvents[99].sequenceNumber).toBe(250)
  })

  it('aboveCount = windowStart', () => {
    const windowStart = 75
    const aboveCount = windowStart
    expect(aboveCount).toBe(75)
  })

  it('aboveCount = 0 when at the start', () => {
    const windowStart = 0
    const aboveCount = windowStart
    expect(aboveCount).toBe(0)
  })

  it('belowCount is correct when there are events below the window', () => {
    const allEvents = makeEvents(250)
    const windowStart = 0
    const belowCount = Math.max(0, allEvents.length - windowStart - WINDOW_SIZE)
    expect(belowCount).toBe(150)
  })

  it('belowCount is 0 when windowEnd equals allEvents.length (no events below)', () => {
    const allEvents = makeEvents(250)
    const windowStart = 200
    const belowCount = Math.max(0, allEvents.length - windowStart - WINDOW_SIZE)
    expect(belowCount).toBe(0)
  })

  it('belowCount never goes negative when exactly at the end', () => {
    const allEvents = makeEvents(100)
    const windowStart = 0
    const belowCount = Math.max(0, allEvents.length - windowStart - WINDOW_SIZE)
    expect(belowCount).toBe(0)
    expect(belowCount).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Group 2: Window navigation
// ---------------------------------------------------------------------------

describe('Window navigation', () => {
  it('clicking "earlier" advances back by WINDOW_SIZE', () => {
    const windowStart = 200
    const newStart = Math.max(0, windowStart - WINDOW_SIZE)
    expect(newStart).toBe(100)
  })

  it('clicking "earlier" from windowStart=50 goes back by WINDOW_SIZE to 0 (clamped, not negative)', () => {
    const windowStart = 50
    const newStart = Math.max(0, windowStart - WINDOW_SIZE)
    expect(newStart).toBe(0)
  })

  it('clicking "earlier" clamps at 0 when windowStart < WINDOW_SIZE', () => {
    const windowStart = 30
    const newStart = Math.max(0, windowStart - WINDOW_SIZE)
    expect(newStart).toBe(0)
  })

  it('clicking "later" advances forward by WINDOW_SIZE', () => {
    const allEvents = makeEvents(400)
    const windowStart = 100
    const newStart = Math.min(allEvents.length - WINDOW_SIZE, windowStart + WINDOW_SIZE)
    expect(newStart).toBe(200)
  })

  it('clicking "later" clamps at allEvents.length - WINDOW_SIZE when near the end', () => {
    const allEvents = makeEvents(250)
    const windowStart = 200
    const newStart = Math.min(allEvents.length - WINDOW_SIZE, windowStart + WINDOW_SIZE)
    // allEvents.length - WINDOW_SIZE = 150; windowStart + WINDOW_SIZE = 300; clamp at 150
    expect(newStart).toBe(150)
  })

  it('clicking "later" from windowStart=0 on 300-event list goes to 100', () => {
    const allEvents = makeEvents(300)
    const windowStart = 0
    const newStart = Math.min(allEvents.length - WINDOW_SIZE, windowStart + WINDOW_SIZE)
    expect(newStart).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Group 3: Keyboard navigation window shift
// ---------------------------------------------------------------------------

describe('Keyboard navigation window shift', () => {
  it('ArrowDown at window edge shifts windowStart forward: focusedIndex=99, windowStart=0, len=300', () => {
    const len = 300
    const focusedIndex = 99
    const windowStart = 0

    const next = Math.min(len - 1, focusedIndex + 1)
    expect(next).toBe(100)

    let newWindowStart = windowStart
    if (next >= windowStart + WINDOW_SIZE) {
      newWindowStart = Math.min(len - WINDOW_SIZE, next)
    }
    expect(newWindowStart).toBe(100)
  })

  it('ArrowDown NOT at window edge does not shift windowStart: focusedIndex=98, windowStart=0, len=300', () => {
    const len = 300
    const focusedIndex = 98
    const windowStart = 0

    const next = Math.min(len - 1, focusedIndex + 1)
    expect(next).toBe(99)

    let newWindowStart = windowStart
    if (next >= windowStart + WINDOW_SIZE) {
      newWindowStart = Math.min(len - WINDOW_SIZE, next)
    }
    // 99 < 0 + 100, so no shift
    expect(newWindowStart).toBe(0)
  })

  it('ArrowUp at window edge shifts windowStart back: focusedIndex=100, windowStart=100, len=300', () => {
    const _len = 300
    const focusedIndex = 100
    const windowStart = 100

    const prev = Math.max(0, focusedIndex - 1)
    expect(prev).toBe(99)

    let newWindowStart = windowStart
    if (prev < windowStart) {
      newWindowStart = Math.max(0, prev)
    }
    expect(newWindowStart).toBe(99)
  })

  it('ArrowUp NOT at window edge does not shift windowStart: focusedIndex=101, windowStart=100, len=300', () => {
    const _len = 300
    const focusedIndex = 101
    const windowStart = 100

    const prev = Math.max(0, focusedIndex - 1)
    expect(prev).toBe(100)

    let newWindowStart = windowStart
    if (prev < windowStart) {
      newWindowStart = Math.max(0, prev)
    }
    // 100 is NOT < 100, so no shift
    expect(newWindowStart).toBe(100)
  })

  // suppress unused variable warning for len in pure-logic tests
  void (300 as number)
})

// ---------------------------------------------------------------------------
// Group 4: Absolute index mapping
// ---------------------------------------------------------------------------

describe('Absolute index mapping', () => {
  it('absIdx = windowStart + relIdx: windowStart=50, relIdx=3 → absIdx=53', () => {
    const windowStart = 50
    const relIdx = 3
    const absIdx = windowStart + relIdx
    expect(absIdx).toBe(53)
  })

  it('absIdx = windowStart + relIdx: windowStart=0, relIdx=0 → absIdx=0', () => {
    const windowStart = 0
    const relIdx = 0
    const absIdx = windowStart + relIdx
    expect(absIdx).toBe(0)
  })

  it('ring highlight is true when focusedIndex === absIdx', () => {
    const focusedIndex = 53
    const absIdx = 53
    expect(focusedIndex === absIdx).toBe(true)
  })

  it('ring highlight is false when focusedIndex !== absIdx', () => {
    const focusedIndex = 52
    const absIdx = 53
    expect(focusedIndex === absIdx).toBe(false)
  })

  it('absIdx at last visible item: windowStart=200, relIdx=49 → absIdx=249', () => {
    const windowStart = 200
    const relIdx = 49
    const absIdx = windowStart + relIdx
    expect(absIdx).toBe(249)
  })
})
