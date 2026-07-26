/* eslint-disable */
// Tests for ADR-002 (docs/adr/002-data-model-expansion.md): run hierarchy,
// environment/label validation, triage state machine, run search, evals
// (append-only + cross-org rejection), alert_rules admin-gating, webhook
// secret non-reuse, usage counter increments, the daily rollup cron, and
// tolerant token-usage extraction from both llm.response payload shapes.
import { convexTest } from 'convex-test'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

// One org (with viewer/member/admin) + a project/agent/run, plus a second org
// for cross-org rejection tests.
async function seedTwoOrgs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()

    const orgA = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_a', name: 'Org A', slug: 'org-a', plan: 'free', createdAt: now, updatedAt: now,
    })
    const orgB = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_b', name: 'Org B', slug: 'org-b', plan: 'free', createdAt: now, updatedAt: now,
    })
    await ctx.db.insert('user_memberships', { clerkUserId: 'viewer_a', orgId: orgA, role: 'viewer', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'member_a', orgId: orgA, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'admin_b', orgId: orgB, role: 'admin', joinedAt: now })

    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const projectA2 = await ctx.db.insert('projects', { orgId: orgA, name: 'P2', slug: 'p2', createdAt: now, updatedAt: now })
    const projectB = await ctx.db.insert('projects', { orgId: orgB, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })

    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent A', slug: 'a', createdAt: now, updatedAt: now })
    const agentA2 = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA2, name: 'Agent A2', slug: 'a2', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projectB, name: 'Agent B', slug: 'b', createdAt: now, updatedAt: now })

    // NOTE: seed runs carry a placeholder searchText — convex-test's search-index
    // fake evaluates the search filter against every row it visits regardless of
    // the `.eq("orgId", ...)` companion filter, and crashes on a row where the
    // (optional) searchField is entirely absent. Real Convex search indexes
    // simply exclude such rows; this placeholder keeps the test harness happy
    // without weakening what's being asserted (these seed rows never match the
    // 'zephyr'/'kaboomerang' search terms used below).
    const runA = await ctx.db.insert('runs', {
      orgId: orgA, projectId: projectA, agentId: agentA, status: 'running', startedAt: now, metadata: {}, tags: [],
      searchText: 'seed',
    })
    const runB = await ctx.db.insert('runs', {
      orgId: orgB, projectId: projectB, agentId: agentB, status: 'running', startedAt: now, metadata: {}, tags: [],
      searchText: 'seed',
    })

    return { orgA, orgB, projectA, projectA2, projectB, agentA, agentA2, agentB, runA, runB }
  })
}

const identity = (role: string, org: 'a' | 'b') => ({ subject: `${role}_${org}`, org_id: `clerk_${org}` }) as const

/** Flip a pending run to "running" by direct db patch (bypasses the admin-gated updateRunStatus mutation, matching the pattern used elsewhere in this test suite). */
async function makeRunning(t: ReturnType<typeof convexTest>, runId: any): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.patch(runId, { status: 'running' })
  })
}

// ---------------------------------------------------------------------------
// Run hierarchy: parentRunId org/project validation
// ---------------------------------------------------------------------------
describe('createRun — parentRunId validation (ADR-002)', () => {
  it('accepts a parent in the same org and project', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, runA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const child = await asA.mutation(api.runs.createRun, {
      orgId: orgA, projectId: projectA, agentId: agentA, parentRunId: runA,
    })
    expect(child.parentRunId).toBe(runA)
  })

  it('rejects a parent from a different project in the SAME org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA2, agentA2, runA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    await expect(
      asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA2, agentId: agentA2, parentRunId: runA }),
    ).rejects.toThrow(/parentRunId/)
  })

  it('rejects a parent from a different org (cross-org)', async () => {
    const t = convexTest(schema, modules)
    const { orgB, projectB, agentB, runA } = await seedTwoOrgs(t)
    const asB = t.withIdentity(identity('admin', 'b'))
    await expect(
      asB.mutation(api.runs.createRun, { orgId: orgB, projectId: projectB, agentId: agentB, parentRunId: runA }),
    ).rejects.toThrow(/parentRunId/)
  })

  it('listChildRuns returns direct children of a parent', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, runA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const child = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, parentRunId: runA })
    const { runs } = await asA.query(api.runs.listChildRuns, { parentRunId: runA })
    expect(runs.map((r) => r._id)).toEqual([child._id])
  })
})

