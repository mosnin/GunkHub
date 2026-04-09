/**
 * Scenario fixtures for replay, failure, and diff algorithm tests.
 *
 * All events use deterministic IDs, timestamps 1 second apart from a base of
 * 1_000_000_000_000 ms, and realistic payloads matching the EventPayload shapes
 * defined in packages/contracts/src/events.ts.
 */

import type { Event, Run } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const ORG_ID = 'org-test-001'
const PROJECT_ID = 'proj-001'
const AGENT_ID = 'agent-001'
const BASE_TS = 1_000_000_000_000

/** Returns a timestamp for the nth event (1-indexed), 1 second after the base. */
function ts(sequenceNumber: number): number {
  return BASE_TS + sequenceNumber * 1000
}

// ---------------------------------------------------------------------------
// Scenario 1 — Successful run
// llm.request → llm.response → tool.call → tool.result → run.completed
// ---------------------------------------------------------------------------

export const successfulRun: Run = {
  id: 'run-001',
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  status: 'completed',
  startedAt: BASE_TS,
  endedAt: BASE_TS + 5000,
  metadata: {},
  tags: [],
}

export const successfulRunEvents: Event[] = [
  {
    id: 'evt-001',
    runId: 'run-001',
    orgId: ORG_ID,
    type: 'run.started',
    sequenceNumber: 1,
    timestamp: ts(1),
    payload: {
      type: 'run.started',
      input: { query: 'What is the weather in London?' },
      config: { model: 'gpt-4o' },
    },
  },
  {
    id: 'evt-002',
    runId: 'run-001',
    orgId: ORG_ID,
    type: 'llm.request',
    sequenceNumber: 2,
    timestamp: ts(2),
    payload: {
      type: 'llm.request',
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the weather in London?' },
      ],
      temperature: 0.2,
      max_tokens: 512,
    },
  },
  {
    id: 'evt-003',
    runId: 'run-001',
    orgId: ORG_ID,
    type: 'llm.response',
    sequenceNumber: 3,
    timestamp: ts(3),
    payload: {
      type: 'llm.response',
      model: 'gpt-4o',
      content: "I'll check the weather for you.",
      usage: { prompt_tokens: 45, completion_tokens: 10, total_tokens: 55 },
      finish_reason: 'stop',
    },
  },
  {
    id: 'evt-004',
    runId: 'run-001',
    orgId: ORG_ID,
    type: 'tool.call',
    sequenceNumber: 4,
    timestamp: ts(4),
    parentEventId: 'evt-003',
    payload: {
      type: 'tool.call',
      name: 'get_weather',
      input: { city: 'London', units: 'celsius' },
      call_id: 'call-001',
    },
  },
  {
    id: 'evt-005',
    runId: 'run-001',
    orgId: ORG_ID,
    type: 'tool.result',
    sequenceNumber: 5,
    timestamp: ts(5),
    parentEventId: 'evt-004',
    payload: {
      type: 'tool.result',
      call_id: 'call-001',
      output: { temperature: 14, condition: 'cloudy', humidity: 72 },
      duration_ms: 243,
    },
  },
  {
    id: 'evt-006',
    runId: 'run-001',
    orgId: ORG_ID,
    type: 'run.completed',
    sequenceNumber: 6,
    timestamp: ts(6),
    payload: {
      type: 'run.completed',
      output: { answer: 'The weather in London is 14°C and cloudy.' },
      duration_ms: 5000,
    },
  },
]

// ---------------------------------------------------------------------------
// Scenario 2 — Failed tool call
// run.started → tool.call → tool.error → run.failed
// ---------------------------------------------------------------------------

export const failedToolRun: Run = {
  id: 'run-002',
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  status: 'failed',
  startedAt: BASE_TS,
  endedAt: BASE_TS + 4000,
  metadata: {},
  tags: [],
}

