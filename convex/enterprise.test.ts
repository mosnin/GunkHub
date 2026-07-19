/* eslint-disable */
// Backend tests for the enterprise audit items: the createAgent admin gate,
// the append-only audit trail, ADR 001 purge/retention, the reworked artifact
// GC semantics, and the write ceilings. Runs against the REAL Convex functions
// via convex-test (same harness as backend.test.ts).
import { convexTest } from 'convex-test'
import { describe, it, expect, beforeEach } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import { MAX_EVENTS_PER_RUN, DEFAULT_RATE_LIMIT_PER_MIN } from './helpers/pagination'

const modules = import.meta.glob('./**/*.ts')

beforeEach(() => {
  ;(globalThis as { process?: { env?: Record<string, string> } }).process ??= { env: {} }
  // Ensure blob deletion is skipped (no outbound fetch) in purge/GC actions.
  delete process.env.BLOB_STORE_TOKEN
})

const DAY = 24 * 60 * 60 * 1000

// One org with viewer/member/admin memberships plus a project.
async function seedOrg(t: ReturnType<typeof convexTest>, tag: string) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const org = await ctx.db.insert('organizations', {
      clerkOrgId: `clerk_${tag}`, name: tag, slug: tag, plan: 'free', createdAt: now, updatedAt: now,
    })
    await ctx.db.insert('user_memberships', { clerkUserId: `viewer_${tag}`, orgId: org, role: 'viewer', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: `member_${tag}`, orgId: org, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: `admin_${tag}`, orgId: org, role: 'admin', joinedAt: now })
    const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    return { org, project }
  })
}

const identity = (role: 'viewer' | 'member' | 'admin', tag: string) =>
  ({ subject: `${role}_${tag}`, org_id: `clerk_${tag}` }) as const

describe('createAgent authorization gate (P0)', () => {
  it('REJECTS a viewer creating an agent', async () => {
    const t = convexTest(schema, modules)
    const { project } = await seedOrg(t, 'ag')
    await expect(
      t.withIdentity(identity('viewer', 'ag')).mutation(api.agents.createAgent, {
        projectId: project, name: 'A', slug: 'a',
      }),
    ).rejects.toThrow(/Forbidden|admin/i)
  })

  it('REJECTS a member creating an agent', async () => {
    const t = convexTest(schema, modules)
    const { project } = await seedOrg(t, 'ag2')
    await expect(
      t.withIdentity(identity('member', 'ag2')).mutation(api.agents.createAgent, {
        projectId: project, name: 'A', slug: 'a',
      }),
    ).rejects.toThrow(/Forbidden|admin/i)
  })

  it('ALLOWS an admin to create an agent', async () => {
    const t = convexTest(schema, modules)
    const { project } = await seedOrg(t, 'ag3')
    const agent = await t.withIdentity(identity('admin', 'ag3')).mutation(api.agents.createAgent, {
      projectId: project, name: 'A', slug: 'a',
    })
    expect(agent.slug).toBe('a')
  })
})

