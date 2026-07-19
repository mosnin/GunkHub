/* eslint-disable */
// Tests for Cycle 2 (docs/design/action_layer.md, ADR-002 follow-up): alert
// evaluation (convex/alert_engine.ts), webhook delivery
// (convex/webhook_engine.ts + convex/helpers/delivery.ts), the key-authed
// read API (convex/read_api.ts), and the eval-auto-run scheduler wiring
// (convex/events.ts / convex/sdk_ingest.ts -> internal.insights.runEvalsForRun).
import { convexTest } from 'convex-test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import { assertSafeWebhookUrl, deliverWebhook, computeBackoff } from './helpers/delivery'

const modules = import.meta.glob('./**/*.ts')

const identity = (role: string, org: 'a' | 'b') => ({ subject: `${role}_${org}`, org_id: `clerk_${org}` }) as const

async function seedTwoOrgs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const orgA = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_a', name: 'Org A', slug: 'org-a', plan: 'free', createdAt: now, updatedAt: now })
    const orgB = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_b', name: 'Org B', slug: 'org-b', plan: 'free', createdAt: now, updatedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'member_a', orgId: orgA, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'admin_b', orgId: orgB, role: 'admin', joinedAt: now })

    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const projectB = await ctx.db.insert('projects', { orgId: orgB, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent A', slug: 'a', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projectB, name: 'Agent B', slug: 'b', createdAt: now, updatedAt: now })

    return { orgA, orgB, projectA, projectB, agentA, agentB }
  })
}

async function seedFailedRun(t: ReturnType<typeof convexTest>, orgId: any, projectId: any, agentId: any) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    return await ctx.db.insert('runs', {
      orgId, projectId, agentId, status: 'failed', startedAt: now - 1000, endedAt: now, metadata: {}, tags: [],
    })
  })
}

// ---------------------------------------------------------------------------
// alert_engine — evaluateAlertsForRun
// ---------------------------------------------------------------------------
describe('alert_engine.evaluateAlertsForRun', () => {
  it('fires a run_failed rule exactly once for a failed run, and is idempotent on re-run', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)

    const first = await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })
    expect(first.fired).toBe(1)

    const events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(1)
    expect(events[0]!.deliveryStatus).toBe('pending')

    // Re-running must NOT double-fire (idempotent on (ruleId, runId)).
    const second = await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })
    expect(second.fired).toBe(0)
    const eventsAfter = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(eventsAfter.length).toBe(1)

    // A webhook_deliveries row was enqueued for the webhook channel.
    const deliveries = await t.run((ctx) => ctx.db.query('webhook_deliveries').withIndex('by_org', (q) => q.eq('orgId', orgA)).collect())
    expect(deliveries.length).toBe(1)
    expect(deliveries[0]!.alertEventId).toBe(events[0]!._id)
    expect(deliveries[0]!.status).toBe('pending')
  })

  it('does not fire for a still-running run (no terminal status)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })
    const runId = await t.run(async (ctx) => ctx.db.insert('runs', {
      orgId: orgA, projectId: projectA, agentId: agentA, status: 'running', startedAt: Date.now(), metadata: {}, tags: [],
    }))
    const result = await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })
    expect(result).toEqual({ evaluated: 0, fired: 0 })
  })

  it('failure_rate: fires once the failure percentage in the window meets the threshold', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'rate', kind: 'failure_rate', thresholdPct: 50, windowMinutes: 60,
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })

    const now = Date.now()
    // 1 completed + 1 failed inside the window => 50% failure rate, meets threshold.
    await t.run(async (ctx) => {
      await ctx.db.insert('runs', { orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: now - 60_000, endedAt: now - 50_000, metadata: {}, tags: [] })
    })
    const failedRunId = await seedFailedRun(t, orgA, projectA, agentA)

    const result = await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId: failedRunId })
    expect(result.fired).toBe(1)
  })

  it('failure_rate: does NOT fire below the threshold', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'rate', kind: 'failure_rate', thresholdPct: 90, windowMinutes: 60,
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })
    const now = Date.now()
    // 3 completed + 1 failed => 25% failure rate, below the 90% threshold.
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('runs', { orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: now - 60_000, endedAt: now - 50_000, metadata: {}, tags: [] })
      }
    })
    const failedRunId = await seedFailedRun(t, orgA, projectA, agentA)
    const result = await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId: failedRunId })
    expect(result.fired).toBe(0)
  })

  it('eval_failed: fires when a failed eval exists for the run', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'eval', kind: 'eval_failed',
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await t.run(async (ctx) => {
      await ctx.db.insert('evals', { orgId: orgA, runId, name: 'x', kind: 'manual', passed: false, createdAt: Date.now(), createdBy: 'u' })
    })
    const result = await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })
    expect(result.fired).toBe(1)
  })

  it('a disabled rule never fires', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const rule = await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })
    await asAdmin.mutation(api.alerts.updateAlertRule, { ruleId: rule._id, enabled: false })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    const result = await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })
    expect(result.fired).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// helpers/delivery — SSRF guard exercised at the delivery path
