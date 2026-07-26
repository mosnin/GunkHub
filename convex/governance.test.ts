/* eslint-disable */
// Backend tests for the follow-up sweep: membership revocation, org
// pending-deletion marking, retention-policy governance, comment ceilings,
// extended ingest rate limiting, purge re-scheduling, comment-budgeted run
// purges, the verification run-existence guard, sticky artifact references,
// and the stable API error-code contract. Runs against the REAL Convex
// functions via convex-test (same harness as backend.test.ts).
import { convexTest } from 'convex-test'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import {
  MAX_COMMENTS_PER_TARGET,
  MAX_EVENTS_PER_RUN,
  PURGE_BATCH_SIZE,
} from './helpers/pagination'

const modules = import.meta.glob('./**/*.ts')

const SECRET = 'test-webhook-secret'

beforeEach(() => {
  ;(globalThis as { process?: { env?: Record<string, string> } }).process ??= { env: {} }
  process.env.CONVEX_WEBHOOK_SECRET = SECRET
  delete process.env.BLOB_STORE_TOKEN
})

// One org with viewer/member/admin memberships plus a project/agent/run and key.
async function seedOrg(t: ReturnType<typeof convexTest>, tag: string, extra?: { rateLimitPerMin?: number }) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const org = await ctx.db.insert('organizations', {
      clerkOrgId: `clerk_${tag}`, name: tag, slug: tag, plan: 'free', createdAt: now, updatedAt: now,
    })
    await ctx.db.insert('user_memberships', { clerkUserId: `viewer_${tag}`, orgId: org, role: 'viewer', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: `member_${tag}`, orgId: org, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: `admin_${tag}`, orgId: org, role: 'admin', joinedAt: now })
    const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
    const run = await ctx.db.insert('runs', {
      orgId: org, projectId: project, agentId: agent, status: 'running', startedAt: now, metadata: {}, tags: [],
    })
    await ctx.db.insert('api_keys', {
      orgId: org, keyHash: `hash_${tag}`, name: 'k', createdBy: 'u', createdAt: now,
      rateLimitPerMin: extra?.rateLimitPerMin,
    })
    return { org, project, agent, run }
  })
}

const identity = (role: 'viewer' | 'member' | 'admin', tag: string) =>
  ({ subject: `${role}_${tag}`, org_id: `clerk_${tag}` }) as const

describe('Membership revocation (P1 authz defect)', () => {
  it('removeMembership deletes the row and requireOrgMembership then rejects the user', async () => {
    const t = convexTest(schema, modules)
    const { org, run } = await seedOrg(t, 'rm')
    const asMember = t.withIdentity(identity('member', 'rm'))

    // Before revocation, the member can read.
    const before = await asMember.query(api.runs.getRun, { runId: run })
    expect(before).toBeTruthy()

    const result = await t.mutation(api.organizations.removeMembership, {
      webhookSecret: SECRET, clerkUserId: 'member_rm', clerkOrgId: 'clerk_rm',
    })
    expect(result.removed).toBe(true)

    // After revocation, every org-scoped access is rejected.
    await expect(asMember.query(api.runs.getRun, { runId: run })).rejects.toThrow(/Unauthorized|not a member/i)
    await expect(asMember.query(api.runs.listRuns, { orgId: org })).rejects.toThrow(/Unauthorized|not a member/i)
  })

  it('writes a membership.removed audit row attributed to the webhook actor', async () => {
    const t = convexTest(schema, modules)
    await seedOrg(t, 'rm2')
    await t.mutation(api.organizations.removeMembership, {
      webhookSecret: SECRET, clerkUserId: 'viewer_rm2', clerkOrgId: 'clerk_rm2',
    })
    const rows = await t.run((ctx) => ctx.db.query('audit_log').collect())
    expect(rows.length).toBe(1)
    expect(rows[0].action).toBe('membership.removed')
    expect(rows[0].actorClerkUserId).toBe('clerk-webhook')
    expect(rows[0].metadata?.clerkUserId).toBe('viewer_rm2')
  })

  it('rejects a wrong webhook secret and leaves the membership intact', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedOrg(t, 'rm3')
    await expect(
      t.mutation(api.organizations.removeMembership, {
        webhookSecret: 'WRONG', clerkUserId: 'member_rm3', clerkOrgId: 'clerk_rm3',
      }),
    ).rejects.toThrow(/Unauthorized/)
    const stillWorks = await t.withIdentity(identity('member', 'rm3')).query(api.runs.getRun, { runId: run })
    expect(stillWorks).toBeTruthy()
  })

  it('is idempotent: removing an unknown membership or org is a no-op', async () => {
    const t = convexTest(schema, modules)
    await seedOrg(t, 'rm4')
    const noMember = await t.mutation(api.organizations.removeMembership, {
      webhookSecret: SECRET, clerkUserId: 'nobody', clerkOrgId: 'clerk_rm4',
    })
    expect(noMember.removed).toBe(false)
    const noOrg = await t.mutation(api.organizations.removeMembership, {
      webhookSecret: SECRET, clerkUserId: 'nobody', clerkOrgId: 'clerk_missing',
    })
    expect(noOrg.removed).toBe(false)
  })
})