describe('Audit trail (append-only audit_log)', () => {
  it('a privileged action writes an audit row', async () => {
    const t = convexTest(schema, modules)
    const { org, project } = await seedOrg(t, 'au')
    const asAdmin = t.withIdentity(identity('admin', 'au'))
    const agent = await asAdmin.mutation(api.agents.createAgent, { projectId: project, name: 'A', slug: 'a' })
    const rows = await t.run((ctx) => ctx.db.query('audit_log').collect())
    expect(rows.length).toBe(1)
    expect(rows[0].action).toBe('agent.created')
    expect(rows[0].orgId).toEqual(org)
    expect(rows[0].actorClerkUserId).toBe('admin_au')
    expect(rows[0].targetId).toBe(String(agent._id))
  })

  it('createApiKey and revokeApiKey both write audit rows', async () => {
    const t = convexTest(schema, modules)
    const { org } = await seedOrg(t, 'au2')
    const asAdmin = t.withIdentity(identity('admin', 'au2'))
    const key = await asAdmin.mutation(api.api_keys.createApiKey, { orgId: org, name: 'k', keyHash: 'h1' })
    await asAdmin.mutation(api.api_keys.revokeApiKey, { keyId: key._id })
    const actions = (await t.run((ctx) => ctx.db.query('audit_log').collect())).map((r) => r.action).sort()
    expect(actions).toEqual(['api_key.created', 'api_key.revoked'])
  })

  it('viewer and member CANNOT read the audit log; admin CAN', async () => {
    const t = convexTest(schema, modules)
    const { org, project } = await seedOrg(t, 'au3')
    await t.withIdentity(identity('admin', 'au3')).mutation(api.agents.createAgent, { projectId: project, name: 'A', slug: 'a' })
    await expect(
      t.withIdentity(identity('viewer', 'au3')).query(api.audit.listAuditLog, { orgId: org }),
    ).rejects.toThrow(/Forbidden|admin/i)
    await expect(
      t.withIdentity(identity('member', 'au3')).query(api.audit.listAuditLog, { orgId: org }),
    ).rejects.toThrow(/Forbidden|admin/i)
    const page = await t.withIdentity(identity('admin', 'au3')).query(api.audit.listAuditLog, { orgId: org })
    expect(page.entries.length).toBe(1)
    expect(page.entries[0].action).toBe('agent.created')
  })

  it("an admin of another org cannot read this org's audit log", async () => {
    const t = convexTest(schema, modules)
    const { org } = await seedOrg(t, 'au4')
    await seedOrg(t, 'au5')
    await expect(
      t.withIdentity(identity('admin', 'au5')).query(api.audit.listAuditLog, { orgId: org }),
    ).rejects.toThrow(/Unauthorized|not a member/i)
  })
})

// Seed a "full" org: project, agent, version, run, events, artifact, comments,
// verification result, api key, memberships, audit row.
async function seedFullOrg(t: ReturnType<typeof convexTest>, tag: string, opts?: { runStatus?: string; startedAt?: number }) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const org = await ctx.db.insert('organizations', {
      clerkOrgId: `clerk_${tag}`, name: tag, slug: tag, plan: 'free', createdAt: now, updatedAt: now,
    })
    await ctx.db.insert('user_memberships', { clerkUserId: `admin_${tag}`, orgId: org, role: 'admin', joinedAt: now })
    const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
    await ctx.db.insert('agent_versions', { agentId: agent, orgId: org, version: '1', createdAt: now })
    const run = await ctx.db.insert('runs', {
      orgId: org, projectId: project, agentId: agent,
      status: (opts?.runStatus ?? 'completed') as any,
      startedAt: opts?.startedAt ?? now, endedAt: now, metadata: {}, tags: [],
    })
    const evt = await ctx.db.insert('events', { runId: run, orgId: org, type: 'run.started', sequenceNumber: 1, timestamp: now, payload: {} })
    await ctx.db.insert('events', { runId: run, orgId: org, type: 'run.completed', sequenceNumber: 2, timestamp: now, payload: {} })
    await ctx.db.insert('artifacts', {
      runId: run, orgId: org, eventId: undefined, name: 'a', mimeType: 'application/json', size: 1,
      storageKey: `k_${tag}`, storageBucket: 'b', checksum: `c_${tag}`, createdAt: now,
    })
    await ctx.db.insert('comments', { orgId: org, targetId: run as string, targetType: 'run', authorId: 'u', content: 'x', createdAt: now })
    await ctx.db.insert('comments', { orgId: org, targetId: evt as string, targetType: 'event', authorId: 'u', content: 'y', createdAt: now })
    await ctx.db.insert('verification_results', {
      runId: run, orgId: org, verifiedAt: now, isValid: true, summary: 'OK', sequenceGaps: [], duplicateSeqNums: [],
    })
    await ctx.db.insert('api_keys', { orgId: org, keyHash: `hash_${tag}`, name: 'k', createdBy: 'u', createdAt: now })
    await ctx.db.insert('audit_log', {
      orgId: org, actorClerkUserId: 'u', action: 'project.created', targetType: 'project', targetId: String(project), timestamp: now,
    })
    // AUDIT FIX (cycle 4): ADR-002/ADR-003 tables (evals, alert_rules,
    // alert_events, webhook_targets, webhook_deliveries, email_deliveries,
    // usage_counters, daily_rollups) landed after ADR 001's purge cascade was
    // written and were never wired into it — every one of these rows used to
    // survive purgeOrganization forever. Seed one row per table here so the
    // 'purges every record of org A' test below actually exercises them.
    await ctx.db.insert('evals', {
      orgId: org, runId: run, name: 'eval1', kind: 'manual', passed: true, createdAt: now, createdBy: 'u',
    })
    const rule = await ctx.db.insert('alert_rules', {
      orgId: org, name: 'r', kind: 'run_failed', channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
      enabled: true, createdAt: now, updatedAt: now,
    })
    const alertEvent = await ctx.db.insert('alert_events', {
      orgId: org, ruleId: rule, runId: run, firedAt: now, summary: 's', deliveryStatus: 'pending',
    })
    const webhook = await ctx.db.insert('webhook_targets', {
      orgId: org, url: 'https://example.com/hook', secret: 'sec', events: ['run.failed'], enabled: true, createdAt: now,
    })
    await ctx.db.insert('webhook_deliveries', {
      orgId: org, webhookId: webhook, event: 'run.failed', runId: run, status: 'pending', attempts: 0, createdAt: now, alertEventId: alertEvent,
    })
    await ctx.db.insert('email_deliveries', {
      orgId: org, alertEventId: alertEvent, to: 'a@example.com', subject: 's', body: 'b', status: 'pending', attempts: 0, createdAt: now,
    })
    await ctx.db.insert('usage_counters', {
      orgId: org, day: '2026-07-19', runsStarted: 1, eventsIngested: 1, bytesIngested: 1, artifactBytes: 1,
    })
    await ctx.db.insert('daily_rollups', {
      orgId: org, agentId: agent, date: '2026-07-19', runsTotal: 1, runsFailed: 0, runsCompleted: 1, runsCancelled: 0, runsTimedOut: 0, tokensIn: 0, tokensOut: 0,
    })
    return { org, project, agent, run }
  })
}