// ---------------------------------------------------------------------------
describe('helpers/delivery — SSRF guard at the delivery path', () => {
  it('assertSafeWebhookUrl rejects a private IPv4 literal', () => {
    expect(() => assertSafeWebhookUrl('https://10.0.0.5/hook')).toThrow(/private\/reserved/)
  })

  it('deliverWebhook refuses to fetch a private-IP target even if it slipped past creation-time validation', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    await expect(
      deliverWebhook({ url: 'https://127.0.0.1/hook', secret: 's', event: 'run.failed', payload: {}, deliveryId: 'd1' }),
    ).rejects.toThrow(/Refusing to deliver webhook/)
    // The guard must reject BEFORE any network call is attempted.
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('computeBackoff is bounded by maxBackoffMs and grows with attempt', () => {
    const d0 = computeBackoff(0, { backoffMs: 500, maxBackoffMs: 30_000 })
    const d5 = computeBackoff(5, { backoffMs: 500, maxBackoffMs: 30_000 })
    expect(d0).toBeGreaterThanOrEqual(0)
    expect(d0).toBeLessThanOrEqual(500)
    expect(d5).toBeLessThanOrEqual(30_000)
  })
})

// ---------------------------------------------------------------------------
// webhook_engine — deliverPendingWebhooks
// ---------------------------------------------------------------------------
describe('webhook_engine.deliverPendingWebhooks', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers a pending row, patches status/attempts/responseCode, and rolls up alert_events to delivered', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    const result = await t.action(internal.webhook_engine.deliverPendingWebhooks, {})
    expect(result.delivered).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Envelope shape: apiVersion, event, orgId, run, firedAt; signed with the
    // svix-style header and the run's shape (no `metadata`).
    const [, init] = fetchSpy.mock.calls[0]!
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.apiVersion).toBe('2026-01')
    expect(body.event).toBe('alert.fired')
    expect(body.orgId).toBe(String(orgA))
    expect(body.run.id).toBe(String(runId))
    expect(body.run.metadata).toBeUndefined()
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-afr-signature']).toMatch(/^t=\d+,v1=[0-9a-f]+$/)

    const delivery = await t.run((ctx) => ctx.db.query('webhook_deliveries').withIndex('by_org', (q) => q.eq('orgId', orgA)).first())
    expect(delivery!.status).toBe('delivered')
    expect(delivery!.attempts).toBe(1)
    expect(delivery!.responseCode).toBe(200)

    const alertEvent = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).first())
    expect(alertEvent!.deliveryStatus).toBe('delivered')
    expect(alertEvent!.deliveredAt).toBeDefined()
  })

  it('retries a 5xx with backoff, then marks terminally failed after WEBHOOK_MAX_ATTEMPTS', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }))

    // First attempt: retryable failure, stays "pending" with a future nextAttemptAt.
    const first = await t.action(internal.webhook_engine.deliverPendingWebhooks, {})
    expect(first.retried).toBe(1)
    let delivery = await t.run((ctx) => ctx.db.query('webhook_deliveries').withIndex('by_org', (q) => q.eq('orgId', orgA)).first())
    expect(delivery!.status).toBe('pending')
    expect(delivery!.attempts).toBe(1)
    expect(delivery!.nextAttemptAt).toBeGreaterThan(Date.now() - 1)

    // Not yet due — a second drain right away finds nothing to do.
    const tooSoon = await t.action(internal.webhook_engine.deliverPendingWebhooks, {})
    expect(tooSoon.batch).toBe(0)

    // Force it due and drain repeatedly until it exhausts WEBHOOK_MAX_ATTEMPTS.
    for (let i = 0; i < 10; i++) {
      const current = await t.run((ctx) => ctx.db.get(delivery!._id))
      if (current!.status === 'failed') break
      await t.run((ctx) => ctx.db.patch(delivery!._id, { nextAttemptAt: Date.now() - 1 }))
      await t.action(internal.webhook_engine.deliverPendingWebhooks, {})
    }

    delivery = await t.run((ctx) => ctx.db.get(delivery!._id))
    expect(delivery!.status).toBe('failed')
    expect(delivery!.attempts).toBe(6) // WEBHOOK_MAX_ATTEMPTS

    const alertEvent = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).first())
    expect(alertEvent!.deliveryStatus).toBe('failed')
  })

  it('never throws out of the batch when a webhook target is missing', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    const webhookId = await t.run(async (ctx) =>
      ctx.db.insert('webhook_targets', { orgId: orgA, url: 'https://example.com/hook', secret: 's', events: ['run.failed'], enabled: true, createdAt: Date.now() }),
    )
    await t.run((ctx) => ctx.db.delete(webhookId)) // target vanishes before delivery
    await t.run((ctx) => ctx.db.insert('webhook_deliveries', { orgId: orgA, webhookId, event: 'run.failed', status: 'pending', attempts: 0, createdAt: Date.now(), nextAttemptAt: Date.now() }))

    const result = await t.action(internal.webhook_engine.deliverPendingWebhooks, {})
    expect(result.failed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// email_engine.deliverPendingEmails — Cycle 3: the deferred alert-email path
// ---------------------------------------------------------------------------
describe('email_engine.deliverPendingEmails', () => {
  const ORIGINAL_ENV = { ...process.env }
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
  })

  it('an alert rule with an email channel enqueues an email_deliveries row with a rendered envelope', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [{ type: 'email', target: 'oncall@example.com' }],
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })

    const email = await t.run((ctx) => ctx.db.query('email_deliveries').withIndex('by_status_created', (q) => q.eq('status', 'pending')).first())
    expect(email).not.toBeNull()
    expect(email!.orgId).toBe(orgA)
    expect(email!.to).toBe('oncall@example.com')
    expect(email!.subject).toContain('fails')
    expect(email!.body).toContain(String(runId))
    expect(email!.body).toContain('Agent A')
  })

  it('console path (unconfigured AFR_EMAIL_PROVIDER): drains cleanly to "delivered" and rolls up alert_events', async () => {
    delete process.env['AFR_EMAIL_PROVIDER']
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [{ type: 'email', target: 'oncall@example.com' }],
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })

    const result = await t.action(internal.email_engine.deliverPendingEmails, {})
    expect(result.delivered).toBe(1)
    expect(logSpy).toHaveBeenCalled()

    const email = await t.run((ctx) => ctx.db.query('email_deliveries').withIndex('by_status_created', (q) => q.eq('status', 'delivered')).first())
    expect(email!.attempts).toBe(1)

    const alertEvent = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).first())
    expect(alertEvent!.deliveryStatus).toBe('delivered')
  })

  it('a rule with BOTH a webhook and an email channel only rolls alert_events up once both siblings resolve', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [
        { type: 'webhook', target: 'https://example.com/hook' },
        { type: 'email', target: 'oncall@example.com' },
      ],
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })

    // Only the email side resolves first — rollup must NOT fire yet.
    const emailResult = await t.action(internal.email_engine.deliverPendingEmails, {})
    expect(emailResult.delivered).toBe(1)
    let alertEvent = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).first())
    expect(alertEvent!.deliveryStatus).toBe('pending')

    // Now the webhook side resolves too — rollup fires.
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    const webhookResult = await t.action(internal.webhook_engine.deliverPendingWebhooks, {})
    expect(webhookResult.delivered).toBe(1)
    alertEvent = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).first())
    expect(alertEvent!.deliveryStatus).toBe('delivered')
  })

  it('never throws out of the batch on a notifier failure — retries then terminally fails', async () => {
    process.env['AFR_EMAIL_PROVIDER'] = 'resend'
    process.env['RESEND_API_KEY'] = 'fake_test_key_not_real'
    process.env['AFR_EMAIL_FROM'] = 'alerts@example.com'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))

    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.alerts.createAlertRule, {
      orgId: orgA, name: 'fails', kind: 'run_failed',
      channels: [{ type: 'email', target: 'oncall@example.com' }],
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.alert_engine.evaluateAlertsForRun, { runId })

    const first = await t.action(internal.email_engine.deliverPendingEmails, {})
    expect(first.retried).toBe(1)

    let email = await t.run((ctx) => ctx.db.query('email_deliveries').withIndex('by_status_created', (q) => q.eq('status', 'pending')).first())
    for (let i = 0; i < 10; i++) {
      const current = await t.run((ctx) => ctx.db.get(email!._id))
      if (current!.status === 'failed') break
      await t.run((ctx) => ctx.db.patch(email!._id, { nextAttemptAt: Date.now() - 1 }))
      await t.action(internal.email_engine.deliverPendingEmails, {})
    }
    email = await t.run((ctx) => ctx.db.get(email!._id))
    expect(email!.status).toBe('failed')
    expect(email!.attempts).toBe(6) // EMAIL_MAX_ATTEMPTS
  })
})