describe('organization.deleted → pendingDeletionAt (no auto-purge, ADR 001)', () => {
  it('stamps pendingDeletionAt, writes an audit row, and deletes NOTHING', async () => {
    const t = convexTest(schema, modules)
    const { org, run } = await seedOrg(t, 'del')
    const result = await t.mutation(api.organizations.markOrganizationPendingDeletion, {
      webhookSecret: SECRET, clerkOrgId: 'clerk_del',
    })
    expect(result.marked).toBe(true)
    const state = await t.run(async (ctx) => ({
      org: await ctx.db.get(org),
      run: await ctx.db.get(run),
      audit: await ctx.db.query('audit_log').collect(),
    }))
    expect(state.org?.pendingDeletionAt).toBe(result.pendingDeletionAt)
    expect(state.run).not.toBeNull() // NOT purged — operator-invoked only
    expect(state.audit.map((r) => r.action)).toContain('org.deletion_requested')
  })

  it('is idempotent: a webhook retry keeps the original timestamp', async () => {
    const t = convexTest(schema, modules)
    const { org } = await seedOrg(t, 'del2')
    const first = await t.mutation(api.organizations.markOrganizationPendingDeletion, {
      webhookSecret: SECRET, clerkOrgId: 'clerk_del2',
    })
    const second = await t.mutation(api.organizations.markOrganizationPendingDeletion, {
      webhookSecret: SECRET, clerkOrgId: 'clerk_del2',
    })
    expect(second.pendingDeletionAt).toBe(first.pendingDeletionAt)
    const audits = await t.run((ctx) => ctx.db.query('audit_log').collect())
    // Only ONE audit row despite the retry.
    expect(audits.filter((r) => r.action === 'org.deletion_requested').length).toBe(1)
  })

  it('rejects a wrong webhook secret', async () => {
    const t = convexTest(schema, modules)
    await seedOrg(t, 'del3')
    await expect(
      t.mutation(api.organizations.markOrganizationPendingDeletion, {
        webhookSecret: 'WRONG', clerkOrgId: 'clerk_del3',
      }),
    ).rejects.toThrow(/Unauthorized/)
  })
})