async function countOrgDocs(t: ReturnType<typeof convexTest>, org: unknown) {
  return await t.run(async (ctx) => {
    const tables = [
      'projects', 'agents', 'agent_versions', 'runs', 'events', 'artifacts', 'comments', 'verification_results',
      'api_keys', 'user_memberships', 'audit_log',
      // AUDIT FIX (cycle 4): previously missing from this list, which let the
      // purge-cascade gap for these tables go undetected.
      'evals', 'alert_rules', 'alert_events', 'webhook_targets', 'webhook_deliveries', 'email_deliveries',
      'usage_counters', 'daily_rollups',
    ] as const
    let total = 0
    for (const table of tables) {
      const docs = await ctx.db.query(table as any).collect()
      total += docs.filter((d: any) => d.orgId === org).length
    }
    const orgDoc = await ctx.db.get(org as any)
    return { total, orgExists: orgDoc !== null }
  })
}

describe('ADR 001 — org purge cascade', () => {
  it('purges every record of org A while leaving org B untouched', async () => {
    const t = convexTest(schema, modules)
    const { org: orgA } = await seedFullOrg(t, 'purge_a')
    const { org: orgB } = await seedFullOrg(t, 'purge_b')

    const before = await countOrgDocs(t, orgA)
    expect(before.total).toBeGreaterThan(0)

    const result = await t.action(internal.retention.purgeOrganization, { orgId: orgA })
    expect(result.done).toBe(true)

    const afterA = await countOrgDocs(t, orgA)
    expect(afterA.total).toBe(0)
    expect(afterA.orgExists).toBe(false)

    const afterB = await countOrgDocs(t, orgB)
    expect(afterB.total).toBe(before.total) // identical seed shape
    expect(afterB.orgExists).toBe(true)
  })
})

