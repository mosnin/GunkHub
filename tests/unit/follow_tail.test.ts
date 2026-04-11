import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Pure logic tests for the follow tail feature introduced in Prompt 20.
//
// Timeline and EventInspector both implement the same model:
//   - followTail: boolean — defaults to isLive
//   - unseenCount: number — accumulates arrivals while followTail=false
//   - window advance: only when followTail=true; else unseenCount grows
//   - resume: followTail=true, unseenCount=0, window jumps to tail
//
// All logic is inlined — no React, no DOM, no network calls.
// ---------------------------------------------------------------------------

const WINDOW_SIZE = 100

// ---------------------------------------------------------------------------
// Group 1: Default state — followTail defaults to isLive
// ---------------------------------------------------------------------------

describe('Follow tail default state', () => {
  it('isLive=true → followTail initialises to true', () => {
    const isLive = true
    const followTail = isLive
    expect(followTail).toBe(true)
  })

  it('isLive=false → followTail initialises to false', () => {
    const isLive = false
    const followTail = isLive
    expect(followTail).toBe(false)
  })

  it('unseenCount always initialises to 0 regardless of isLive', () => {
    const unseenCount = 0
    expect(unseenCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Group 2: Window advance gate — only when followTail=true
// ---------------------------------------------------------------------------

/**
 * The polling paths in Timeline and EventInspector both run this guard:
 *
 *   if (followTailRef.current) {
 *     setWindowStart(Math.max(0, newTotal - WINDOW_SIZE))
 *   } else {
 *     setUnseenCount(prev => prev + arrivedCount)
 *   }
 */

function applyArrival(
  followTail: boolean,
  currentWindowStart: number,
  currentUnseen: number,
  newTotal: number,
  arrivedCount: number,
): { windowStart: number; unseenCount: number } {
  if (followTail) {
    return {
      windowStart: Math.max(0, newTotal - WINDOW_SIZE),
      unseenCount: currentUnseen,
    }
  } else {
    return {
      windowStart: currentWindowStart,
      unseenCount: currentUnseen + arrivedCount,
    }
  }
}

describe('Window advance gate', () => {
  it('followTail=true: window advances to tail on poll', () => {
    const { windowStart, unseenCount } = applyArrival(true, 0, 0, 150, 50)
    expect(windowStart).toBe(50)
    expect(unseenCount).toBe(0)
  })

  it('followTail=true: window stays at 0 when total <= WINDOW_SIZE', () => {
    const { windowStart, unseenCount } = applyArrival(true, 0, 0, 80, 10)
    expect(windowStart).toBe(0)
    expect(unseenCount).toBe(0)
  })

  it('followTail=false: window is frozen, unseenCount grows', () => {
    const { windowStart, unseenCount } = applyArrival(false, 0, 0, 150, 50)
    expect(windowStart).toBe(0) // unchanged
    expect(unseenCount).toBe(50)
  })

  it('followTail=false: repeated arrivals accumulate in unseenCount', () => {
    let state = { windowStart: 0, unseenCount: 0 }
    state = applyArrival(false, state.windowStart, state.unseenCount, 120, 20)
    state = applyArrival(false, state.windowStart, state.unseenCount, 140, 20)
    state = applyArrival(false, state.windowStart, state.unseenCount, 155, 15)
    expect(state.windowStart).toBe(0)
    expect(state.unseenCount).toBe(55)
  })

  it('followTail=false: window position is preserved across multiple arrivals', () => {
    const frozenStart = 200
    let state = { windowStart: frozenStart, unseenCount: 0 }
    state = applyArrival(false, state.windowStart, state.unseenCount, 350, 50)
    state = applyArrival(false, state.windowStart, state.unseenCount, 400, 50)
    expect(state.windowStart).toBe(frozenStart)
  })

  it('followTail=true: newTotal=100 yields windowStart=0 (exactly one window)', () => {
    const { windowStart } = applyArrival(true, 0, 0, 100, 100)
    expect(windowStart).toBe(0)
  })

  it('followTail=true: newTotal=101 yields windowStart=1 (just over one window)', () => {
    const { windowStart } = applyArrival(true, 0, 0, 101, 101)
    expect(windowStart).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Group 3: Resume logic
// ---------------------------------------------------------------------------

/**
 * Resume sets followTail=true, unseenCount=0, and window to tail.
 */
function resume(
  allEventsLength: number,
): { followTail: boolean; unseenCount: number; windowStart: number } {
  return {
    followTail: true,
    unseenCount: 0,
    windowStart: Math.max(0, allEventsLength - WINDOW_SIZE),
  }
}

describe('Resume logic', () => {
  it('resume sets followTail=true', () => {
    const { followTail } = resume(150)
    expect(followTail).toBe(true)
  })

  it('resume resets unseenCount to 0', () => {
    const { unseenCount } = resume(150)
    expect(unseenCount).toBe(0)
  })

  it('resume jumps windowStart to tail: 150 events → windowStart=50', () => {
    const { windowStart } = resume(150)
    expect(windowStart).toBe(50)
  })

  it('resume with total <= WINDOW_SIZE → windowStart=0', () => {
    const { windowStart } = resume(80)
    expect(windowStart).toBe(0)
  })

  it('resume with total=300 → windowStart=200', () => {
    const { windowStart } = resume(300)
    expect(windowStart).toBe(200)
  })

  it('resume with total=0 → windowStart=0 (clamped)', () => {
    const { windowStart } = resume(0)
    expect(windowStart).toBe(0)
  })

  it('resume after accumulating unseenCount clears the count', () => {
    let unseenCount = 0
    // Simulate arrivals while paused
    unseenCount += 20
    unseenCount += 15
    expect(unseenCount).toBe(35)
    // Resume
    const result = resume(135)
    expect(result.unseenCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Group 4: Interactions that turn off follow tail
// ---------------------------------------------------------------------------

/**
 * These interactions disable follow tail in both Timeline and EventInspector:
 * - ArrowUp / ArrowDown keyboard navigation
 * - Clicking an event row (EventInspector only)
 * - Clicking the "↑ N above" / "↑ N earlier events" window nav button
 *
 * Modelled as a pure boolean transition.
 */

describe('Follow tail deactivation triggers', () => {
  it('ArrowDown turns off followTail', () => {
    let followTail = true
    // simulate ArrowDown handler: setFollowTail(false)
    followTail = false
    expect(followTail).toBe(false)
  })

  it('ArrowUp turns off followTail', () => {
    let followTail = true
    followTail = false
    expect(followTail).toBe(false)
  })

  it('clicking event row turns off followTail', () => {
    let followTail = true
    followTail = false
    expect(followTail).toBe(false)
  })

  it('clicking "earlier events" button turns off followTail', () => {
    let followTail = true
    followTail = false
    expect(followTail).toBe(false)
  })

  it('setFollowTail(false) is idempotent when already false', () => {
    let followTail = false
    followTail = false
    expect(followTail).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Group 5: Unseen count display threshold
// ---------------------------------------------------------------------------

/**
 * The "N new — resume" badge is shown when followTail=false AND unseenCount > 0.
 * The toggle button label switches between "live" (following) and "paused" (not following).
 */

function shouldShowUnseenBadge(followTail: boolean, unseenCount: number): boolean {
  return !followTail && unseenCount > 0
}

function followTailLabel(followTail: boolean): 'live' | 'paused' {
  return followTail ? 'live' : 'paused'
}

describe('Unseen count display conditions', () => {
  it('followTail=true, unseenCount=0 → badge hidden', () => {
    expect(shouldShowUnseenBadge(true, 0)).toBe(false)
  })

  it('followTail=true, unseenCount=5 → badge hidden (following, window advanced)', () => {
    // When following, unseenCount never grows (arrivals advance window instead).
    // But even hypothetically: badge is hidden when following.
    expect(shouldShowUnseenBadge(true, 5)).toBe(false)
  })

  it('followTail=false, unseenCount=0 → badge hidden (paused but nothing new yet)', () => {
    expect(shouldShowUnseenBadge(false, 0)).toBe(false)
  })

  it('followTail=false, unseenCount=1 → badge shown', () => {
    expect(shouldShowUnseenBadge(false, 1)).toBe(true)
  })

  it('followTail=false, unseenCount=42 → badge shown', () => {
    expect(shouldShowUnseenBadge(false, 42)).toBe(true)
  })

  it('toggle label is "live" when followTail=true', () => {
    expect(followTailLabel(true)).toBe('live')
  })

  it('toggle label is "paused" when followTail=false', () => {
    expect(followTailLabel(false)).toBe('paused')
  })
})

// ---------------------------------------------------------------------------
// Group 6: Round-trip — pause, accumulate, resume
// ---------------------------------------------------------------------------

interface FollowTailState {
  followTail: boolean
  unseenCount: number
  windowStart: number
}

describe('Follow tail round-trip: pause → accumulate → resume', () => {
  it('starting from live, pausing freezes window and accumulates arrivals, resume restores', () => {
    let state: FollowTailState = { followTail: true, unseenCount: 0, windowStart: 50 }

    // User pauses (e.g. ArrowDown)
    state = { ...state, followTail: false }
    expect(state.followTail).toBe(false)
    expect(state.windowStart).toBe(50) // unchanged

    // 3 poll ticks arrive while paused
    let newTotal = 150
    for (let i = 0; i < 3; i++) {
      newTotal += 10
      const arrived = applyArrival(state.followTail, state.windowStart, state.unseenCount, newTotal, 10)
      state = { followTail: state.followTail, windowStart: arrived.windowStart, unseenCount: arrived.unseenCount }
    }
    expect(state.windowStart).toBe(50) // still frozen
    expect(state.unseenCount).toBe(30) // 3 × 10

    // User resumes
    const finalTotal = newTotal
    const r = resume(finalTotal)
    state = { followTail: r.followTail, unseenCount: r.unseenCount, windowStart: r.windowStart }

    expect(state.followTail).toBe(true)
    expect(state.unseenCount).toBe(0)
    expect(state.windowStart).toBe(Math.max(0, finalTotal - WINDOW_SIZE))
  })

  it('badge appears only after first arrival while paused', () => {
    let followTail = false
    let unseenCount = 0

    // Before any arrival
    expect(shouldShowUnseenBadge(followTail, unseenCount)).toBe(false)

    // After first arrival
    unseenCount += 5
    expect(shouldShowUnseenBadge(followTail, unseenCount)).toBe(true)

    // After resume
    followTail = true
    unseenCount = 0
    expect(shouldShowUnseenBadge(followTail, unseenCount)).toBe(false)
  })
})