// ---------------------------------------------------------------------------
// environment / labels / sessionId validation
// ---------------------------------------------------------------------------
describe('createRun — environment/labels/sessionId validation (ADR-002)', () => {
  it('accepts a well-known environment and a custom one within the length bound', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run1 = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, environment: 'staging' })
    expect(run1.environment).toBe('staging')
    const run2 = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, environment: 'load-test' })
    expect(run2.environment).toBe('load-test')
  })

  it('rejects an environment string over the length cap', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    await expect(
      asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, environment: 'x'.repeat(33) }),
    ).rejects.toThrow(/environment/)
  })

  it('rejects more than MAX_LABELS_PER_RUN labels', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    await expect(
      asA.mutation(api.runs.createRun, {
        orgId: orgA, projectId: projectA, agentId: agentA,
        labels: Array.from({ length: 11 }, (_, i) => `label-${i}`),
      }),
    ).rejects.toThrow(/labels/)
  })

  it('rejects a label exceeding the per-label length cap', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    await expect(
      asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, labels: ['x'.repeat(41)] }),
    ).rejects.toThrow(/label/)
  })

  it('setRunLabels replaces labels wholesale, validated the same way', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    const updated = await asA.mutation(api.runs.setRunLabels, { runId: run._id, labels: ['needs-review'] })
    expect(updated!.labels).toEqual(['needs-review'])
  })

  it('listSessionRuns groups runs by sessionId within an org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const r1 = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, sessionId: 'sess-1' })
    const r2 = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, sessionId: 'sess-1' })
    await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, sessionId: 'sess-2' })
    const { runs } = await asA.query(api.runs.listSessionRuns, { orgId: orgA, sessionId: 'sess-1' })
    expect(new Set(runs.map((r) => r._id))).toEqual(new Set([r1._id, r2._id]))
  })
})

