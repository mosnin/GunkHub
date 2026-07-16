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
    const keyB = await ctx.db.insert('api_keys', {
      orgId: orgB, keyHash: 'hash_b', name: 'B key', createdBy: 'user_b', createdAt: now,
      lastUsedAt: undefined, revokedAt: undefined,
    })
    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
    const runA = await ctx.db.insert('runs', {
      orgId: orgA, projectId: projectA, agentId: agentA, status: 'running', startedAt: now, metadata: {}, tags: [],
    })
    return { orgA, orgB, keyA, keyB, runA, agentA }
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

  it("org B's admin cannot read org A's events", async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_a',
      events: [{ runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} }],
    })
    const asB = t.withIdentity({ subject: 'user_b', org_id: 'clerk_org_b' })
    await expect(asB.query(api.events.listEvents, { runId: runA })).rejects.toThrow(/Unauthorized|not a member/)
  })

  it("org B's VALID key cannot write events into org A's run (cross-org branch)", async () => {
    // This exercises the real tenancy branch (run.orgId !== apiKey.orgId), not the
    // unknown-key guard: hash_b is a legitimate, non-revoked key belonging to org B.
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_b',
        events: [{ runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/Unauthorized/)
    // ...and org A's own key CAN, proving the rejection is org-scoped, not blanket.
    const ok = await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_a',
      events: [{ runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} }],
    })
    expect(ok.eventIds.length).toBe(1)
  })

  it("org B's valid key also cannot create a run against org A's agent", async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seed(t)
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'hash_b', agentId: agentA }),
    ).rejects.toThrow(/Unauthorized/)
  })

  it('createRun rejects a project/agent from another org (cross-org reference)', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seed(t)
    // Create a project + agent that belong to org B.
    const { projectB, agentB } = await t.run(async (ctx) => {
      const now = Date.now()
      const orgB = await ctx.db
        .query('organizations')
        .withIndex('by_clerk_org_id', (q) => q.eq('clerkOrgId', 'clerk_org_b'))
        .unique()
      const projectB = await ctx.db.insert('projects', { orgId: orgB!._id, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })
      const agentB = await ctx.db.insert('agents', { orgId: orgB!._id, projectId: projectB, name: 'AB', slug: 'ab', createdAt: now, updatedAt: now })
      return { projectB, agentB }
    })
    const asA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_org_a' })
    await expect(
      asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectB, agentId: agentB }),
    ).rejects.toThrow(/not found in this organization/i)
  })

  it('createComment rejects a target run from another org', async () => {
    const t = convexTest(schema, modules)
    const { orgB, runA } = await seed(t) // runA belongs to org A
    // user_b (org B) tries to comment on org A's run.
    const asB = t.withIdentity({ subject: 'user_b', org_id: 'clerk_org_b' })
    await expect(
      asB.mutation(api.comments.createComment, {
        orgId: orgB,
        targetId: runA,
        targetType: 'run',
        content: 'cross-org note',
      }),
    ).rejects.toThrow(/not found in this organization/i)
  })

  it('getOrganization rejects resolving another org (enumeration guard)', async () => {
    const t = convexTest(schema, modules)
    await seed(t)
    // user_b (org B) tries to resolve org A's record.
    const asB = t.withIdentity({ subject: 'user_b', org_id: 'clerk_org_b' })
    await expect(asB.query(api.organizations.getOrganization, { clerkOrgId: 'clerk_org_a' })).rejects.toThrow(/Unauthorized/)
    // ...but can resolve its own.
    const own = await asB.query(api.organizations.getOrganization, { clerkOrgId: 'clerk_org_b' })
    expect(own).toBeTruthy()
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

  it('afterSeq returns only events past the given sequence number (live tail)', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_a',
      events: [
        { runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} },
        { runId: runA, type: 'tool.call', sequenceNumber: 2, timestamp: Date.now(), payload: {} },
        { runId: runA, type: 'tool.call', sequenceNumber: 3, timestamp: Date.now(), payload: {} },
      ],
    })
    const asA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_org_a' })
    const tail = await asA.query(api.events.listEvents, { runId: runA, afterSeq: 2 })
    // Only seq 3 is past afterSeq=2.
    expect(tail.events.map((e: { sequenceNumber: number }) => e.sequenceNumber)).toEqual([3])
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

  it('rejects an oversized payload even when it SPOOFS type "_externalized"', async () => {
    // The size guard must not be bypassable by claiming the payload is a pointer.
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    const spoof = { type: '_externalized', blob: 'x'.repeat(11 * 1024) }
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_a',
        events: [{ runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: spoof }],
      }),
    ).rejects.toThrow(/10|externaliz/i)
  })

  it('rejects a first event that is not run.started (Rule 5)', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seed(t)
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_a',
        events: [{ runId: runA, type: 'tool.call', sequenceNumber: 1, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/first event.*run\.started/i)
  })
})