// ---------------------------------------------------------------------------
// read_api — scope enforcement + cross-org
// ---------------------------------------------------------------------------
describe('read_api — key scope enforcement and cross-org rejection', () => {
  it('a write-only key (no "read" scope) cannot call apiListRuns/apiGetRun', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'write_only', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['ingest:write'] })
    })
    await expect(t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'write_only' })).rejects.toThrow(/Forbidden/)
  })

  it('a key with the "read" scope can list and get runs scoped to its own org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await t.run(async (ctx) => {
      await ctx.db.insert('events', { runId, orgId: orgA, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {} })
    })

    const list = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key' })
    expect(list.runs.map((r: any) => r._id)).toContain(runId)

    const got = await t.mutation(api.read_api.apiGetRun, { apiKeyHash: 'read_key', runId: String(runId) })
    expect(got.run._id).toBe(runId)
    expect(got.eventCount).toBe(1)

    const replay = await t.mutation(api.read_api.apiGetReplay, { apiKeyHash: 'read_key', runId: String(runId) })
    expect(replay.totalEvents).toBe(1)
    expect(replay.frames[0].actor).toBe('system')
  })

  it("a key from org B cannot read org A's run (cross-org rejected)", async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgB, keyHash: 'read_key_b', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
    const runId = await seedFailedRun(t, orgA, projectA, agentA)
    await expect(
      t.mutation(api.read_api.apiGetRun, { apiKeyHash: 'read_key_b', runId: String(runId) }),
    ).rejects.toThrow(/not found/i)
  })

  it('a revoked key is rejected', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'revoked_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'], revokedAt: Date.now() })
    })
    await expect(t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'revoked_key' })).rejects.toThrow(/Unauthorized/)
  })

  it('a read-only key (no "ingest:write" scope) cannot call sdkCreateRun (write path rejected)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_only', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'read_only', agentId: String(agentA) }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('a combined-scope key (["read", "ingest:write"]) can both create runs AND read them back', async () => {
    const t = convexTest(schema, modules)
    const { orgA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'combined', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read', 'ingest:write'] })
    })

    const created = await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: 'combined', agentId: String(agentA) })
    expect(created.id).toBeDefined()

    const list = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'combined' })
    expect(list.runs.map((r: any) => r._id)).toContain(created.id)

    const got = await t.mutation(api.read_api.apiGetRun, { apiKeyHash: 'combined', runId: String(created.id) })
    expect(got.run._id).toBe(created.id)
  })
})