describe('updateRetentionPolicy governance (admin-gated)', () => {
  it('ALLOWS an admin to set and clear the retention window, with audit rows', async () => {
    const t = convexTest(schema, modules)
    const { org } = await seedOrg(t, 'ret')
    const asAdmin = t.withIdentity(identity('admin', 'ret'))
    const updated = await asAdmin.mutation(api.organizations.updateRetentionPolicy, { orgId: org, retentionDays: 30 })
    expect(updated?.retentionDays).toBe(30)
    const cleared = await asAdmin.mutation(api.organizations.updateRetentionPolicy, { orgId: org })
    expect(cleared?.retentionDays).toBeUndefined()
    const actions = (await t.run((ctx) => ctx.db.query('audit_log').collect())).map((r) => r.action)
    expect(actions.filter((a) => a === 'org.retention_updated').length).toBe(2)
  })

  it('REJECTS member and viewer', async () => {
    const t = convexTest(schema, modules)
    const { org } = await seedOrg(t, 'ret2')
    await expect(
      t.withIdentity(identity('member', 'ret2')).mutation(api.organizations.updateRetentionPolicy, { orgId: org, retentionDays: 30 }),
    ).rejects.toThrow(/Forbidden|admin/i)
    await expect(
      t.withIdentity(identity('viewer', 'ret2')).mutation(api.organizations.updateRetentionPolicy, { orgId: org, retentionDays: 30 }),
    ).rejects.toThrow(/Forbidden|admin/i)
  })

  it('REJECTS out-of-range and non-integer values', async () => {
    const t = convexTest(schema, modules)
    const { org } = await seedOrg(t, 'ret3')
    const asAdmin = t.withIdentity(identity('admin', 'ret3'))
    for (const bad of [0, -5, 3651, 1.5]) {
      await expect(
        asAdmin.mutation(api.organizations.updateRetentionPolicy, { orgId: org, retentionDays: bad }),
      ).rejects.toThrow(/INVALID_ARGUMENT/)
    }
  })
})

describe('Comment ceiling (MAX_COMMENTS_PER_TARGET)', () => {
  it('rejects the comment that would exceed the per-target ceiling with a typed code', async () => {
    const t = convexTest(schema, modules)
    const { org, run } = await seedOrg(t, 'cc')
    await t.run(async (ctx) => {
      const now = Date.now()
      for (let i = 0; i < MAX_COMMENTS_PER_TARGET; i++) {
        await ctx.db.insert('comments', {
          orgId: org, targetId: run as string, targetType: 'run', authorId: 'u', content: `c${i}`, createdAt: now,
        })
      }
    })
    await expect(
      t.withIdentity(identity('member', 'cc')).mutation(api.comments.createComment, {
        orgId: org, targetId: run, targetType: 'run', content: 'one too many',
      }),
    ).rejects.toThrow(/COMMENT_LIMIT_EXCEEDED/)
  })

  it('a DIFFERENT target on the same org is unaffected by another target being full', async () => {
    const t = convexTest(schema, modules)
    const { org, run, project, agent } = await seedOrg(t, 'cc2')
    const otherRun = await t.run((ctx) => ctx.db.insert('runs', {
      orgId: org, projectId: project, agentId: agent, status: 'running', startedAt: Date.now(), metadata: {}, tags: [],
    }))
    await t.run(async (ctx) => {
      const now = Date.now()
      for (let i = 0; i < MAX_COMMENTS_PER_TARGET; i++) {
        await ctx.db.insert('comments', {
          orgId: org, targetId: run as string, targetType: 'run', authorId: 'u', content: `c${i}`, createdAt: now,
        })
      }
    })
    const ok = await t.withIdentity(identity('member', 'cc2')).mutation(api.comments.createComment, {
      orgId: org, targetId: otherRun, targetType: 'run', content: 'fine here',
    })
    expect(ok?.content).toBe('fine here')
  })
})