describe('ADR 001 — retention window enforcement', () => {
  it('deletes only TERMINAL runs older than the window', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    // Org with a 30-day retention window.
    const { org, oldTerminal, freshTerminal, oldRunning } = await t.run(async (ctx) => {
      const org = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_ret', name: 'R', slug: 'r', plan: 'free', createdAt: now, updatedAt: now, retentionDays: 30,
      })
      const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
      const mkRun = (status: string, startedAt: number) => ctx.db.insert('runs', {
        orgId: org, projectId: project, agentId: agent, status: status as any, startedAt, metadata: {}, tags: [],
      })
      const oldTerminal = await mkRun('completed', now - 40 * DAY)
      const freshTerminal = await mkRun('failed', now - 5 * DAY)
      const oldRunning = await mkRun('running', now - 40 * DAY)
      await ctx.db.insert('events', { runId: oldTerminal, orgId: org, type: 'run.started', sequenceNumber: 1, timestamp: now, payload: {} })
      await ctx.db.insert('artifacts', {
        runId: oldTerminal, orgId: org, name: 'a', mimeType: 'text/plain', size: 1,
        storageKey: 'k', storageBucket: 'b', checksum: 'c', createdAt: now,
      })
      return { org, oldTerminal, freshTerminal, oldRunning }
    })

    await t.action(internal.retention.enforceRetention, {})

    const state = await t.run(async (ctx) => ({
      oldTerminal: await ctx.db.get(oldTerminal),
      freshTerminal: await ctx.db.get(freshTerminal),
      oldRunning: await ctx.db.get(oldRunning),
      events: await ctx.db.query('events').collect(),
      artifacts: await ctx.db.query('artifacts').collect(),
      org: await ctx.db.get(org),
    }))
    expect(state.oldTerminal).toBeNull() // out of window + terminal -> deleted
    expect(state.freshTerminal).not.toBeNull() // within window -> kept
    expect(state.oldRunning).not.toBeNull() // never touch in-progress runs
    expect(state.events.length).toBe(0)
    expect(state.artifacts.length).toBe(0)
    expect(state.org).not.toBeNull() // retention never deletes the org
  })

  it('never touches an org without retentionDays', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedFullOrg(t, 'noret', { startedAt: Date.now() - 400 * DAY })
    await t.action(internal.retention.enforceRetention, {})
    const still = await t.run((ctx) => ctx.db.get(run))
    expect(still).not.toBeNull()
  })

  // AUDIT FIX (cycle 4): evals were not deleted by purgeRunSlice, so a
  // retention-expired run's eval rows survived forever, referencing a
  // deleted runId — an erasure gap for a table that can carry arbitrary,
  // possibly-sensitive `details` text quoted from the run.
  it('deletes evals recorded against a retention-expired run', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const { org, oldTerminal } = await t.run(async (ctx) => {
      const org = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_ret_evals', name: 'R', slug: 'r', plan: 'free', createdAt: now, updatedAt: now, retentionDays: 30,
      })
      const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
      const oldTerminal = await ctx.db.insert('runs', {
        orgId: org, projectId: project, agentId: agent, status: 'completed', startedAt: now - 40 * DAY, metadata: {}, tags: [],
      })
      await ctx.db.insert('evals', {
        orgId: org, runId: oldTerminal, name: 'e', kind: 'manual', passed: true, createdAt: now, createdBy: 'u',
      })
      return { org, oldTerminal }
    })

    await t.action(internal.retention.enforceRetention, {})

    const evals = await t.run((ctx) => ctx.db.query('evals').withIndex('by_run', (q) => q.eq('runId', oldTerminal)).collect())
    expect(evals.length).toBe(0)
    expect(await t.run((ctx) => ctx.db.get(oldTerminal))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(org))).not.toBeNull() // retention never deletes the org
  })

  // AUDIT FIX (cycle 5, H4): retention-window deletion of a terminal run must
  // also scrub its alert_events, email_deliveries, and webhook_deliveries —
  // the org purge already covers these tables org-wide, but the per-run
  // window sweep previously left them behind entirely (docs/adr/001,
  // "Addendum (Cycle 5)").
  it('deletes evals, alert_events, webhook_deliveries, and email_deliveries for a retention-expired run', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()
    const { org, oldTerminal, alertEventId, webhookId } = await t.run(async (ctx) => {
      const org = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_ret_deliveries', name: 'R2', slug: 'r2', plan: 'free', createdAt: now, updatedAt: now, retentionDays: 30,
      })
      const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
      const oldTerminal = await ctx.db.insert('runs', {
        orgId: org, projectId: project, agentId: agent, status: 'failed', startedAt: now - 40 * DAY, endedAt: now - 40 * DAY, metadata: {}, tags: [],
      })
      await ctx.db.insert('evals', {
        orgId: org, runId: oldTerminal, name: 'e', kind: 'manual', passed: true, createdAt: now, createdBy: 'u',
      })
      const ruleId = await ctx.db.insert('alert_rules', {
        orgId: org, name: 'rule', kind: 'run_failed', channels: [{ type: 'webhook', target: 'https://example.com/hook' }], enabled: true, createdAt: now, updatedAt: now,
      })
      const alertEventId = await ctx.db.insert('alert_events', {
        orgId: org, ruleId, runId: oldTerminal, firedAt: now, summary: 'run failed', deliveryStatus: 'failed',
      })
      await ctx.db.insert('email_deliveries', {
        orgId: org, alertEventId, to: 'a@example.com', subject: 's', body: 'b', status: 'failed', attempts: 6, createdAt: now,
      })
      const webhookId = await ctx.db.insert('webhook_targets', {
        orgId: org, url: 'https://example.com/hook', secret: 's', events: ['run.failed'], enabled: true, createdAt: now,
      })
      await ctx.db.insert('webhook_deliveries', {
        orgId: org, webhookId, event: 'run.failed', runId: oldTerminal, status: 'failed', attempts: 6, createdAt: now, alertEventId,
      })
      return { org, oldTerminal, alertEventId, webhookId }
    })

    await t.action(internal.retention.enforceRetention, {})

    expect(await t.run((ctx) => ctx.db.get(oldTerminal))).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('evals').withIndex('by_run', (q) => q.eq('runId', oldTerminal)).collect())).toHaveLength(0)
    expect(await t.run((ctx) => ctx.db.get(alertEventId))).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('email_deliveries').withIndex('by_alert_event', (q) => q.eq('alertEventId', alertEventId)).collect())).toHaveLength(0)
    expect(await t.run((ctx) => ctx.db.query('webhook_deliveries').withIndex('by_run', (q) => q.eq('runId', oldTerminal)).collect())).toHaveLength(0)
    // The webhook target itself and the org are untouched — retention deletes
    // only the run and its dependents, never the org's standing config.
    expect(await t.run((ctx) => ctx.db.get(webhookId))).not.toBeNull()
    expect(await t.run((ctx) => ctx.db.get(org))).not.toBeNull()
  })
})

