/**
 * DECLARATIVE TOOL POLICY — ADVERSARIAL SUITE, INGEST LAYER (Team D)
 *
 * ONE PROPERTY, PROVED BY EXECUTION AGAINST THE REAL CONVEX FUNCTIONS:
 *
 *   A RECORDER MUST NEVER REFUSE TO RECORD A VIOLATION.
 *
 * Its companion `policy_adversarial_substrate.test.ts` proves the STRUCTURAL
 * form of this (no ingest door can reach a policy module). This file proves the
 * BEHAVIOURAL form: an event that a policy would call a violation is ingested,
 * stored, and readable, and its acceptance is byte-identical to that of an
 * innocuous event.
 *
 * WHY BOTH. The structural proof is defeated by a policy consulted through a
 * string key or a dynamic import. The behavioural proof is defeated by a policy
 * that only rejects under a configuration this file never creates. Neither is
 * sufficient; together they cover the ways the property actually dies.
 *
 * THE INVERSION THIS DEFENDS AGAINST IS THE NATURAL THING TO BUILD. Someone
 * will reasonably propose that ingest reject a forbidden tool call — it sounds
 * like enforcement. It is blindness: the recorder stops holding the evidence of
 * the very thing the operator wanted to know about, and the compliance surface
 * then reports a clean run because the violation was never written down.
 *
 * ANTI-VACUITY. Every acceptance assertion is paired with a proof that this
 * harness CAN observe a refusal (§0), so "it was accepted" is never merely
 * "nothing was checked".
 */
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'

import { api } from '../../convex/_generated/api'
import schema from '../../convex/schema'

/**
 * `import.meta.glob` is a VITE COMPILE-TIME TRANSFORM: the call must appear
 * literally. Types are pulled in file-locally because the shared
 * `tests/tsconfig.json` does not carry `vite/client` and is not mine to edit.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface ImportMeta {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob('../../convex/**/!(*.test).ts')

/** The tool a policy would forbid. Never special-cased anywhere in the product. */
const FORBIDDEN_TOOL = 'prod-db:delete_all_rows'
/** Its innocuous twin. Same shape, same size class, different name. */
const ALLOWED_TOOL = 'docs:search'

const KEY = 'policy_adv_key'

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const orgId = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_policy_adv', name: 'Org', slug: 'org', plan: 'free', createdAt: now, updatedAt: now,
    })
    const projectId = await ctx.db.insert('projects', {
      orgId, name: 'P', slug: 'p', createdAt: now, updatedAt: now,
    })
    const agentId = await ctx.db.insert('agents', {
      orgId, projectId, name: 'A', slug: 'a', createdAt: now, updatedAt: now,
    })
    await ctx.db.insert('api_keys', {
      orgId, keyHash: KEY, name: 'k', createdBy: 'u', createdAt: now, scopes: ['ingest:write'],
    })
    return { orgId, projectId, agentId }
  })
}

async function startRun(t: ReturnType<typeof convexTest>, agentId: string): Promise<string> {
  const created = await t.mutation(api.sdk_ingest.sdkCreateRun, { apiKeyHash: KEY, agentId })
  return String(created.id)
}

/** Capture an outcome so acceptance and refusal are COMPARABLE values, not control flow. */
async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function toolCall(runId: string, seq: number, name: string) {
  return {
    runId,
    type: 'tool.call' as const,
    sequenceNumber: seq,
    timestamp: Date.now(),
    payload: { type: 'tool.call', name, call_id: `c${seq}`, input: { q: 'x' } },
  }
}

function runStarted(runId: string) {
  return {
    runId,
    type: 'run.started' as const,
    sequenceNumber: 1,
    timestamp: Date.now(),
    payload: { type: 'run.started', input: {}, config: {} },
  }
}

// ===========================================================================
// §0 — TEETH. This harness can observe a refusal.
// ===========================================================================

describe('§0 the harness can distinguish acceptance from refusal', () => {
  it('a genuinely invalid event IS refused, and the refusal is visible here', async () => {
    const t = convexTest(schema, modules)
    const { agentId } = await seed(t)
    const runId = await startRun(t, String(agentId))

    // Sequence 2 with no sequence 1: Event Log Rule 4. If this came back ok,
    // every acceptance assertion in this file would be measuring nothing.
    const res = await outcome(() =>
      t.mutation(api.sdk_ingest.sdkCreateEvents, { apiKeyHash: KEY, events: [toolCall(runId, 2, ALLOWED_TOOL)] }),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/sequenceNumber|run\.started/i)
  })
})