describe('Rate limiting extended to sdkCreateRun and sdkCreateArtifact', () => {
  it('sdkCreateRun counts against the per-key window and trips RATE_LIMITED', async () => {
    const t = convexTest(schema, modules)
    const { agent } = await seedOrg(t, 'rlr', { rateLimitPerMin: 3 })
    for (let i = 0; i < 3; i++) {
      await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'hash_rlr', agentId: agent })
    }
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'hash_rlr', agentId: agent }),
    ).rejects.toThrow(/RATE_LIMITED/)
  })

  it('sdkCreateArtifact counts against the same window', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedOrg(t, 'rla', { rateLimitPerMin: 3 })
    for (let i = 0; i < 3; i++) {
      await t.mutation(api.sdk_ingest.sdkCreateArtifact, {
        apiKeyHash: 'hash_rla', runId: run, name: `a${i}`, mimeType: 'text/plain',
        size: 1, storageKey: `k${i}`, storageBucket: 'b', checksum: `c${i}`,
      })
    }
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateArtifact, {
        apiKeyHash: 'hash_rla', runId: run, name: 'a3', mimeType: 'text/plain',
        size: 1, storageKey: 'k3', storageBucket: 'b', checksum: 'c3',
      }),
    ).rejects.toThrow(/RATE_LIMITED/)
  })

  it('window arithmetic: a stale window resets the count instead of rejecting', async () => {
    const t = convexTest(schema, modules)
    const { agent } = await seedOrg(t, 'rlw', { rateLimitPerMin: 3 })
    // Simulate a PREVIOUS minute window already at the limit.
    await t.run(async (ctx) => {
      const key = await ctx.db.query('api_keys').withIndex('by_key_hash', (q) => q.eq('keyHash', 'hash_rlw')).unique()
      await ctx.db.patch(key!._id, {
        rateWindowStart: Math.floor(Date.now() / 60_000) - 5,
        rateWindowCount: 3,
      })
    })
    // A call in the CURRENT window succeeds — the stale count must not carry over.
    const run = await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'hash_rlw', agentId: agent })
    expect(run.id).toBeTruthy()
    const key = await t.run((ctx) => ctx.db.query('api_keys').withIndex('by_key_hash', (q) => q.eq('keyHash', 'hash_rlw')).unique())
    expect(key?.rateWindowStart).toBe(Math.floor(Date.now() / 60_000))
    expect(key?.rateWindowCount).toBe(1)
  })

  it('a mixed sequence shares one counter across events/runs/artifacts', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedOrg(t, 'rlm', { rateLimitPerMin: 3 })
    // 2 events + 1 artifact = 3 units; the next unit trips.
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_rlm',
      events: [
        { runId: run, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} },
        { runId: run, type: 'tool.call', sequenceNumber: 2, timestamp: Date.now(), payload: {} },
      ],
    })
    await t.mutation(api.sdk_ingest.sdkCreateArtifact, {
      apiKeyHash: 'hash_rlm', runId: run, name: 'a', mimeType: 'text/plain',
      size: 1, storageKey: 'k', storageBucket: 'b', checksum: 'c',
    })
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_rlm',
        events: [{ runId: run, type: 'tool.call', sequenceNumber: 3, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/RATE_LIMITED/)
  })
})

describe('Purge re-scheduling (MAX_BATCHES exhaustion)', () => {
  it('an undrained purge returns done=false, re-schedules itself, and completes', async () => {
    const t = convexTest(schema, modules)
    // Seed well over one PURGE_BATCH_SIZE of documents.
    const { org } = await seedOrg(t, 'purge_rs')
    const { run } = await t.run(async (ctx) => {
      const orgDoc = (await ctx.db.query('organizations').withIndex('by_clerk_org_id', (q) => q.eq('clerkOrgId', 'clerk_purge_rs')).unique())!
      const run = (await ctx.db.query('runs').withIndex('by_org', (q) => q.eq('orgId', orgDoc._id)).first())!
      for (let i = 1; i <= PURGE_BATCH_SIZE + 50; i++) {
        await ctx.db.insert('events', {
          runId: run._id, orgId: orgDoc._id, type: 'tool.call', sequenceNumber: i, timestamp: Date.now(), payload: {},
        })
      }
      return { run: run._id }
    })

    vi.useFakeTimers()
    try {
      const first = await t.action(internal.retention.purgeOrganization, { orgId: org, maxBatches: 1 })
      expect(first.done).toBe(false) // budget exhausted → re-scheduled
      // Mid-purge, the org record still exists but is being drained.
      const midOrg = await t.run((ctx) => ctx.db.get(org))
      expect(midOrg).not.toBeNull()

      // Drain the self-scheduled continuation(s).
      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }

    const after = await t.run(async (ctx) => ({
      org: await ctx.db.get(org),
      run: await ctx.db.get(run),
      events: await ctx.db.query('events').collect(),
    }))
    expect(after.org).toBeNull()
    expect(after.run).toBeNull()
    expect(after.events.length).toBe(0)
  })
})

