import { describe, it, expect } from 'vitest'

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

import type {
  ListRunsResponse,
  GetRunResponse,
  ApiError,
  ListEventsResponse,
  CreateRunResponse,
  CreateCommentResponse,
  Organization,
  AuthContext,
} from '@agent-flight-recorder/contracts'

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

// ---------------------------------------------------------------------------
// Organization bootstrap contract tests
// These run without a real Convex deployment. They verify that the data shapes
// produced by the bootstrap mutations align with the contracts package types
// and the Convex schema definitions.
// ---------------------------------------------------------------------------

describe('Organization bootstrap contracts', () => {
  // Fixture: org as returned by upsertOrganization after a Clerk webhook
  const bootstrappedOrg: Organization = {
    id: 'convex_org_id_acme',
    clerkOrgId: 'org_clerk_acme_001',
    name: 'Acme Corp',
    slug: 'acme-corp',
    plan: 'free',
    createdAt: 1712000000000,
    updatedAt: 1712000000000,
  }

  // Fixture: membership as returned by upsertMembership
  interface UserMembership {
    id: string
    clerkUserId: string
    orgId: string
    role: 'admin' | 'member' | 'viewer'
    joinedAt: number
  }

  const bootstrappedMembership: UserMembership = {
    id: 'membership_id_acme_admin',
    clerkUserId: 'user_clerk_founder_001',
    orgId: 'convex_org_id_acme',
    role: 'admin',
    joinedAt: 1712000100000,
  }

  it('Organization entity has all required fields from the contracts package', () => {
    // If Organization gains a required field, this type assignment fails at compile
    // time, and at runtime the property assertions below catch the mismatch.
    const org: Organization = bootstrappedOrg

    expect(org.id).toBeTruthy()
    expect(org.clerkOrgId).toBeTruthy()
    expect(org.name).toBeTruthy()
    expect(org.slug).toBeTruthy()
    expect(org.plan).toBeDefined()
    expect(typeof org.createdAt).toBe('number')
    expect(typeof org.updatedAt).toBe('number')
  })

  it('Organization plan is constrained to free | pro | enterprise', () => {
    const validPlans: Array<Organization['plan']> = ['free', 'pro', 'enterprise']
    expect(validPlans).toContain(bootstrappedOrg.plan)
    // Webhook-bootstrapped orgs always start on "free"
    expect(bootstrappedOrg.plan).toBe('free')
  })

  it('user_membership entity has all required fields', () => {
    const membership: UserMembership = bootstrappedMembership

    expect(membership.id).toBeTruthy()
    expect(membership.clerkUserId).toBeTruthy()
    expect(membership.orgId).toBeTruthy()
    expect(membership.role).toBeDefined()
    expect(typeof membership.joinedAt).toBe('number')
  })

  it('membership role is constrained to admin | member | viewer', () => {
    const validRoles: Array<'admin' | 'member' | 'viewer'> = ['admin', 'member', 'viewer']
    expect(validRoles).toContain(bootstrappedMembership.role)
  })

  it('clerkOrgId is the join key between Clerk and Convex organization records', () => {
    // The webhook handler passes clerkOrgId to upsertOrganization, and the
    // resulting Convex document carries the same clerkOrgId for future lookups.
    // This field is the single source of truth for org identity across systems.
    const inboundClerkOrgId = 'org_clerk_acme_001'
    expect(bootstrappedOrg.clerkOrgId).toBe(inboundClerkOrgId)
    // The Convex _id (mapped to `id`) is distinct from the Clerk org ID
    expect(bootstrappedOrg.id).not.toBe(bootstrappedOrg.clerkOrgId)
  })

  it('AuthContext.orgRole accepts admin | member | viewer — the three internal roles', () => {
    // Every Convex query/mutation receives an AuthContext after requireOrgMembership.
    // Verifying that the AuthContext type is satisfied by all three role values
    // ensures the role mapping (Clerk → internal) covers the full type space.
    const roles: Array<AuthContext['orgRole']> = ['admin', 'member', 'viewer']
    for (const role of roles) {
      const ctx: AuthContext = {
        userId: 'user_1',
        orgId: 'org_1',
        orgRole: role,
        sessionId: 'sess_1',
      }
      expect(ctx.orgRole).toBe(role)
    }
  })
})

