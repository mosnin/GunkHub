import { describe, it, expect } from 'vitest'
import type {
  ListRunsResponse,
  GetRunResponse,
  ApiError,
  ListEventsResponse,
  CreateRunResponse,
  CreateCommentResponse,
} from '@agent-flight-recorder/contracts'
import {
  mockRun,
  mockFailedRun,
  mockPendingRun,
  mockLlmRequestEvent,
  mockLlmResponseEvent,
  mockToolCallEvent,
  mockToolResultEvent,
  mockRunEvents,
  mockComment,
} from '../fixtures/runs.js'

describe('API response shapes', () => {
  it('ListRunsResponse has correct shape', () => {
    const response: ListRunsResponse = {
      runs: [mockRun],
      total: 1,
    }
    expect(response.runs).toHaveLength(1)
    expect(response.total).toBe(1)
    expect(response.runs[0]!.id).toBe(mockRun.id)
  })

  it('GetRunResponse has correct shape', () => {
    const response: GetRunResponse = {
      run: mockRun,
      eventCount: 3,
      artifactCount: 1,
    }
    expect(response.run.status).toBe('completed')
    expect(response.eventCount).toBe(3)
  })

  it('ApiError has code and message', () => {
    const err: ApiError = { code: 'NOT_FOUND', message: 'Run not found' }
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBeTruthy()
  })

  it('ListRunsResponse supports pagination cursor', () => {
    const response: ListRunsResponse = {
      runs: [],
      total: 0,
      nextCursor: 'cursor_abc',
    }
    expect(response.nextCursor).toBe('cursor_abc')
  })

  it('ListRunsResponse without cursor has undefined nextCursor', () => {
    const response: ListRunsResponse = {
      runs: [mockRun],
      total: 1,
    }
    expect(response.nextCursor).toBeUndefined()
  })

  it('ListRunsResponse supports multiple runs', () => {
    const response: ListRunsResponse = {
      runs: [mockRun, mockFailedRun, mockPendingRun],
      total: 3,
    }
    expect(response.runs).toHaveLength(3)
    expect(response.total).toBe(3)
    expect(response.runs.map(r => r.status)).toEqual(['completed', 'failed', 'pending'])
  })

  it('GetRunResponse with zero events and artifacts', () => {
    const response: GetRunResponse = {
      run: mockPendingRun,
      eventCount: 0,
      artifactCount: 0,
    }
    expect(response.eventCount).toBe(0)
    expect(response.artifactCount).toBe(0)
    expect(response.run.status).toBe('pending')
  })

  it('ApiError can carry optional details', () => {
    const err: ApiError = {
      code: 'VALIDATION_ERROR',
      message: 'Invalid input',
      details: { field: 'agentId', issue: 'required' },
    }
    expect(err.details).toBeDefined()
    expect((err.details as { field: string }).field).toBe('agentId')
  })

  it('ApiError without details has no details field', () => {
    const err: ApiError = { code: 'INTERNAL_ERROR', message: 'Unexpected server error' }
    expect(err.details).toBeUndefined()
  })

  it('ListEventsResponse has correct shape', () => {
    const response: ListEventsResponse = {
      events: [mockLlmRequestEvent, mockLlmResponseEvent],
    }
    expect(response.events).toHaveLength(2)
    expect(response.events[0]!.type).toBe('llm.request')
    expect(response.events[1]!.type).toBe('llm.response')
  })

  it('ListEventsResponse supports pagination cursor', () => {
    const response: ListEventsResponse = {
      events: [],
      nextCursor: 'evt_cursor_xyz',
    }
    expect(response.nextCursor).toBe('evt_cursor_xyz')
  })

  it('CreateRunResponse has a run with expected fields', () => {
    const response: CreateRunResponse = {
      run: mockRun,
    }
    expect(response.run.id).toBe(mockRun.id)
    expect(response.run.orgId).toBe(mockRun.orgId)
    expect(response.run.agentId).toBe(mockRun.agentId)
    expect(response.run.status).toBe('completed')
  })

  it('CreateCommentResponse has a comment with expected fields', () => {
    const response: CreateCommentResponse = {
      comment: mockComment,
    }
    expect(response.comment.targetType).toBe('run')
    expect(response.comment.content.length).toBeGreaterThan(0)
    expect(response.comment.authorId).toBeDefined()
  })

  it('event sequence numbers are consistent with fixture order', () => {
    const response: ListEventsResponse = {
      events: mockRunEvents,
    }
    const seqNumbers = response.events.map(e => e.sequenceNumber)
    const sorted = [...seqNumbers].sort((a, b) => a - b)
    expect(seqNumbers).toEqual(sorted)
  })

  it('tool call and result events share the same call_id', () => {
    const callPayload = mockToolCallEvent.payload as { call_id: string }
    const resultPayload = mockToolResultEvent.payload as { call_id: string }
    expect(callPayload.call_id).toBe(resultPayload.call_id)
  })

  it('GetRunResponse eventCount matches fixture event list length', () => {
    const response: GetRunResponse = {
      run: mockRun,
      eventCount: mockRunEvents.length,
      artifactCount: 1,
    }
    expect(response.eventCount).toBe(mockRunEvents.length)
  })
})