describe('purgeRunSlice comment budgeting', () => {
  it('bails mid-batch on a comment-heavy event and finishes on the next batch', async () => {
    const t = convexTest(schema, modules)
    const { org, run } = await seedOrg(t, 'cb')
    const evt = await t.run(async (ctx) => {
      await ctx.db.patch(run, { status: 'completed', endedAt: Date.now() })
      const evt = await ctx.db.insert('events', {
        runId: run, orgId: org, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {},
      })
      // More event comments than one batch budget.
      for (let i = 0; i < PURGE_BATCH_SIZE + 50; i++) {
        await ctx.db.insert('comments', {
          orgId: org, targetId: evt as string, targetType: 'event', authorId: 'u', content: `c${i}`, createdAt: Date.now(),
        })
      }
      return evt
    })

    const first = await t.mutation(internal.retention.purgeRunBatch, { runId: run })
    expect(first.done).toBe(false)
    // Budget respected: at most PURGE_BATCH_SIZE docs deleted in one batch.
    expect(first.deleted).toBeLessThanOrEqual(PURGE_BATCH_SIZE)
    // The event must survive until ALL its comments are gone.
    const mid = await t.run(async (ctx) => ({
      evt: await ctx.db.get(evt),
      comments: await ctx.db.query('comments').collect(),
    }))
    expect(mid.evt).not.toBeNull()
    expect(mid.comments.length).toBeGreaterThan(0)
    expect(mid.comments.length).toBeLessThan(PURGE_BATCH_SIZE + 50)

    const second = await t.mutation(internal.retention.purgeRunBatch, { runId: run })
    expect(second.done).toBe(true)
    const after = await t.run(async (ctx) => ({
      run: await ctx.db.get(run),
      evt: await ctx.db.get(evt),
      comments: await ctx.db.query('comments').collect(),
    }))
    expect(after.run).toBeNull()
    expect(after.evt).toBeNull()
    expect(after.comments.length).toBe(0)
  })
})

describe('Verification run-existence guard', () => {
  it('does NOT insert a verification row for a purged run', async () => {
    const t = convexTest(schema, modules)
    const { org, run } = await seedOrg(t, 'vg')
    await t.run((ctx) => ctx.db.delete(run)) // simulate the purge racing verification
    await t.mutation(internal.projection_verify._upsertVerificationResult, {
      runId: run, orgId: org, verifiedAt: Date.now(), isValid: true, summary: 'OK',
      sequenceGaps: [], duplicateSeqNums: [],
    })
    const rows = await t.run((ctx) => ctx.db.query('verification_results').collect())
    expect(rows.length).toBe(0)
  })
})