describe('Enterprise API-key lifecycle (expiration + scopes)', () => {
  async function seedKey(
    t: ReturnType<typeof convexTest>,
    keyProps: { keyHash: string; expiresAt?: number; scopes?: string[] },
  ) {
    return await t.run(async (ctx) => {
      const now = Date.now()
      const org = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_k', name: 'K', slug: 'k', plan: 'free', createdAt: now, updatedAt: now,
      })
      const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
      await ctx.db.insert('api_keys', {
        orgId: org, keyHash: keyProps.keyHash, name: 'k', createdBy: 'u', createdAt: now,
        lastUsedAt: undefined, revokedAt: undefined,
        expiresAt: keyProps.expiresAt, scopes: keyProps.scopes,
      })
      return { org, agent }
    })
  }

  it('rejects an expired API key on ingest', async () => {
    const t = convexTest(schema, modules)
    const { agent } = await seedKey(t, { keyHash: 'expired', expiresAt: Date.now() - 1000 })
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'expired', agentId: agent }),
    ).rejects.toThrow(/expired/i)
  })

  it('accepts a key whose expiresAt is in the future', async () => {
    const t = convexTest(schema, modules)
    const { agent } = await seedKey(t, { keyHash: 'future', expiresAt: Date.now() + 60_000 })
    const run = await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'future', agentId: agent })
    expect(run.id).toBeTruthy()
  })

  it('rejects a key that lacks the ingest:write scope', async () => {
    const t = convexTest(schema, modules)
    const { agent } = await seedKey(t, { keyHash: 'scoped', scopes: ['ingest:read'] })
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'scoped', agentId: agent }),
    ).rejects.toThrow(/scope/i)
  })

  it('accepts a key that has the ingest:write scope', async () => {
    const t = convexTest(schema, modules)
    const { agent } = await seedKey(t, { keyHash: 'writer', scopes: ['ingest:write'] })
    const run = await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'writer', agentId: agent })
    expect(run.id).toBeTruthy()
  })

  it('a key with no scopes has full ingest access (back-compat)', async () => {
    const t = convexTest(schema, modules)
    const { agent } = await seedKey(t, { keyHash: 'legacy' })
    const run = await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'legacy', agentId: agent })
    expect(run.id).toBeTruthy()
  })

  it('enforces the per-key ingest rate limit', async () => {
    const t = convexTest(schema, modules)
    // Seed a rate-limited key (3 events/min) and a run to append to.
    const { runId } = await t.run(async (ctx) => {
      const now = Date.now()
      const org = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_r', name: 'R', slug: 'r', plan: 'free', createdAt: now, updatedAt: now,
      })
      const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
      await ctx.db.insert('api_keys', {
        orgId: org, keyHash: 'rl', name: 'k', createdBy: 'u', createdAt: now,
        lastUsedAt: undefined, revokedAt: undefined, rateLimitPerMin: 3,
      })
      const runId = await ctx.db.insert('runs', {
        orgId: org, projectId: project, agentId: agent, status: 'running', startedAt: now, metadata: {}, tags: [],
      })
      return { runId }
    })
    // First 3 events fit within the limit.
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'rl',
      events: [
        { runId, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} },
        { runId, type: 'tool.call', sequenceNumber: 2, timestamp: Date.now(), payload: {} },
        { runId, type: 'tool.call', sequenceNumber: 3, timestamp: Date.now(), payload: {} },
      ],
    })
    // The 4th within the same minute exceeds 3/min and is rejected.
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'rl',
        events: [{ runId, type: 'tool.call', sequenceNumber: 4, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/rate limit/i)
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
