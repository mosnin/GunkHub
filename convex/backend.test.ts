/* eslint-disable */
// Backend tests against the REAL Convex functions via convex-test.
// Covers the constitution's non-negotiable invariants that had zero coverage:
// tenancy isolation (CLAUDE.md Tenancy Rules), the event-log rules (Rule 4/5),
// and the webhook-secret authorization gate (ADR-0023).
import { convexTest } from 'convex-test'
import { describe, it, expect, beforeEach } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

// Seed two orgs, each with a member and an API key, plus one run in org A.
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const orgA = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_org_a', name: 'Org A', slug: 'org-a', plan: 'free', createdAt: now, updatedAt: now,
    })
    const orgB = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_org_b', name: 'Org B', slug: 'org-b', plan: 'free', createdAt: now, updatedAt: now,
    })
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_a', orgId: orgA, role: 'admin', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_b', orgId: orgB, role: 'admin', joinedAt: now })
    const keyA = await ctx.db.insert('api_keys', {
      orgId: orgA, keyHash: 'hash_a', name: 'A key', createdBy: 'user_a', createdAt: now,
      lastUsedAt: undefined, revokedAt: undefined,
    })
    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
    const runA = await ctx.db.insert('runs', {
      orgId: orgA, projectId: projectA, agentId: agentA, status: 'running', startedAt: now, metadata: {}, tags: [],
    })
    return { orgA, orgB, keyA, runA, agentA }
  })
}

describe('Tenancy isolation (CLAUDE.md Tenancy Rules)', () => {
  it("org B's admin cannot read org A's run", async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    const asB = t.withIdentity({ subject: 'user_b', org_id: 'clerk_org_b' })
    await expect(asB.query(api.runs.getRun, { runId: runA })).rejects.toThrow(/Unauthorized|not a member/)
  })

  it("org A's admin CAN read org A's run", async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    const asA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_org_a' })
    const run = await asA.query(api.runs.getRun, { runId: runA })
    expect(run).toBeTruthy()
  })

  it('listApiKeys never returns the keyHash ingest credential', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seed(t)
    const asA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_org_a' })
    const keys = await asA.query(api.api_keys.listApiKeys, { orgId: orgA })
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect('keyHash' in k).toBe(false)
  })
})

describe('Event log invariants (Rule 4/5)', () => {
  it('accepts contiguous sequence numbers then rejects a gap', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    const base = { apiKeyHash: 'hash_a', timestamp: Date.now(), payload: {} }
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_a',
      events: [
        { runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: base.timestamp, payload: {} },
        { runId: runA, type: 'tool.call', sequenceNumber: 2, timestamp: base.timestamp, payload: {} },
      ],
    })
    // A gap (skip 3, jump to 5) must be rejected.
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_a',
        events: [{ runId: runA, type: 'tool.call', sequenceNumber: 5, timestamp: base.timestamp, payload: {} }],
      }),
    ).rejects.toThrow(/contiguous|expected 3/)
  })

  it('rejects a non-positive sequence number', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_a',
        events: [{ runId: runA, type: 'run.started', sequenceNumber: 0, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/positive integer|contiguous/)
  })

  it('rejects appending after a terminal event', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_a',
      events: [
        { runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} },
        { runId: runA, type: 'run.completed', sequenceNumber: 2, timestamp: Date.now(), payload: {} },
      ],
    })
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_a',
        events: [{ runId: runA, type: 'tool.call', sequenceNumber: 3, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/terminal/)
  })

  it('is idempotent for an already-stored event', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    const evt = { runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} }
    const first = await t.mutation(api.sdk_ingest.sdkCreateEvents, { apiKeyHash: 'hash_a', events: [evt] })
    const second = await t.mutation(api.sdk_ingest.sdkCreateEvents, { apiKeyHash: 'hash_a', events: [evt] })
    expect(second.eventIds[0]).toEqual(first.eventIds[0])
  })

  it('rejects an oversized inline payload (>10 KB, not externalized)', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    const huge = { blob: 'x'.repeat(11 * 1024) }
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_a',
        events: [{ runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: huge }],
      }),
    ).rejects.toThrow(/10|externaliz/i)
  })
})

describe('Webhook-secret authorization (ADR-0023)', () => {
  beforeEach(() => {
    ;(globalThis as { process?: { env?: Record<string, string> } }).process ??= { env: {} }
  })

  it('rejects upsertMembership without the correct secret', async () => {
    process.env.CONVEX_WEBHOOK_SECRET = 'correct-secret'
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_org_v', name: 'V', slug: 'v', plan: 'free', createdAt: Date.now(), updatedAt: Date.now(),
      })
    })
    await expect(
      t.mutation(api.organizations.upsertMembership, {
        webhookSecret: 'WRONG',
        clerkUserId: 'attacker',
        clerkOrgId: 'clerk_org_v',
        role: 'admin',
      }),
    ).rejects.toThrow(/Unauthorized/)
  })

  it('accepts upsertMembership with the correct secret', async () => {
    process.env.CONVEX_WEBHOOK_SECRET = 'correct-secret'
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_org_w', name: 'W', slug: 'w', plan: 'free', createdAt: Date.now(), updatedAt: Date.now(),
      })
    })
    const membership = await t.mutation(api.organizations.upsertMembership, {
      webhookSecret: 'correct-secret',
      clerkUserId: 'user_w',
      clerkOrgId: 'clerk_org_w',
      role: 'admin',
    })
    expect(membership.role).toBe('admin')
  })
})