describe('Artifact GC — reworked orphan semantics', () => {
  async function seedGc(t: ReturnType<typeof convexTest>, opts: {
    runStatus: string
    ageMs: number
    eventReferenced?: boolean
  }) {
    return await t.run(async (ctx) => {
      const now = Date.now()
      const org = await ctx.db.insert('organizations', {
        clerkOrgId: `clerk_gc_${Math.random()}`, name: 'G', slug: 'g', plan: 'free', createdAt: now, updatedAt: now,
      })
      const project = await ctx.db.insert('projects', { orgId: org, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
      const agent = await ctx.db.insert('agents', { orgId: org, projectId: project, name: 'A', slug: 'a', createdAt: now, updatedAt: now })
      const run = await ctx.db.insert('runs', {
        orgId: org, projectId: project, agentId: agent, status: opts.runStatus as any, startedAt: now - opts.ageMs, metadata: {}, tags: [],
      })
      const artifact = await ctx.db.insert('artifacts', {
        runId: run, orgId: org, eventId: undefined, name: 'a', mimeType: 'text/plain', size: 1,
        storageKey: `k${Math.random()}`, storageBucket: 'b', checksum: `c${Math.random()}`, createdAt: now - opts.ageMs,
      })
      if (opts.eventReferenced) {
        await ctx.db.insert('events', {
          runId: run, orgId: org, type: 'llm.response', sequenceNumber: 1, timestamp: now,
          payload: { type: '_externalized', originalType: 'llm.response', _artifact: { artifactId: String(artifact), storageKey: 'k', storageBucket: 'b', checksum: 'c', size: 1 } },
        })
      }
      return { artifact }
    })
  }

  it('COLLECTS a dangling run-level artifact older than 24h on a terminal run', async () => {
    const t = convexTest(schema, modules)
    const { artifact } = await seedGc(t, { runStatus: 'completed', ageMs: 25 * 60 * 60 * 1000 })
    await t.action(internal.artifact_gc.cleanOrphanedArtifacts, {})
    expect(await t.run((ctx) => ctx.db.get(artifact))).toBeNull()
  })

  it('does NOT collect a fresh run-level artifact (younger than 24h)', async () => {
    const t = convexTest(schema, modules)
    const { artifact } = await seedGc(t, { runStatus: 'completed', ageMs: 60 * 60 * 1000 })
    await t.action(internal.artifact_gc.cleanOrphanedArtifacts, {})
    expect(await t.run((ctx) => ctx.db.get(artifact))).not.toBeNull()
  })

  it('does NOT collect a run-level artifact on a still-running run', async () => {
    const t = convexTest(schema, modules)
    const { artifact } = await seedGc(t, { runStatus: 'running', ageMs: 25 * 60 * 60 * 1000 })
    await t.action(internal.artifact_gc.cleanOrphanedArtifacts, {})
    expect(await t.run((ctx) => ctx.db.get(artifact))).not.toBeNull()
  })

  it('does NOT collect an artifact referenced by an _externalized event pointer', async () => {
    const t = convexTest(schema, modules)
    const { artifact } = await seedGc(t, { runStatus: 'completed', ageMs: 25 * 60 * 60 * 1000, eventReferenced: true })
    await t.action(internal.artifact_gc.cleanOrphanedArtifacts, {})
    expect(await t.run((ctx) => ctx.db.get(artifact))).not.toBeNull()
  })
})

describe('Write ceilings', () => {
  it('rejects an event whose sequenceNumber exceeds MAX_EVENTS_PER_RUN (sdk path)', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedFullOrg(t, 'ceil', { runStatus: 'running' })
    // Simulate a run at the ceiling: last stored sequence == MAX.
    await t.run(async (ctx) => {
      const r = (await ctx.db.get(run))!
      await ctx.db.insert('events', {
        runId: run, orgId: r.orgId, type: 'tool.call', sequenceNumber: MAX_EVENTS_PER_RUN, timestamp: Date.now(), payload: {},
      })
    })
    await expect(
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: 'hash_ceil',
        events: [{ runId: run, type: 'tool.call', sequenceNumber: MAX_EVENTS_PER_RUN + 1, timestamp: Date.now(), payload: {} }],
      }),
    ).rejects.toThrow(/EVENT_LIMIT_EXCEEDED/)
  })

  it('rejects an over-ceiling sequenceNumber on the authenticated createEvent path', async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedFullOrg(t, 'ceil2', { runStatus: 'running' })
    await t.run(async (ctx) => {
      const r = (await ctx.db.get(run))!
      await ctx.db.insert('events', {
        runId: run, orgId: r.orgId, type: 'tool.call', sequenceNumber: MAX_EVENTS_PER_RUN, timestamp: Date.now(), payload: {},
      })
    })
    const asAdmin = t.withIdentity({ subject: 'admin_ceil2', org_id: 'clerk_ceil2' })
    await expect(
      asAdmin.mutation(api.events.createEvent, {
        runId: run, type: 'tool.call', sequenceNumber: MAX_EVENTS_PER_RUN + 1, timestamp: Date.now(), payload: {},
      }),
    ).rejects.toThrow(/EVENT_LIMIT_EXCEEDED/)
  })

  it('createApiKey defaults rateLimitPerMin when unspecified, keeps explicit override', async () => {
    const t = convexTest(schema, modules)
    const { org } = await seedOrg(t, 'rl')
    const asAdmin = t.withIdentity(identity('admin', 'rl'))
    const defaulted = await asAdmin.mutation(api.api_keys.createApiKey, { orgId: org, name: 'd', keyHash: 'hd' })
    expect(defaulted.rateLimitPerMin).toBe(DEFAULT_RATE_LIMIT_PER_MIN)
    const explicit = await asAdmin.mutation(api.api_keys.createApiKey, {
      orgId: org, name: 'e', keyHash: 'he', rateLimitPerMin: 42,
    })
    expect(explicit.rateLimitPerMin).toBe(42)
  })

  it('AUDIT FIX (cycle 5): createApiKey rejects an empty scopes array', async () => {
    const t = convexTest(schema, modules)
    const { org } = await seedOrg(t, 'esc')
    const asAdmin = t.withIdentity(identity('admin', 'esc'))
    // Mirrors the web layer's resolveRequestedScopes (apps/web/src/lib/
    // apiKeyScopes.ts), which rejects `scopes: []` for the same reason: a
    // direct-mutation caller (bypassing the Next.js route) must not be able
    // to mint a scopeless key just because it skipped that layer's check.
    await expect(
      asAdmin.mutation(api.api_keys.createApiKey, { orgId: org, name: 'empty', keyHash: 'he2', scopes: [] }),
    ).rejects.toThrow(/scopes must not be empty/i)

    // Omitting scopes entirely is still the documented "full access" default.
    const defaulted = await asAdmin.mutation(api.api_keys.createApiKey, { orgId: org, name: 'ok', keyHash: 'he3' })
    expect(defaulted.scopes).toBeUndefined()
  })
})