// ---------------------------------------------------------------------------
// Triage state machine
// ---------------------------------------------------------------------------
describe('setRunTriage — state machine + failed/timed_out gate (ADR-002)', () => {
  async function seedFailedRun(t: ReturnType<typeof convexTest>) {
    const seeded = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.runA, { status: 'failed', endedAt: Date.now() })
    })
    return seeded
  }

  it('rejects setting triage on a non-terminal-failure run', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seedTwoOrgs(t) // still "running"
    const asA = t.withIdentity(identity('member', 'a'))
    await expect(
      asA.mutation(api.runs.setRunTriage, { runId: runA, triageState: 'investigating' }),
    ).rejects.toThrow(/failed or timed_out/)
  })

  it('walks open -> investigating -> resolved', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seedFailedRun(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const step1 = await asA.mutation(api.runs.setRunTriage, { runId: runA, triageState: 'investigating' })
    expect(step1!.triageState).toBe('investigating')
    const step2 = await asA.mutation(api.runs.setRunTriage, { runId: runA, triageState: 'resolved' })
    expect(step2!.triageState).toBe('resolved')
  })

  it('rejects skipping straight from open to resolved', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seedFailedRun(t)
    const asA = t.withIdentity(identity('member', 'a'))
    await expect(
      asA.mutation(api.runs.setRunTriage, { runId: runA, triageState: 'resolved' }),
    ).rejects.toThrow(/Invalid triage transition/)
  })

  it('any state can transition back to open', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seedFailedRun(t)
    const asA = t.withIdentity(identity('member', 'a'))
    await asA.mutation(api.runs.setRunTriage, { runId: runA, triageState: 'investigating' })
    await asA.mutation(api.runs.setRunTriage, { runId: runA, triageState: 'resolved' })
    const reopened = await asA.mutation(api.runs.setRunTriage, { runId: runA, triageState: 'open' })
    expect(reopened!.triageState).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// Search — own-org only
// ---------------------------------------------------------------------------
describe('searchRuns — org-scoped (ADR-002)', () => {
  it('returns only the caller org\'s matching runs, never another org\'s', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const asB = t.withIdentity(identity('admin', 'b'))

    await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA, tags: ['zephyr-marker'] })
    await asB.mutation(api.runs.createRun, { orgId: orgB, projectId: projectB, agentId: agentB, tags: ['zephyr-marker'] })

    const resultsA = await asA.query(api.runs.searchRuns, { orgId: orgA, searchTerm: 'zephyr' })
    expect(resultsA.runs.length).toBe(1)
    expect(resultsA.runs[0].orgId).toBe(orgA)

    const resultsB = await asB.query(api.runs.searchRuns, { orgId: orgB, searchTerm: 'zephyr' })
    expect(resultsB.runs.length).toBe(1)
    expect(resultsB.runs[0].orgId).toBe(orgB)
  })

  it('finds a failed run by its extracted error message after terminal reconcile', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {},
    })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'run.failed', sequenceNumber: 2, timestamp: Date.now(),
      payload: { message: 'kaboomerang failure' },
    })
    const results = await asA.query(api.runs.searchRuns, { orgId: orgA, searchTerm: 'kaboomerang' })
    expect(results.runs.map((r) => r._id)).toContain(run._id)
  })

  // M4 (searchable error text for externalized failures): when a run.failed
  // payload is too large and gets externalized, the full `error` object
  // lives only in the blob artifact and is never read at ingest time. The
  // SDK attaches a redacted `errorSummary` string as a sibling field on the
  // `_externalized` envelope specifically so this case still contributes
  // error text to runs.searchText — see convex/helpers/run_fields.ts
  // extractErrorMessage, which now checks `errorSummary` before falling
  // back to `message`/`errorMessage`/`error.message`.
  it('finds a failed run via errorSummary on an externalized run.failed payload', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {},
    })
    await asA.mutation(api.events.createEvent, {
      runId: run._id,
      type: 'run.failed',
      sequenceNumber: 2,
      timestamp: Date.now(),
      payload: {
        type: '_externalized',
        originalType: 'run.failed',
        _artifact: {
          artifactId: 'art_1', storageKey: 'k', storageBucket: 'b', checksum: 'c', size: 99999,
        },
        errorSummary: 'externalized-quasar-meltdown',
      },
    })
    const run2 = await t.run((ctx) => ctx.db.get(run._id))
    expect(run2?.status).toBe('failed')
    expect(run2?.searchText).toMatch(/externalized-quasar-meltdown/)
    const results = await asA.query(api.runs.searchRuns, { orgId: orgA, searchTerm: 'externalized-quasar-meltdown' })
    expect(results.runs.map((r) => r._id)).toContain(run._id)
  })
})

// ---------------------------------------------------------------------------
// Evals — append-only, cross-org rejected
// ---------------------------------------------------------------------------
describe('evals — append-only, cross-org rejected (ADR-002)', () => {
  it('recordEval inserts a row visible via listEvalsForRun', async () => {
    const t = convexTest(schema, modules)
    const { orgA, runA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const created = await asA.mutation(api.evals.recordEval, {
      runId: runA, name: 'schema-check', kind: 'rule', passed: true, score: 1,
    })
    expect(created.orgId).toBe(orgA)
    const list = await asA.query(api.evals.listEvalsForRun, { runId: runA })
    expect(list.map((e) => e._id)).toContain(created._id)
  })

  it('has no update or delete mutation exported (static source check)', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync(new URL('./evals.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/export const updateEval\b/)
    expect(source).not.toMatch(/export const deleteEval\b/)
  })

  it('rejects an out-of-range score', async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    await expect(
      asA.mutation(api.evals.recordEval, { runId: runA, name: 'bad-score', kind: 'manual', passed: false, score: 2 }),
    ).rejects.toThrow(/score/)
  })

  it("org B cannot recordEval against org A's run (cross-org rejected)", async () => {
    const t = convexTest(schema, modules)
    const { runA } = await seedTwoOrgs(t)
    const asB = t.withIdentity(identity('admin', 'b'))
    await expect(
      asB.mutation(api.evals.recordEval, { runId: runA, name: 'x', kind: 'manual', passed: true }),
      // The cross-org rejection is unchanged; only the MESSAGE changed. It is
      // now the same "Run not found" raised for a run that does not exist, so
      // this mutation cannot be used as an existence oracle over org A's run
      // ids (CLAUDE.md Tenancy Rule 3). See convex/tenancy_oracle.test.ts for
      // the test that asserts the two outcomes are deep-equal.
    ).rejects.toThrow(/Run not found/)
  })

  it("sdkRecordEval rejects a key writing against another org's run (cross-org)", async () => {
    const t = convexTest(schema, modules)
    const { orgB, runA } = await seedTwoOrgs(t)
    // A key that belongs to org B attempting to record an eval on org A's run.
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgB, keyHash: 'hash_cross', name: 'k2', createdBy: 'u', createdAt: Date.now() })
    })
    await expect(
      t.mutation(api.sdk_ingest.sdkRecordEval, {
        apiKeyHash: 'hash_cross', runId: runA, name: 'x', kind: 'manual', passed: true,
      }),
      // Still rejected; the message is now collapsed with the nonexistent-run
      // case so a valid key cannot enumerate another org's run ids.
    ).rejects.toThrow(/Run not found/)
  })
})