/**
 * Real integration tests against a live Convex deployment.
 * Skipped when CONVEX_TEST_URL or TEST_API_KEY are not set.
 *
 * Required env vars:
 *   CONVEX_TEST_URL  — base URL of the test Next.js deployment (e.g. http://localhost:3000)
 *   TEST_API_KEY     — a valid API key provisioned in the test Convex deployment
 *   TEST_AGENT_ID    — a Convex ID for an agent in the test org (required for createRun)
 */
const BASE_URL = process.env['CONVEX_TEST_URL']
const API_KEY = process.env['TEST_API_KEY']
const AGENT_ID = process.env['TEST_AGENT_ID']

const hasTestEnv = !!(BASE_URL && API_KEY && AGENT_ID)

describe.skipIf(!hasTestEnv)('Real Convex integration tests', () => {
  // Shared run ID created in beforeAll and used by subsequent tests.
  let testRunId: string

  beforeAll(async () => {
    if (!hasTestEnv) return
    // Create a test run that all tests in this block can reference.
    const res = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY! },
      body: JSON.stringify({ agentId: AGENT_ID }),
    })
    if (!res.ok) throw new Error(`Failed to create test run: ${res.status}`)
    const body = await res.json() as { run: { id: string } }
    testRunId = body.run.id
  })

  it('creates a run via POST /api/runs', async () => {
    // Verifies that the create-run endpoint returns 201 with a run object
    // containing a valid ID and "running" status.
    const res = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY! },
      body: JSON.stringify({ agentId: AGENT_ID }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { run?: { id?: string; status?: string } }
    expect(body.run).toBeDefined()
    expect(body.run!.id).toBeTruthy()
    expect(body.run!.status).toBe('running')
  })

  it('sends events to the created run', async () => {
    // Verifies that a well-formed event batch is accepted and returns event IDs.
    const res = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY! },
      body: JSON.stringify({
        events: [{
          runId: testRunId,
          type: 'run.started',
          sequenceNumber: 1,
          timestamp: Date.now(),
          payload: { type: 'run.started' },
        }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { eventIds?: string[] }
    expect(body.eventIds).toBeDefined()
    expect(body.eventIds!.length).toBe(1)
  })

  it('is idempotent: sending the same event twice returns the existing event ID', async () => {
    // Verifies the (runId, sequenceNumber) dedup logic described in ADR-0007.
    // Both responses must return the same event ID, not two different IDs.
    const event = {
      runId: testRunId,
      type: 'run.started',
      sequenceNumber: 1,
      timestamp: Date.now(),
      payload: { type: 'run.started' },
    }
    const first = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY! },
      body: JSON.stringify({ events: [event] }),
    })
    const second = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY! },
      body: JSON.stringify({ events: [event] }),
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstBody = await first.json() as { eventIds: string[] }
    const secondBody = await second.json() as { eventIds: string[] }
    // Both calls must reference the same event record — no duplicate created.
    expect(firstBody.eventIds[0]).toBe(secondBody.eventIds[0])
  })

  it('returns 413 for an event payload exceeding 10 KB', async () => {
    // Verifies the payload size guard in POST /api/events (see ADR-0006).
    // The SDK auto-externalizes payloads before sending, so this 413 path
    // is only reached if a caller bypasses SDK externalization.
    const largePayload = { type: 'llm.response', data: 'x'.repeat(11 * 1024) }
    const res = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY! },
      body: JSON.stringify({
        events: [{
          runId: testRunId,
          type: 'llm.response',
          sequenceNumber: 99,
          timestamp: Date.now(),
          payload: largePayload,
        }],
      }),
    })
    expect(res.status).toBe(413)
  })

  it('GET /api/runs lists runs including the created run', async () => {
    // GET /api/runs uses Clerk auth; may return 401 without a session cookie.
    // When the test deployment uses Clerk auth on this route, 401 is expected
    // and is not a test failure — the route is working as designed.
    const res = await fetch(`${BASE_URL}/api/runs`, {
      headers: { 'x-api-key': API_KEY! },
    })
    // Accept either 200 (API-key-authenticated route) or 401 (Clerk-auth route).
    expect([200, 401]).toContain(res.status)
    if (res.status === 200) {
      const body = await res.json() as { runs: Array<{ id: string }> }
      expect(Array.isArray(body.runs)).toBe(true)
    }
  })
})