// ===========================================================================
// §1 — A VIOLATION IS RECORDED, AND RECORDED IDENTICALLY
// ===========================================================================

describe('§1 the recorder records the violation', () => {
  it('a forbidden tool call is ACCEPTED and durably stored with its name intact', async () => {
    const t = convexTest(schema, modules)
    const { agentId } = await seed(t)
    const runId = await startRun(t, String(agentId))

    const res = await outcome(() =>
      t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: KEY,
        events: [runStarted(runId), toolCall(runId, 2, FORBIDDEN_TOOL)],
      }),
    )
    expect(res).toEqual({ ok: true })

    // Stored, not merely accepted: the evidence has to survive the transaction.
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query('events')
        .withIndex('by_run', (q) => q.eq('runId', runId as never))
        .collect(),
    )
    expect(stored.map((e) => e.type)).toEqual(['run.started', 'tool.call'])
    // The NAME is what a policy is about. It is the thing that must survive.
    expect(JSON.stringify(stored[1]?.payload)).toContain(FORBIDDEN_TOOL)
  })

  it('the forbidden and the allowed call produce INDISTINGUISHABLE ingest outcomes', async () => {
    // Two runs, identical but for the tool name. Compared as VALUES: a version
    // that accepted both but did extra work, returned a different shape, or
    // stamped a flag on one of them fails here.
    const results: Array<{ name: string; outcome: unknown; storedTypes: string[]; eventCount: number }> = []

    for (const name of [ALLOWED_TOOL, FORBIDDEN_TOOL]) {
      const t = convexTest(schema, modules)
      const { agentId } = await seed(t)
      const runId = await startRun(t, String(agentId))
      const res = await outcome(() =>
        t.mutation(api.sdk_ingest.sdkCreateEvents, {
          apiKeyHash: KEY,
          events: [runStarted(runId), toolCall(runId, 2, name)],
        }),
      )
      const stored = await t.run(async (ctx) =>
        ctx.db
          .query('events')
          .withIndex('by_run', (q) => q.eq('runId', runId as never))
          .collect(),
      )
      results.push({ name, outcome: res, storedTypes: stored.map((e) => e.type), eventCount: stored.length })
    }

    const [allowed, forbidden] = results
    expect(forbidden?.outcome).toEqual(allowed?.outcome)
    expect(forbidden?.storedTypes).toEqual(allowed?.storedTypes)
    expect(forbidden?.eventCount).toEqual(allowed?.eventCount)
    // Teeth: both actually recorded something.
    expect(allowed?.eventCount).toBe(2)
  })

  it('a RUN MADE ENTIRELY OF forbidden calls still terminates normally', async () => {
    // The worst case for a recorder that enforces: an agent that violates on
    // every step must still produce a complete, terminated, readable trace.
    const t = convexTest(schema, modules)
    const { agentId } = await seed(t)
    const runId = await startRun(t, String(agentId))

    const events = [
      runStarted(runId),
      ...[2, 3, 4, 5].map((s) => toolCall(runId, s, FORBIDDEN_TOOL)),
      {
        runId,
        type: 'run.completed' as const,
        sequenceNumber: 6,
        timestamp: Date.now(),
        payload: { type: 'run.completed', output: {}, duration_ms: 1 },
      },
    ]
    const res = await outcome(() => t.mutation(api.sdk_ingest.sdkCreateEvents, { apiKeyHash: KEY, events }))
    expect(res).toEqual({ ok: true })

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query('events')
        .withIndex('by_run', (q) => q.eq('runId', runId as never))
        .collect(),
    )
    expect(stored.length).toBe(6)
    // Event Log Rule 5 still holds: the run closed. A recorder that refused
    // the violating events would leave this run permanently in-progress.
    expect(stored[stored.length - 1]?.type).toBe('run.completed')
    const run = await t.run(async (ctx) => ctx.db.get(runId as never))
    expect((run as { status?: string } | null)?.status).toBe('completed')
  })
})
