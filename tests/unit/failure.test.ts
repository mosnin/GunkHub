import { describe, it, expect } from 'vitest'
import { buildFailureSummary } from '../../apps/web/src/lib/replay/failure.js'
import {
  successfulRun,
  successfulRunEvents,
  failedToolRun,
  failedToolRunEvents,
  failedLlmRun,
  failedLlmRunEvents,
  partialRun,
  partialRunEvents,
} from '../fixtures/events.js'
import type { Event, Run } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Test 1: Successful run
// ---------------------------------------------------------------------------

describe('buildFailureSummary — successful run', () => {
  it('hasFailure is false', () => {
    const result = buildFailureSummary(successfulRun, successfulRunEvents)
    expect(result.hasFailure).toBe(false)
  })

  it('primaryFailure is null', () => {
    const result = buildFailureSummary(successfulRun, successfulRunEvents)
    expect(result.primaryFailure).toBeNull()
  })

  it('allFailurePoints is empty', () => {
    const result = buildFailureSummary(successfulRun, successfulRunEvents)
    expect(result.allFailurePoints).toEqual([])
  })

  it('isIncomplete is false', () => {
    const result = buildFailureSummary(successfulRun, successfulRunEvents)
    expect(result.isIncomplete).toBe(false)
  })

  it('cannotInfer is false', () => {
    const result = buildFailureSummary(successfulRun, successfulRunEvents)
    expect(result.cannotInfer).toBe(false)
  })

  it('runId matches the run', () => {
    const result = buildFailureSummary(successfulRun, successfulRunEvents)
    expect(result.runId).toBe(successfulRun.id)
  })

  it('runStatus is completed', () => {
    const result = buildFailureSummary(successfulRun, successfulRunEvents)
    expect(result.runStatus).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Test 2: Failed tool run
// ---------------------------------------------------------------------------

describe('buildFailureSummary — failed tool run', () => {
  it('hasFailure is true', () => {
    const result = buildFailureSummary(failedToolRun, failedToolRunEvents)
    expect(result.hasFailure).toBe(true)
  })

  it('primaryFailure is not null', () => {
    const result = buildFailureSummary(failedToolRun, failedToolRunEvents)
    expect(result.primaryFailure).not.toBeNull()
  })

  it('primaryFailure references the tool.error event', () => {
    const result = buildFailureSummary(failedToolRun, failedToolRunEvents)
    expect(result.primaryFailure!.type).toBe('tool.error')
  })

  it('primaryFailure has reason "failed_tool"', () => {
    const result = buildFailureSummary(failedToolRun, failedToolRunEvents)
    expect(result.primaryFailure!.reason).toBe('failed_tool')
  })

  it('allFailurePoints contains tool.error and run.failed', () => {
    const result = buildFailureSummary(failedToolRun, failedToolRunEvents)
    const types = result.allFailurePoints.map(p => p.type)
    expect(types).toContain('tool.error')
    expect(types).toContain('run.failed')
  })

  it('allFailurePoints has at least 2 entries (tool.error + run.failed)', () => {
    const result = buildFailureSummary(failedToolRun, failedToolRunEvents)
    expect(result.allFailurePoints.length).toBeGreaterThanOrEqual(2)
  })

  it('cannotInfer is false (failure is clearly identified)', () => {
    const result = buildFailureSummary(failedToolRun, failedToolRunEvents)
    expect(result.cannotInfer).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 3: Failed LLM run
// ---------------------------------------------------------------------------

describe('buildFailureSummary — failed LLM run', () => {
  it('hasFailure is true', () => {
    const result = buildFailureSummary(failedLlmRun, failedLlmRunEvents)
    expect(result.hasFailure).toBe(true)
  })

  it('primaryFailure has reason "failed_llm"', () => {
    const result = buildFailureSummary(failedLlmRun, failedLlmRunEvents)
    expect(result.primaryFailure!.reason).toBe('failed_llm')
  })

  it('primaryFailure references the llm.error event', () => {
    const result = buildFailureSummary(failedLlmRun, failedLlmRunEvents)
    expect(result.primaryFailure!.type).toBe('llm.error')
  })

  it('allFailurePoints contains llm.error', () => {
    const result = buildFailureSummary(failedLlmRun, failedLlmRunEvents)
    const types = result.allFailurePoints.map(p => p.type)
    expect(types).toContain('llm.error')
  })

  it('runStatus is failed', () => {
    const result = buildFailureSummary(failedLlmRun, failedLlmRunEvents)
    expect(result.runStatus).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Test 4: run.failed with no error events — cannotInfer
// ---------------------------------------------------------------------------

describe('buildFailureSummary — run.failed with no detailed error events', () => {
  it('cannotInfer is true when only run.failed is present and its payload has no error message', () => {
    // A run that is status=failed but has only run.started and run.failed without a clear error event
    const run = makeRun({ status: 'failed', id: 'run-no-detail' })
    const events: Event[] = []
    const result = buildFailureSummary(run, events)
    expect(result.cannotInfer).toBe(true)
  })

  it('hasFailure is true when run.status is "failed" even with empty events', () => {
    const run = makeRun({ status: 'failed' })
    const result = buildFailureSummary(run, [])
    expect(result.hasFailure).toBe(true)
  })

  it('primaryFailure is null when no events exist', () => {
    const run = makeRun({ status: 'failed' })
    const result = buildFailureSummary(run, [])
    expect(result.primaryFailure).toBeNull()
  })

  it('run.failed event with no extractable error message — cannotInfer depends on other failure events', () => {
    // A run.failed-only scenario: run status is "failed", only event is run.failed
    const run = makeRun({ status: 'failed', id: 'run-bare-fail' })
    const events: Event[] = [
      makeEvent({
        id: 'evt-rf',
        type: 'run.failed',
        sequenceNumber: 1,
        payload: { type: 'run.failed', error: { message: 'Unknown error' }, duration_ms: 1000 },
      }),
    ]
    const result = buildFailureSummary(run, events)
    // run.failed is in allFailurePoints, so cannotInfer should be false
    // (there IS a failure point, even if reason is only "run_failed")
    expect(result.allFailurePoints.length).toBeGreaterThan(0)
    expect(result.cannotInfer).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 5: Partial run
// ---------------------------------------------------------------------------

describe('buildFailureSummary — partial run', () => {
  it('isIncomplete is true for a running run', () => {
    const result = buildFailureSummary(partialRun, partialRunEvents)
    expect(result.isIncomplete).toBe(true)
  })

  it('hasFailure is false for a partial run with no error events', () => {
    const result = buildFailureSummary(partialRun, partialRunEvents)
    expect(result.hasFailure).toBe(false)
  })

  it('primaryFailure is null for a partial run with no error events', () => {
    const result = buildFailureSummary(partialRun, partialRunEvents)
    expect(result.primaryFailure).toBeNull()
  })

  it('cannotInfer is false for a running run (it is not in a failed state)', () => {
    const result = buildFailureSummary(partialRun, partialRunEvents)
    expect(result.cannotInfer).toBe(false)
  })

  it('isIncomplete is true for a pending run', () => {
    const run = makeRun({ status: 'pending' })
    const result = buildFailureSummary(run, [])
    expect(result.isIncomplete).toBe(true)
  })

  it('isIncomplete is false for a completed run', () => {
    const result = buildFailureSummary(successfulRun, successfulRunEvents)
    expect(result.isIncomplete).toBe(false)
  })

  it('isIncomplete is false for a failed run', () => {
    const result = buildFailureSummary(failedToolRun, failedToolRunEvents)
    expect(result.isIncomplete).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 6: Multiple failures — allFailurePoints collects all, primary is first
// ---------------------------------------------------------------------------

describe('buildFailureSummary — multiple failures', () => {
  it('allFailurePoints contains all failure events', () => {
    // A run with both an llm.error and a tool.error
    const run = makeRun({ status: 'failed', id: 'run-multi-fail' })
    const events: Event[] = [
      makeEvent({ id: 'evt-a', type: 'llm.request', sequenceNumber: 1, payload: { type: 'llm.request', model: 'gpt-4o', messages: [] } }),
      makeEvent({ id: 'evt-b', type: 'llm.error', sequenceNumber: 2, payload: { type: 'llm.error', error: { message: 'Rate limited' } } }),
      makeEvent({ id: 'evt-c', type: 'tool.call', sequenceNumber: 3, payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' } }),
      makeEvent({ id: 'evt-d', type: 'tool.error', sequenceNumber: 4, payload: { type: 'tool.error', error: { message: 'Timeout' } } }),
      makeEvent({ id: 'evt-e', type: 'run.failed', sequenceNumber: 5, payload: { type: 'run.failed', error: { message: 'Multiple errors' }, duration_ms: 5000 } }),
    ]
    const result = buildFailureSummary(run, events)
    const types = result.allFailurePoints.map(p => p.type)
    expect(types).toContain('llm.error')
    expect(types).toContain('tool.error')
    expect(types).toContain('run.failed')
    expect(result.allFailurePoints.length).toBe(3)
  })

  it('primaryFailure is the first failure point by sequenceNumber', () => {
    const run = makeRun({ status: 'failed', id: 'run-multi-fail' })
    const events: Event[] = [
      makeEvent({ id: 'evt-a', type: 'llm.error', sequenceNumber: 2, payload: { type: 'llm.error', error: { message: 'Rate limited' } } }),
      makeEvent({ id: 'evt-b', type: 'tool.error', sequenceNumber: 4, payload: { type: 'tool.error', error: { message: 'Timeout' } } }),
      makeEvent({ id: 'evt-c', type: 'run.failed', sequenceNumber: 5, payload: { type: 'run.failed', error: { message: 'Failed' }, duration_ms: 5000 } }),
    ]
    const result = buildFailureSummary(run, events)
    // Primary should be llm.error (sequenceNumber=2, which comes first)
    expect(result.primaryFailure!.type).toBe('llm.error')
    expect(result.primaryFailure!.sequenceNumber).toBe(2)
  })

  it('allFailurePoints are in ascending sequenceNumber order', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({ id: 'evt-a', type: 'llm.error', sequenceNumber: 2, payload: { type: 'llm.error', error: { message: 'Error A' } } }),
      makeEvent({ id: 'evt-b', type: 'tool.error', sequenceNumber: 4, payload: { type: 'tool.error', error: { message: 'Error B' } } }),
    ]
    const result = buildFailureSummary(run, events)
    for (let i = 1; i < result.allFailurePoints.length; i++) {
      expect(result.allFailurePoints[i]!.sequenceNumber).toBeGreaterThan(
        result.allFailurePoints[i - 1]!.sequenceNumber
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Test 7: Error message extraction
// ---------------------------------------------------------------------------

describe('buildFailureSummary — error message extraction', () => {
  it('extracts errorMessage from payload.error.message', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({
        id: 'evt-err',
        type: 'tool.error',
        sequenceNumber: 1,
        payload: { type: 'tool.error', error: { message: 'Connection refused', code: 'ECONNREFUSED' } },
      }),
    ]
    const result = buildFailureSummary(run, events)
    expect(result.primaryFailure!.errorMessage).toBe('Connection refused')
  })

  it('errorMessage is included in allFailurePoints entry', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({
        id: 'evt-err',
        type: 'llm.error',
        sequenceNumber: 1,
        payload: { type: 'llm.error', error: { message: 'Model overloaded', code: 'OVERLOAD' } },
      }),
    ]
    const result = buildFailureSummary(run, events)
    expect(result.allFailurePoints[0]!.errorMessage).toBe('Model overloaded')
  })

  it('parentEventId is included in failure point when event has a parent', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({ id: 'evt-parent', type: 'tool.call', sequenceNumber: 1, payload: { type: 'tool.call', name: 'search', input: {}, call_id: 'c1' } }),
      makeEvent({
        id: 'evt-child',
        type: 'tool.error',
        sequenceNumber: 2,
        parentEventId: 'evt-parent',
        payload: { type: 'tool.error', error: { message: 'Not found' } },
      }),
    ]
    const result = buildFailureSummary(run, events)
    expect(result.primaryFailure!.parentEventId).toBe('evt-parent')
  })
})

// ---------------------------------------------------------------------------
// Test 8: Missing error message — no crash
// ---------------------------------------------------------------------------

describe('buildFailureSummary — missing error message', () => {
  it('errorMessage is undefined when payload has no error.message', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({
        id: 'evt-bare',
        type: 'tool.error',
        sequenceNumber: 1,
        // payload.error exists but has no message field
        payload: { type: 'tool.error', error: {} as { message: string } },
      }),
    ]
    const result = buildFailureSummary(run, events)
    expect(result.primaryFailure!.errorMessage).toBeUndefined()
  })

  it('does not throw when payload is missing all error information', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({
        id: 'evt-empty-err',
        type: 'tool.error',
        sequenceNumber: 1,
        payload: { type: 'tool.error', error: {} as { message: string } },
      }),
    ]
    expect(() => buildFailureSummary(run, events)).not.toThrow()
  })

  it('returns well-formed FailureSummary even when no messages are extractable', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({
        id: 'evt-no-msg',
        type: 'tool.error',
        sequenceNumber: 1,
        payload: { type: 'tool.error', error: {} as { message: string } },
      }),
    ]
    const result = buildFailureSummary(run, events)
    expect(result).toHaveProperty('hasFailure')
    expect(result).toHaveProperty('primaryFailure')
    expect(result).toHaveProperty('allFailurePoints')
    expect(result).toHaveProperty('isIncomplete')
    expect(result).toHaveProperty('cannotInfer')
  })
})

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe('buildFailureSummary — edge cases', () => {
  it('handles empty events array for a completed run gracefully', () => {
    const run = makeRun({ status: 'completed' })
    expect(() => buildFailureSummary(run, [])).not.toThrow()
  })

  it('handles events in arbitrary order — still finds correct primary failure', () => {
    const run = makeRun({ status: 'failed' })
    // Events provided in reverse sequenceNumber order
    const events: Event[] = [
      makeEvent({ id: 'evt-3', type: 'run.failed', sequenceNumber: 3, payload: { type: 'run.failed', error: { message: 'Failed' }, duration_ms: 100 } }),
      makeEvent({ id: 'evt-1', type: 'llm.error', sequenceNumber: 1, payload: { type: 'llm.error', error: { message: 'First error' } } }),
      makeEvent({ id: 'evt-2', type: 'tool.error', sequenceNumber: 2, payload: { type: 'tool.error', error: { message: 'Second error' } } }),
    ]
    const result = buildFailureSummary(run, events)
    // Primary should be the first by sequenceNumber (llm.error at seq=1)
    expect(result.primaryFailure!.sequenceNumber).toBe(1)
    expect(result.primaryFailure!.type).toBe('llm.error')
  })

  it('sequenceNumber is preserved in allFailurePoints', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({ id: 'evt-x', type: 'tool.error', sequenceNumber: 7, payload: { type: 'tool.error', error: { message: 'error at seq 7' } } }),
    ]
    const result = buildFailureSummary(run, events)
    expect(result.allFailurePoints[0]!.sequenceNumber).toBe(7)
  })

  it('eventId in failure point matches the event id', () => {
    const run = makeRun({ status: 'failed' })
    const events: Event[] = [
      makeEvent({ id: 'evt-specific-id', type: 'tool.error', sequenceNumber: 1, payload: { type: 'tool.error', error: { message: 'err' } } }),
    ]
    const result = buildFailureSummary(run, events)
    expect(result.primaryFailure!.eventId).toBe('evt-specific-id')
  })
})