// ---------------------------------------------------------------------------
// alert_rules — admin-gated
// ---------------------------------------------------------------------------
describe('alert_rules — admin-gated (ADR-002)', () => {
  it('a member (non-admin) cannot create an alert rule', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const asMember = t.withIdentity(identity('member', 'a'))
    await expect(
      asMember.mutation(api.alerts.createAlertRule, {
        orgId: orgA, name: 'r', kind: 'run_failed',
        channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
      }),
    ).rejects.toThrow(/Forbidden|admin/i)
  })

  it('an admin can create, list, update, and delete an alert rule', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const rule = await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'Fails', kind: 'run_failed',
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })
    expect(rule.enabled).toBe(true)

    const list = await asAdmin.query(api.alerts.listAlertRules, { orgId: orgA })
    expect(list.map((r) => r._id)).toContain(rule._id)

    const updated = await asAdmin.mutation(api.alerts.updateAlertRule, { ruleId: rule._id, enabled: false })
    expect(updated!.enabled).toBe(false)

    const result = await asAdmin.mutation(api.alerts.deleteAlertRule, { ruleId: rule._id })
    expect(result.deleted).toBe(true)
  })

  it('rejects a webhook channel target that is not https://', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await expect(
      asAdmin.mutation(api.alerts.createAlertRule, {
        orgId: orgA, name: 'bad', kind: 'run_failed',
        channels: [{ type: 'webhook', target: 'http://insecure.example.com' }],
      }),
    ).rejects.toThrow(/https/)
  })
})

// ---------------------------------------------------------------------------
// webhook_targets — secret never returned after creation
// ---------------------------------------------------------------------------
describe('webhook_targets — secret returned once (ADR-002 / ADR-003)', () => {
  it('createWebhook returns the plaintext secret; listWebhooks never does', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const created = await asAdmin.mutation(api.webhooks.createWebhook, {
      orgId: orgA, url: 'https://example.com/hook', events: ['run.failed'],
    })
    expect(typeof created.secret).toBe('string')
    expect(created.secret.length).toBeGreaterThan(0)

    const list = await asAdmin.query(api.webhooks.listWebhooks, { orgId: orgA })
    expect(list.length).toBe(1)
    expect('secret' in list[0]).toBe(false)
  })

  it('rejects a non-https:// url', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await expect(
      asAdmin.mutation(api.webhooks.createWebhook, { orgId: orgA, url: 'http://example.com', events: ['run.failed'] }),
    ).rejects.toThrow(/https/)
  })

  it('rejects an unknown event type', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await expect(
      asAdmin.mutation(api.webhooks.createWebhook, { orgId: orgA, url: 'https://example.com', events: ['not.a.real.event'] }),
    ).rejects.toThrow(/Unknown webhook event/)
  })
})

