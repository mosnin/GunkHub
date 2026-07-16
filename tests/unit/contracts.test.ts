import { isTerminalStatus, RunStatusValues } from '@agent-flight-recorder/contracts'
import { describe, it, expect } from 'vitest'

describe('RunStatus', () => {
  it('includes all expected statuses', () => {
    expect(RunStatusValues).toContain('pending')
    expect(RunStatusValues).toContain('running')
    expect(RunStatusValues).toContain('completed')
    expect(RunStatusValues).toContain('failed')
    expect(RunStatusValues).toContain('cancelled')
    expect(RunStatusValues).toContain('timed_out')
  })

  it('contains exactly 6 status values', () => {
    expect(RunStatusValues).toHaveLength(6)
  })

  it('isTerminalStatus returns true for terminal statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(true)
    expect(isTerminalStatus('timed_out')).toBe(true)
  })

  it('isTerminalStatus returns false for non-terminal statuses', () => {
    expect(isTerminalStatus('pending')).toBe(false)
    expect(isTerminalStatus('running')).toBe(false)
  })

  it('terminal statuses are a subset of all statuses', () => {
    const terminalStatuses = RunStatusValues.filter(isTerminalStatus)
    expect(terminalStatuses).toHaveLength(4)
  })

  it('non-terminal statuses are a subset of all statuses', () => {
    const nonTerminal = RunStatusValues.filter(s => !isTerminalStatus(s))
    expect(nonTerminal).toHaveLength(2)
    expect(nonTerminal).toContain('pending')
    expect(nonTerminal).toContain('running')
  })
})

describe('mock fixtures shape', () => {
  it('mockRun has required fields', async () => {
    const { mockRun } = await import('../fixtures/runs.js')
    expect(mockRun).toHaveProperty('id')
    expect(mockRun).toHaveProperty('orgId')
    expect(mockRun).toHaveProperty('agentId')
    expect(mockRun).toHaveProperty('status')
    expect(mockRun).toHaveProperty('startedAt')
  })

  it('mockRun status is a valid RunStatus', async () => {
    const { mockRun } = await import('../fixtures/runs.js')
    expect(RunStatusValues).toContain(mockRun.status)
  })

  it('mockRun is in completed terminal state', async () => {
    const { mockRun } = await import('../fixtures/runs.js')
    expect(isTerminalStatus(mockRun.status)).toBe(true)
    expect(mockRun.status).toBe('completed')
  })

  it('mockRun endedAt is after startedAt', async () => {
    const { mockRun } = await import('../fixtures/runs.js')
    expect(mockRun.endedAt).toBeDefined()
    expect(mockRun.endedAt!).toBeGreaterThan(mockRun.startedAt)
  })

  it('mockRun tags is an array', async () => {
    const { mockRun } = await import('../fixtures/runs.js')
    expect(Array.isArray(mockRun.tags)).toBe(true)
    expect(mockRun.tags.length).toBeGreaterThan(0)
  })

  it('mockRun metadata is an object', async () => {
    const { mockRun } = await import('../fixtures/runs.js')
    expect(typeof mockRun.metadata).toBe('object')
    expect(mockRun.metadata).not.toBeNull()
  })

  it('mockLlmRequestEvent has correct type', async () => {
    const { mockLlmRequestEvent } = await import('../fixtures/runs.js')
    expect(mockLlmRequestEvent.type).toBe('llm.request')
    expect(mockLlmRequestEvent).toHaveProperty('sequenceNumber')
    expect(mockLlmRequestEvent).toHaveProperty('payload')
  })

  it('mockLlmRequestEvent payload contains model and messages', async () => {
    const { mockLlmRequestEvent } = await import('../fixtures/runs.js')
    const payload = mockLlmRequestEvent.payload as { model: string; messages: unknown[] }
    expect(payload.model).toBe('gpt-4o')
    expect(Array.isArray(payload.messages)).toBe(true)
    expect(payload.messages.length).toBeGreaterThan(0)
  })

  it('mockLlmResponseEvent has correct type and usage', async () => {
    const { mockLlmResponseEvent } = await import('../fixtures/runs.js')
    expect(mockLlmResponseEvent.type).toBe('llm.response')
    const payload = mockLlmResponseEvent.payload as { usage: { total_tokens: number }; finish_reason: string }
    expect(payload.usage.total_tokens).toBeGreaterThan(0)
    expect(payload.finish_reason).toBe('stop')
  })

  it('mockToolCallEvent has correct type and call_id', async () => {
    const { mockToolCallEvent } = await import('../fixtures/runs.js')
    expect(mockToolCallEvent.type).toBe('tool.call')
    const payload = mockToolCallEvent.payload as { call_id: string; name: string }
    expect(payload.call_id).toBeDefined()
    expect(payload.name).toBe('lookup_order')
  })

  it('mockRunEvents are in ascending sequenceNumber order', async () => {
    const { mockRunEvents } = await import('../fixtures/runs.js')
    for (let i = 1; i < mockRunEvents.length; i++) {
      expect(mockRunEvents[i]!.sequenceNumber).toBeGreaterThan(mockRunEvents[i - 1]!.sequenceNumber)
    }
  })

  it('mockRunEvents all share the same runId', async () => {
    const { mockRunEvents, mockRun } = await import('../fixtures/runs.js')
    for (const evt of mockRunEvents) {
      expect(evt.runId).toBe(mockRun.id)
    }
  })

  it('mockArtifact has all required storage fields', async () => {
    const { mockArtifact } = await import('../fixtures/runs.js')
    expect(mockArtifact).toHaveProperty('storageKey')
    expect(mockArtifact).toHaveProperty('storageBucket')
    expect(mockArtifact).toHaveProperty('checksum')
    expect(mockArtifact.mimeType).toBe('application/json')
  })

  it('mockComment targets the run', async () => {
    const { mockComment, mockRun } = await import('../fixtures/runs.js')
    expect(mockComment.targetType).toBe('run')
    expect(mockComment.targetId).toBe(mockRun.id)
    expect(mockComment.content.length).toBeGreaterThan(0)
  })

  it('mockFailedRun has failed terminal status', async () => {
    const { mockFailedRun } = await import('../fixtures/runs.js')
    expect(mockFailedRun.status).toBe('failed')
    expect(isTerminalStatus(mockFailedRun.status)).toBe(true)
  })

  it('mockPendingRun has non-terminal status', async () => {
    const { mockPendingRun } = await import('../fixtures/runs.js')
    expect(mockPendingRun.status).toBe('pending')
    expect(isTerminalStatus(mockPendingRun.status)).toBe(false)
  })
})
