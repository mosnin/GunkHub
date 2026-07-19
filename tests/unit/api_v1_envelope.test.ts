/**
 * Envelope-shaping tests for the public v1 read API
 * (apps/web/src/lib/apiV1Envelope.ts). Pure, no Next.js/Convex involved.
 */
import { describe, expect, it } from 'vitest'

import { API_V1_VERSION, apiV1Envelope } from '../../apps/web/src/lib/apiV1Envelope.js'

describe('apiV1Envelope', () => {
  it('wraps data with a stable apiVersion and echoes the requestId', () => {
    const data = { runs: [{ id: 'run-1' }], nextCursor: 'cur-1' }
    const envelope = apiV1Envelope(data, 'req-123')

    expect(envelope).toEqual({
      apiVersion: API_V1_VERSION,
      data,
      requestId: 'req-123',
    })
  })

  it('apiVersion is a date-versioned string, not a running integer', () => {
    // Matches the convention documented in docs/design/action_layer.md for the
    // webhook payload envelope: apiVersion changes only on a breaking shape
    // change, so it reads as a date, not v1/v2/v3.
    expect(API_V1_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('does not mutate the input data reference', () => {
    const data = { foo: 'bar' }
    const envelope = apiV1Envelope(data, 'req-1')
    expect(envelope.data).toBe(data)
  })

  it('preserves nested structure (list result shape)', () => {
    const listResult = {
      runs: [
        { id: 'run-1', status: 'completed' },
        { id: 'run-2', status: 'failed' },
      ],
      nextCursor: undefined,
    }
    const envelope = apiV1Envelope(listResult, 'req-9')
    expect(envelope.data.runs).toHaveLength(2)
    expect(envelope.data.runs[0]?.id).toBe('run-1')
  })
})