// ---------------------------------------------------------------------------
// Eval auto-run — scheduler wiring (Team A's scheduling call -> Team B's
// convex/insights.ts runEvalsForRun, which has now landed).
// ---------------------------------------------------------------------------
describe('eval auto-run — scheduler wiring end to end', () => {
  it('createEvent on a run.failed terminal event schedules runEvalsForRun, which inserts eval rows', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asMember = t.withIdentity(identity('member', 'a'))
    const asAdmin = t.withIdentity(identity('admin', 'a'))

    const version = await asAdmin.mutation(api.agent_versions.createAgentVersion, {
      agentId: agentA,
      version: 'v1',
      evalRules: [{ kind: 'terminal_status', expect: ['completed'] }],
    })

    const run = await asMember.mutation(api.runs.createRun, {
      orgId: orgA, projectId: projectA, agentId: agentA, agentVersionId: version._id,
    })
    await t.run((ctx) => ctx.db.patch(run._id, { status: 'running' }))

    vi.useFakeTimers()
    try {
      await asMember.mutation(api.events.createEvent, {
        runId: run._id, type: 'run.started', sequenceNumber: 1, timestamp: Date.now(), payload: {},
      })
      await asMember.mutation(api.events.createEvent, {
        runId: run._id, type: 'run.failed', sequenceNumber: 2, timestamp: Date.now(), payload: { message: 'oops' },
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
    } finally {
      vi.useRealTimers()
    }

    const evals = await t.run((ctx) => ctx.db.query('evals').withIndex('by_run', (q) => q.eq('runId', run._id)).collect())
    // One row per rule (1) + one summary row.
    expect(evals.length).toBe(2)
    expect(evals.some((e) => e.name === 'eval_summary')).toBe(true)

    // The alert engine was also scheduled (no alert_rules configured here, so
    // it evaluates zero rules but must not throw).
  })

  it('rejects more than MAX_EVAL_RULES_PER_VERSION rules on createAgentVersion', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await expect(
      asAdmin.mutation(api.agent_versions.createAgentVersion, {
        agentId: agentA, version: 'v2',
        evalRules: Array.from({ length: 21 }, () => ({ kind: 'terminal_status', expect: ['completed'] })),
      }),
    ).rejects.toThrow(/evalRules/)
  })

  it('rejects an evalRules entry with an unknown rule kind', async () => {
    const t = convexTest(schema, modules)
    const { agentA } = await seedTwoOrgs(t)
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await expect(
      asAdmin.mutation(api.agent_versions.createAgentVersion, {
        agentId: agentA, version: 'v3',
        evalRules: [{ kind: 'not_a_real_kind' }],
      }),
    ).rejects.toThrow(/Unknown evalRules/)
  })
})