// ---------------------------------------------------------------------------
// Usage counters
// ---------------------------------------------------------------------------
describe('usage_counters — increment on ingest (ADR-002)', () => {
  it('a batch sdkCreateEvents call flushes eventsIngested exactly (deterministic)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, runA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'usage_key', name: 'k', createdBy: 'u', createdAt: Date.now() })
    })
    const now = Date.now()
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'usage_key',
      events: [
        { runId: runA, type: 'run.started', sequenceNumber: 1, timestamp: now, payload: {} },
        { runId: runA, type: 'tool.call', sequenceNumber: 2, timestamp: now, payload: { tool: 'x' } },
      ],
    })
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const day = new Date(now).toISOString().slice(0, 10)
    const usage = await asAdmin.query(api.usage.getUsageForDay, { orgId: orgA, day })
    expect(usage).not.toBeNull()
    expect(usage!.eventsIngested).toBe(2)
    expect(usage!.bytesIngested).toBeGreaterThan(0)
  })

  it('sdkCreateRun increments runsStarted (approximate — forced to flush via Math.random mock)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'usage_key2', name: 'k', createdBy: 'u', createdAt: Date.now() })
    })
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0) // force the strided flush
    try {
      const now = Date.now()
      await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'usage_key2', agentId: agentA })
      const asAdmin = t.withIdentity(identity('admin', 'a'))
      const day = new Date(now).toISOString().slice(0, 10)
      const usage = await asAdmin.query(api.usage.getUsageForDay, { orgId: orgA, day })
      expect(usage).not.toBeNull()
      expect(usage!.runsStarted).toBeGreaterThan(0)
    } finally {
      randomSpy.mockRestore()
    }
  })

  it('sdkCreateArtifact increments artifactBytes', async () => {
    const t = convexTest(schema, modules)
    const { orgA, runA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'usage_key3', name: 'k', createdBy: 'u', createdAt: Date.now() })
    })
    const now = Date.now()
    await t.mutation(api.sdk_ingest.sdkCreateArtifact, {
      apiKeyHash: 'usage_key3', runId: runA, name: 'f.txt', mimeType: 'text/plain',
      size: 4096, storageKey: 'k1', storageBucket: 'b1', checksum: 'c1',
    })
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const day = new Date(now).toISOString().slice(0, 10)
    const usage = await asAdmin.query(api.usage.getUsageForDay, { orgId: orgA, day })
    expect(usage!.artifactBytes).toBe(4096)
  })
})

// ---------------------------------------------------------------------------
// Daily rollup cron
// ---------------------------------------------------------------------------
describe('computeDailyRollups — cron (ADR-002)', () => {
  it('computes correct per-agent counts and token sums for a seeded day', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)

    const dayStart = Date.parse('2026-01-10T00:00:00.000Z')
    await t.run(async (ctx) => {
      await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed',
        startedAt: dayStart + 1000, endedAt: dayStart + 3000, metadata: {}, tags: [],
        tokensIn: 100, tokensOut: 50,
      })
      await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'failed',
        startedAt: dayStart + 2000, endedAt: dayStart + 4000, metadata: {}, tags: [],
        tokensIn: 10, tokensOut: 5,
      })
      // Outside the day window — must not be counted.
      await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed',
        startedAt: dayStart - 60_000, endedAt: dayStart - 50_000, metadata: {}, tags: [],
      })
    })

    const result = await t.action(internal.rollups.computeDailyRollups, { date: '2026-01-10' })
    expect(result.written).toBeGreaterThanOrEqual(1)

    const rollup = await t.run(async (ctx) =>
      ctx.db.query('daily_rollups').withIndex('by_agent_date', (q) => q.eq('agentId', agentA).eq('date', '2026-01-10')).unique(),
    )
    expect(rollup).not.toBeNull()
    expect(rollup!.runsTotal).toBe(2)
    expect(rollup!.runsCompleted).toBe(1)
    expect(rollup!.runsFailed).toBe(1)
    expect(rollup!.tokensIn).toBe(110)
    expect(rollup!.tokensOut).toBe(55)
    expect(rollup!.durationMsP50).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Token extraction from both llm.response payload variants