describe('Artifact GC sticky references + write-time backfill', () => {
  it('GC stamps referencedByEventId on a referenced artifact (fallback path)', async () => {
    const t = convexTest(schema, modules)
    const dayAgo = 25 * 60 * 60 * 1000
    const { artifact, evt } = await t.run(async (ctx) => {
      const now = Date.now()
      const org = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_gc_sticky', name: 'G', slug: 'g', plan: 'free', createdAt: now, updatedAt: now,
      })
      const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
      const run = await ctx.db.insert('runs', {
        orgId: org, projectId: project, agentId: agent, status: 'completed', startedAt: now - dayAgo, metadata: {}, tags: [],
      })
      const artifact = await ctx.db.insert('artifacts', {
        runId: run, orgId: org, name: 'a', mimeType: 'text/plain', size: 1,
        storageKey: 'k_sticky', storageBucket: 'b', checksum: 'c_sticky', createdAt: now - dayAgo,
      })
      const evt = await ctx.db.insert('events', {
        runId: run, orgId: org, type: 'llm.response', sequenceNumber: 1, timestamp: now,
        payload: { type: '_externalized', _artifact: { artifactId: String(artifact) } },
      })
      return { artifact, evt }
    })

    const result = await t.action(internal.artifact_gc.cleanOrphanedArtifacts, {})
    expect(result.stamped).toBe(1)

    const doc = await t.run((ctx) => ctx.db.get(artifact))
    expect(doc).not.toBeNull()
    expect(doc?.referencedByEventId).toEqual(evt)

    // Second GC run: the stamped artifact has left the candidate set entirely.
    const second = await t.action(internal.artifact_gc.cleanOrphanedArtifacts, {})
    expect(second.batch).toBe(0)
    expect(second.eventsScanned).toBe(0)
  })

  it('sdkCreateEvents backfills referencedByEventId at write time', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedOrg(t, 'bf')
    const artifact = await t.mutation(api.sdk_ingest.sdkCreateArtifact, {
      apiKeyHash: 'hash_bf', runId: run, name: 'big', mimeType: 'application/json',
      size: 99_999, storageKey: 'k_bf', storageBucket: 'b', checksum: 'c_bf',
    })
    expect(artifact.referencedByEventId).toBeUndefined()
    const { eventIds } = await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_bf',
      events: [
        { runId: run, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} },
        {
          runId: run, type: 'llm.response', sequenceNumber: 2, timestamp: Date.now(),
          payload: { type: '_externalized', originalType: 'llm.response', _artifact: { artifactId: String(artifact._id) } },
        },
      ],
    })
    const doc = await t.run((ctx) => ctx.db.get(artifact._id))
    expect(String(doc?.referencedByEventId)).toBe(eventIds[1])
  })
})

describe('Stable API error codes (contracts AFR_API_ERROR_CODES)', () => {
  it('append to a terminal run → RUN_NOT_ACTIVE', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedOrg(t, 'ec1')
    await t.run((ctx) => ctx.db.patch(run, { status: 'cancelled', endedAt: Date.now() }))
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_ec1',
        events: [{ runId: run, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/RUN_NOT_ACTIVE/)
  })

  it('non-contiguous sequence → SEQUENCE_CONFLICT (sdk and authenticated paths)', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedOrg(t, 'ec2')
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'hash_ec2',
      events: [{ runId: run, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} }],
    })
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_ec2',
        events: [{ runId: run, type: 'tool.call', sequenceNumber: 5, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/SEQUENCE_CONFLICT/)
    await expect(
      t.withIdentity(identity('member', 'ec2')).mutation(api.events.createEvent, {
        runId: run, type: 'tool.call', sequenceNumber: 7, timestamp: Date.now(), payload: {},
      }),
    ).rejects.toThrow(/SEQUENCE_CONFLICT/)
  })

  it('batch straddling the event cap → EVENT_LIMIT_EXCEEDED and NOTHING persists', async () => {
    const t = convexTest(schema, modules)
    const { org, run } = await seedOrg(t, 'ec3')
    // Simulate a run one event below the ceiling.
    await t.run((ctx) => ctx.db.insert('events', {
      runId: run, orgId: org, type: 'tool.call', sequenceNumber: MAX_EVENTS_PER_RUN - 1, timestamp: Date.now(), payload: {},
    }))
    // The batch's FIRST event fits (== MAX); the SECOND crosses the cap. The
    // mutation is transactional, so the whole batch must roll back.
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_ec3',
        events: [
          { runId: run, type: 'tool.call', sequenceNumber: MAX_EVENTS_PER_RUN, timestamp: Date.now(), payload: {} },
          { runId: run, type: 'tool.call', sequenceNumber: MAX_EVENTS_PER_RUN + 1, timestamp: Date.now(), payload: {} },
        ],
      }),
    ).rejects.toThrow(/EVENT_LIMIT_EXCEEDED/)
    const events = await t.run((ctx) => ctx.db.query('events').collect())
    expect(events.length).toBe(1) // only the seeded event — the straddling batch fully rolled back
    expect(events[0].sequenceNumber).toBe(MAX_EVENTS_PER_RUN - 1)
  })
})