export const failedToolRunEvents: Event[] = [
  {
    id: 'evt-011',
    runId: 'run-002',
    orgId: ORG_ID,
    type: 'run.started',
    sequenceNumber: 1,
    timestamp: ts(1),
    payload: {
      type: 'run.started',
      input: { action: 'delete_record', id: '42' },
      config: {},
    },
  },
  {
    id: 'evt-012',
    runId: 'run-002',
    orgId: ORG_ID,
    type: 'tool.call',
    sequenceNumber: 2,
    timestamp: ts(2),
    payload: {
      type: 'tool.call',
      name: 'delete_record',
      input: { id: '42' },
      call_id: 'call-002',
    },
  },
  {
    id: 'evt-013',
    runId: 'run-002',
    orgId: ORG_ID,
    type: 'tool.error',
    sequenceNumber: 3,
    timestamp: ts(3),
    parentEventId: 'evt-012',
    payload: {
      type: 'tool.error',
      error: {
        message: 'Record not found: id=42',
        code: 'NOT_FOUND',
      },
      call_id: 'call-002',
    },
  },
  {
    id: 'evt-014',
    runId: 'run-002',
    orgId: ORG_ID,
    type: 'run.failed',
    sequenceNumber: 4,
    timestamp: ts(4),
    payload: {
      type: 'run.failed',
      error: {
        message: 'Tool execution failed: delete_record',
        code: 'TOOL_FAILURE',
      },
      duration_ms: 4000,
    },
  },
]

// ---------------------------------------------------------------------------
// Scenario 3 — Failed LLM call
// run.started → llm.request → llm.error → run.failed
// ---------------------------------------------------------------------------

export const failedLlmRun: Run = {
  id: 'run-003',
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  status: 'failed',
  startedAt: BASE_TS,
  endedAt: BASE_TS + 3000,
  metadata: {},
  tags: [],
}

export const failedLlmRunEvents: Event[] = [
  {
    id: 'evt-021',
    runId: 'run-003',
    orgId: ORG_ID,
    type: 'run.started',
    sequenceNumber: 1,
    timestamp: ts(1),
    payload: {
      type: 'run.started',
      input: { prompt: 'Summarize this very long document.' },
      config: {},
    },
  },
  {
    id: 'evt-022',
    runId: 'run-003',
    orgId: ORG_ID,
    type: 'llm.request',
    sequenceNumber: 2,
    timestamp: ts(2),
    payload: {
      type: 'llm.request',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Summarize this very long document.' }],
      max_tokens: 4096,
    },
  },
  {
    id: 'evt-023',
    runId: 'run-003',
    orgId: ORG_ID,
    type: 'llm.error',
    sequenceNumber: 3,
    timestamp: ts(3),
    parentEventId: 'evt-022',
    payload: {
      type: 'llm.error',
      error: {
        message: 'Rate limit exceeded',
        code: 'RATE_LIMIT_EXCEEDED',
      },
    },
  },
  {
    id: 'evt-024',
    runId: 'run-003',
    orgId: ORG_ID,
    type: 'run.failed',
    sequenceNumber: 4,
    timestamp: ts(4),
    payload: {
      type: 'run.failed',
      error: {
        message: 'LLM call failed: rate limit exceeded',
        code: 'LLM_FAILURE',
      },
      duration_ms: 3000,
    },
  },
]

// ---------------------------------------------------------------------------
// Scenario 4 — Partial / interrupted run
// run.started → llm.request → (no terminal event)
// ---------------------------------------------------------------------------

export const partialRun: Run = {
  id: 'run-004',
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  status: 'running',
  startedAt: BASE_TS,
  metadata: {},
  tags: [],
}

export const partialRunEvents: Event[] = [
  {
    id: 'evt-031',
    runId: 'run-004',
    orgId: ORG_ID,
    type: 'run.started',
    sequenceNumber: 1,
    timestamp: ts(1),
    payload: {
      type: 'run.started',
      input: { task: 'Generate report' },
      config: {},
    },
  },
  {
    id: 'evt-032',
    runId: 'run-004',
    orgId: ORG_ID,
    type: 'llm.request',
    sequenceNumber: 2,
    timestamp: ts(2),
    payload: {
      type: 'llm.request',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Generate a quarterly report.' }],
    },
  },
]

// ---------------------------------------------------------------------------
// Scenario 5 — Nested events (parentEventId chain)
// run.started → llm.request → llm.response
//                            ↳ tool.call (parent=llm.response)
//                              ↳ http.request (parent=tool.call)
//                              ↳ http.response (parent=tool.call)
//                              ↳ tool.result (parent=tool.call)
// → run.completed
// ---------------------------------------------------------------------------

export const nestedRun: Run = {
  id: 'run-005',
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  status: 'completed',
  startedAt: BASE_TS,
  endedAt: BASE_TS + 8000,
  metadata: {},
  tags: [],
}