// ---------------------------------------------------------------------------
describe('token extraction — tolerant of both payload variants (ADR-002)', () => {
  it('extracts from Anthropic-style { usage: { input_tokens, output_tokens } }', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, { runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.response', sequenceNumber: 2, timestamp: Date.now(),
      payload: { usage: { input_tokens: 12, output_tokens: 34 } },
    })
    const updated = await asA.query(api.runs.getRun, { runId: run._id })
    expect(updated.tokensIn).toBe(12)
    expect(updated.tokensOut).toBe(34)
  })

  it('extracts from OpenAI-style flat { prompt_tokens, completion_tokens }', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, { runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.response', sequenceNumber: 2, timestamp: Date.now(),
      payload: { prompt_tokens: 7, completion_tokens: 21 },
    })
    const updated = await asA.query(api.runs.getRun, { runId: run._id })
    expect(updated.tokensIn).toBe(7)
    expect(updated.tokensOut).toBe(21)
  })

  it('accumulates tokensIn/tokensOut across multiple llm.response events', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, { runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.response', sequenceNumber: 2, timestamp: Date.now(),
      payload: { usage: { input_tokens: 5, output_tokens: 5 } },
    })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.response', sequenceNumber: 3, timestamp: Date.now(),
      payload: { prompt_tokens: 3, completion_tokens: 2 },
    })
    const updated = await asA.query(api.runs.getRun, { runId: run._id })
    expect(updated.tokensIn).toBe(8)
    expect(updated.tokensOut).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Cycle 3 — cost accuracy: runs.modelsSeen denormalization
// ---------------------------------------------------------------------------
describe('runs.modelsSeen — tolerant model extraction, deduped, bounded (Cycle 3)', () => {
  it('populates modelsSeen from a top-level `model` field on llm.request/llm.response', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, { runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.request', sequenceNumber: 2, timestamp: Date.now(),
      payload: { model: 'claude-opus-4' },
    })
    const updated = await asA.query(api.runs.getRun, { runId: run._id })
    expect(updated.modelsSeen).toEqual(['claude-opus-4'])
  })

  it('extracts from a nested request/response.model shape', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, { runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.response', sequenceNumber: 2, timestamp: Date.now(),
      payload: { response: { model: 'gpt-4o' } },
    })
    const updated = await asA.query(api.runs.getRun, { runId: run._id })
    expect(updated.modelsSeen).toEqual(['gpt-4o'])
  })

  it('dedupes repeated models across multiple events', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, { runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.request', sequenceNumber: 2, timestamp: Date.now(), payload: { model: 'claude-opus-4' },
    })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.response', sequenceNumber: 3, timestamp: Date.now(), payload: { model: 'claude-opus-4' },
    })
    await asA.mutation(api.events.createEvent, {
      runId: run._id, type: 'llm.request', sequenceNumber: 4, timestamp: Date.now(), payload: { model: 'claude-haiku-4' },
    })
    const updated = await asA.query(api.runs.getRun, { runId: run._id })
    expect(updated.modelsSeen).toEqual(['claude-opus-4', 'claude-haiku-4'])
  })

  it('caps modelsSeen at MAX_MODELS_SEEN_PER_RUN (10) distinct models', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asA = t.withIdentity(identity('member', 'a'))
    const run = await asA.mutation(api.runs.createRun, { orgId: orgA, projectId: projectA, agentId: agentA })
    await makeRunning(t, run._id)
    await asA.mutation(api.events.createEvent, { runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} })
    let seq = 2
    for (let i = 0; i < 12; i++) {
      await asA.mutation(api.events.createEvent, {
        runId: run._id, type: 'llm.request', sequenceNumber: seq++, timestamp: Date.now(), payload: { model: `model-${i}` },
      })
    }
    const updated = await asA.query(api.runs.getRun, { runId: run._id })
    expect(updated.modelsSeen).toHaveLength(10)
    expect(updated.modelsSeen).toEqual([
      'model-0', 'model-1', 'model-2', 'model-3', 'model-4',
      'model-5', 'model-6', 'model-7', 'model-8', 'model-9',
    ])
  })

  it('is also populated via the API-key ingest path (sdkCreateEvents)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'sdk_models', name: 'k', createdBy: 'u', createdAt: Date.now() })
    })
    const created = await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'sdk_models', agentId: String(agentA) })
    await t.mutation(api.sdk_ingest.sdkCreateEvents, {
      apiKeyHash: 'sdk_models',
      events: [
        { runId: String(created.id), type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} },
        { runId: String(created.id), type: 'llm.request', sequenceNumber: 2, timestamp: Date.now(), payload: { model: 'claude-sonnet-5' } },
      ],
    })
    const run = await t.run((ctx) => ctx.db.get(created.id))
    expect(run!.modelsSeen).toEqual(['claude-sonnet-5'])
  })
})