describe('listRuns cross-org filter validation (P2)', () => {
  it('rejects an agentId/projectId belonging to another org', async () => {
    const t = convexTest(schema, modules)
    const { org: orgA } = await seedFullOrg(t, 'lr_a')
    const { agent: agentB, project: projectB } = await seedFullOrg(t, 'lr_b')
    const asA = t.withIdentity({ subject: 'admin_lr_a', org_id: 'clerk_lr_a' })
    await expect(
      asA.query(api.runs.listRuns, { orgId: orgA, agentId: agentB }),
    ).rejects.toThrow(/not found in this organization/i)
    await expect(
      asA.query(api.runs.listRuns, { orgId: orgA, projectId: projectB }),
    ).rejects.toThrow(/not found in this organization/i)
  })

  // AUDIT FIX (cycle 4): when `agentId` was supplied, listRuns selected
  // by_agent_started and silently dropped `status` entirely —
  // `agentId=X&status=failed` used to return ALL of agent X's runs, not
  // just its failed ones, with no error.
  it('combined agentId + status narrows correctly (previously status was silently dropped)', async () => {
    const t = convexTest(schema, modules)
    const { org, project, agent, run: completedRun } = await seedFullOrg(t, 'lr_status')
    const failedRun = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert('runs', {
        orgId: org, projectId: project, agentId: agent, status: 'failed', startedAt: now, endedAt: now, metadata: {}, tags: [],
      })
    })
    const asAdmin = t.withIdentity({ subject: 'admin_lr_status', org_id: 'clerk_lr_status' })

    const page = await asAdmin.query(api.runs.listRuns, { orgId: org, agentId: agent, status: 'failed' })
    const ids = page.runs.map((r) => r._id)
    expect(ids).toContain(failedRun)
    expect(ids).not.toContain(completedRun)
  })
})