export const nestedRunEvents: Event[] = [
  {
    id: 'evt-041',
    runId: 'run-005',
    orgId: ORG_ID,
    type: 'run.started',
    sequenceNumber: 1,
    timestamp: ts(1),
    payload: {
      type: 'run.started',
      input: { query: 'Book a flight to Paris' },
      config: {},
    },
  },
  {
    id: 'evt-042',
    runId: 'run-005',
    orgId: ORG_ID,
    type: 'llm.request',
    sequenceNumber: 2,
    timestamp: ts(2),
    payload: {
      type: 'llm.request',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Book a flight to Paris' }],
    },
  },
  {
    id: 'evt-043',
    runId: 'run-005',
    orgId: ORG_ID,
    type: 'llm.response',
    sequenceNumber: 3,
    timestamp: ts(3),
    parentEventId: 'evt-042',
    payload: {
      type: 'llm.response',
      model: 'gpt-4o',
      content: "I'll search for available flights.",
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      finish_reason: 'tool_calls',
    },
  },
  {
    id: 'evt-044',
    runId: 'run-005',
    orgId: ORG_ID,
    type: 'tool.call',
    sequenceNumber: 4,
    timestamp: ts(4),
    // depth=1: parent is llm.response (evt-043)
    parentEventId: 'evt-043',
    payload: {
      type: 'tool.call',
      name: 'search_flights',
      input: { origin: 'LHR', destination: 'CDG', date: '2026-05-01' },
      call_id: 'call-005',
    },
  },
  {
    id: 'evt-045',
    runId: 'run-005',
    orgId: ORG_ID,
    type: 'http.request',
    sequenceNumber: 5,
    timestamp: ts(5),
    // depth=2: parent is tool.call (evt-044)
    parentEventId: 'evt-044',
    payload: {
      type: 'http.request',
      method: 'GET',
      url: 'https://flights-api.example.com/search',
      headers_redacted: ['Authorization'],
    },
  },
  {
    id: 'evt-046',
    runId: 'run-005',
    orgId: ORG_ID,
    type: 'http.response',
    sequenceNumber: 6,
    timestamp: ts(6),
    // depth=2: parent is tool.call (evt-044)
    parentEventId: 'evt-044',
    payload: {
      type: 'http.response',
      status: 200,
      headers_redacted: ['Content-Type'],
      body_size: 1200,
      duration_ms: 310,
    },
  },
  {
    id: 'evt-047',
    runId: 'run-005',
    orgId: ORG_ID,
    type: 'tool.result',
    sequenceNumber: 7,
    timestamp: ts(7),
    // depth=2: parent is tool.call (evt-044)
    parentEventId: 'evt-044',
    payload: {
      type: 'tool.result',
      call_id: 'call-005',
      output: { flights: [{ id: 'BA123', price: 189 }] },
      duration_ms: 320,
    },
  },
  {
    id: 'evt-048',
    runId: 'run-005',
    orgId: ORG_ID,
    type: 'run.completed',
    sequenceNumber: 8,
    timestamp: ts(8),
    payload: {
      type: 'run.completed',
      output: { booked: true, flightId: 'BA123' },
      duration_ms: 8000,
    },
  },
]

// ---------------------------------------------------------------------------
// Scenario 6 — Two similar runs with one divergence (for diff testing)
//
// Run A: run.started → llm.request → llm.response → tool.call → tool.result → run.completed
// Run B: identical structure but tool.error instead of tool.result at position 5,
//        and run.failed instead of run.completed at position 6.
// ---------------------------------------------------------------------------

export const runARef: Run = {
  id: 'run-006a',
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  status: 'completed',
  startedAt: BASE_TS,
  endedAt: BASE_TS + 6000,
  metadata: {},
  tags: [],
}

export const runBRef: Run = {
  id: 'run-006b',
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  status: 'failed',
  startedAt: BASE_TS,
  endedAt: BASE_TS + 6000,
  metadata: {},
  tags: [],
}