describe('Read-path auth (folded in from tests/unit/read_path_auth.test.ts)', () => {
  it("org B's member cannot list comments on org A's run via listComments", async () => {
    const t = convexTest(schema, modules)
    const { run } = await seedFullOrg(t, 'rp_a')
    const { org: orgB } = await seedFullOrg(t, 'rp_b')
    const asB = t.withIdentity({ subject: 'admin_rp_b', org_id: 'clerk_rp_b' })
    // Passing org A's id fails membership; passing their own org returns nothing
    // (the query filters by orgId), so cross-org comments can never leak.
    const { org: orgA } = await t.run(async (ctx) => {
      const r = (await ctx.db.get(run))!
      return { org: r.orgId }
    })
    await expect(
      asB.query(api.comments.listComments, { orgId: orgA, targetId: run as string, targetType: 'run' }),
    ).rejects.toThrow(/Unauthorized|not a member/i)
    const leaked = await asB.query(api.comments.listComments, { orgId: orgB, targetId: run as string, targetType: 'run' })
    expect(leaked).toHaveLength(0)
  })

  it('an unauthenticated caller cannot list comments at all', async () => {
    const t = convexTest(schema, modules)
    const { org, run } = await seedFullOrg(t, 'rp_c')
    await expect(
      t.query(api.comments.listComments, { orgId: org, targetId: run as string, targetType: 'run' }),
    ).rejects.toThrow(/Unauthorized/i)
  })
})