export const runAEvents: Event[] = [
  {
    id: 'evt-051',
    runId: 'run-006a',
    orgId: ORG_ID,
    type: 'run.started',
    sequenceNumber: 1,
    timestamp: ts(1),
    payload: {
      type: 'run.started',
      input: { task: 'Fetch user profile' },
      config: {},
    },
  },
  {
    id: 'evt-052',
    runId: 'run-006a',
    orgId: ORG_ID,
    type: 'llm.request',
    sequenceNumber: 2,
    timestamp: ts(2),
    payload: {
      type: 'llm.request',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Fetch user profile for id=99' }],
    },
  },
  {
    id: 'evt-053',
    runId: 'run-006a',
    orgId: ORG_ID,
    type: 'llm.response',
    sequenceNumber: 3,
    timestamp: ts(3),
    payload: {
      type: 'llm.response',
      model: 'gpt-4o',
      content: "I'll fetch the user profile now.",
      usage: { prompt_tokens: 22, completion_tokens: 9, total_tokens: 31 },
      finish_reason: 'tool_calls',
    },
  },
  {
    id: 'evt-054',
    runId: 'run-006a',
    orgId: ORG_ID,
    type: 'tool.call',
    sequenceNumber: 4,
    timestamp: ts(4),
    payload: {
      type: 'tool.call',
      name: 'get_user_profile',
      input: { user_id: '99' },
      call_id: 'call-006a',
    },
  },
  // Position 5: success case — tool.result
  {
    id: 'evt-055',
    runId: 'run-006a',
    orgId: ORG_ID,
    type: 'tool.result',
    sequenceNumber: 5,
    timestamp: ts(5),
    parentEventId: 'evt-054',
    payload: {
      type: 'tool.result',
      call_id: 'call-006a',
      output: { id: '99', name: 'Alice', email: 'alice@example.com' },
      duration_ms: 88,
    },
  },
  // Position 6: success case — run.completed
  {
    id: 'evt-056',
    runId: 'run-006a',
    orgId: ORG_ID,
    type: 'run.completed',
    sequenceNumber: 6,
    timestamp: ts(6),
    payload: {
      type: 'run.completed',
      output: { profile: { id: '99', name: 'Alice' } },
      duration_ms: 5000,
    },
  },
]

export const runBEvents: Event[] = [
  {
    id: 'evt-061',
    runId: 'run-006b',
    orgId: ORG_ID,
    type: 'run.started',
    sequenceNumber: 1,
    timestamp: ts(1),
    payload: {
      type: 'run.started',
      input: { task: 'Fetch user profile' },
      config: {},
    },
  },
  {
    id: 'evt-062',
    runId: 'run-006b',
    orgId: ORG_ID,
    type: 'llm.request',
    sequenceNumber: 2,
    timestamp: ts(2),
    payload: {
      type: 'llm.request',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Fetch user profile for id=99' }],
    },
  },
  {
    id: 'evt-063',
    runId: 'run-006b',
    orgId: ORG_ID,
    type: 'llm.response',
    sequenceNumber: 3,
    timestamp: ts(3),
    payload: {
      type: 'llm.response',
      model: 'gpt-4o',
      content: "I'll fetch the user profile now.",
      usage: { prompt_tokens: 22, completion_tokens: 9, total_tokens: 31 },
      finish_reason: 'tool_calls',
    },
  },
  {
    id: 'evt-064',
    runId: 'run-006b',
    orgId: ORG_ID,
    type: 'tool.call',
    sequenceNumber: 4,
    timestamp: ts(4),
    payload: {
      type: 'tool.call',
      name: 'get_user_profile',
      input: { user_id: '99' },
      call_id: 'call-006b',
    },
  },
  // Position 5: failure case — tool.error (divergence point)
  {
    id: 'evt-065',
    runId: 'run-006b',
    orgId: ORG_ID,
    type: 'tool.error',
    sequenceNumber: 5,
    timestamp: ts(5),
    parentEventId: 'evt-064',
    payload: {
      type: 'tool.error',
      error: {
        message: 'User not found: id=99',
        code: 'NOT_FOUND',
      },
      call_id: 'call-006b',
    },
  },
  // Position 6: failure case — run.failed (divergence continues)
  {
    id: 'evt-066',
    runId: 'run-006b',
    orgId: ORG_ID,
    type: 'run.failed',
    sequenceNumber: 6,
    timestamp: ts(6),
    payload: {
      type: 'run.failed',
      error: {
        message: 'Tool get_user_profile failed',
        code: 'TOOL_FAILURE',
      },
      duration_ms: 5000,
    },
  },
]
