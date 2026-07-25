/* eslint-disable */
// Tests for convex/read_api.ts's apiGetExplanation — the key-authed (read
// scope) counterpart to run_explanations.getRunExplanation, added at the
// ADR-004 reconciliation between Cycle 1 (run explanations) and Cycle 2 (the
// key-authed read API). Covers: read-scope enforcement, org scoping (cross-
// org run => "not found", never leaking another org's explanation), and the
// null-explanation shapes (completed run; failed run with no explanation
// generated yet).
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

async function seedTwoOrgs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const orgA = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_a', name: 'Org A', slug: 'org-a', plan: 'free', createdAt: now, updatedAt: now })
    const orgB = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_b', name: 'Org B', slug: 'org-b', plan: 'free', createdAt: now, updatedAt: now })

    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const projectB = await ctx.db.insert('projects', { orgId: orgB, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent A', slug: 'a', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projectB, name: 'Agent B', slug: 'b', createdAt: now, updatedAt: now })

    return { orgA, orgB, projectA, projectB, agentA, agentB }
  })
}

async function seedRun(
  t: ReturnType<typeof convexTest>,
  orgId: any,
  projectId: any,
  agentId: any,
  status: 'failed' | 'completed' = 'failed',
) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    return await ctx.db.insert('runs', {
      orgId, projectId, agentId, status, startedAt: now - 1000, endedAt: now, metadata: {}, tags: [],
    })
  })
}

async function seedExplanation(t: ReturnType<typeof convexTest>, orgId: any, runId: any, summary = 'It failed.') {
  await t.run(async (ctx) => {
    await ctx.db.insert('run_explanations', {
      orgId, runId, kind: 'heuristic', summary, rootCause: 'Root cause.',
      citedSequenceNumbers: [1], failureClass: 'llm_error', generatedAt: Date.now(), version: 1,
    })
  })
}

describe('read_api.apiGetExplanation', () => {
  it('a read-scoped key gets the explanation for its own org\'s failed run', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
    const runId = await seedRun(t, orgA, projectA, agentA, 'failed')
    await seedExplanation(t, orgA, runId, 'The LLM call timed out.')

    const result = await t.mutation(api.read_api.apiGetExplanation, { apiKeyHash: 'read_key', runId: String(runId) })
    expect(result.status).toBe('ready')
    expect(result.explanation).not.toBeNull()
    expect(result.explanation.summary).toBe('The LLM call timed out.')
    expect(result.explanation.failureClass).toBe('llm_error')
  })

  it('an ingest-only key (no "read" scope) is rejected', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'ingest_only', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['ingest:write'] })
    })
    const runId = await seedRun(t, orgA, projectA, agentA, 'failed')
    await seedExplanation(t, orgA, runId)

    await expect(
      t.mutation(api.read_api.apiGetExplanation, { apiKeyHash: 'ingest_only', runId: String(runId) }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('a cross-org run returns "not found" rather than the explanation', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key_a', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
    const runInOrgB = await seedRun(t, orgB, projectB, agentB, 'failed')
    await seedExplanation(t, orgB, runInOrgB, 'Org B secret failure detail.')

    await expect(
      t.mutation(api.read_api.apiGetExplanation, { apiKeyHash: 'read_key_a', runId: String(runInOrgB) }),
    ).rejects.toThrow(/not found/i)
  })

  it('a completed run returns { explanation: null }', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    // Even if a stray explanation row somehow existed for it, a completed run must never surface one.
    await seedExplanation(t, orgA, runId, 'Should never be returned.')

    const result = await t.mutation(api.read_api.apiGetExplanation, { apiKeyHash: 'read_key', runId: String(runId) })
    expect(result.status).toBe('not_eligible')
    expect(result.explanation).toBeNull()
    expect(result.runStatus).toBe('completed')
  })

  it('a failed run with no explanation generated yet returns status "pending", distinct from "not_eligible"', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
    const runId = await seedRun(t, orgA, projectA, agentA, 'failed')

    const result = await t.mutation(api.read_api.apiGetExplanation, { apiKeyHash: 'read_key', runId: String(runId) })
    expect(result.status).toBe('pending')
    expect(result.explanation).toBeNull()
    expect(result.runStatus).toBe('failed')
  })
})

// Tests for apiGetRunEvents' `fromSequence` WINDOW floor — the range read on
// the EXISTING `by_run: ["runId", "sequenceNumber"]` index (convex/schema.ts)
// that lets a caller land on a deep sequence number without paging through
// everything before it. Covers: the floor is genuinely honored (an
// accept-and-ignore implementation is indistinguishable from a window that
// legitimately starts at 1, and the SDK's getRunEventWindow throws on that
// ambiguity rather than return a wrong answer); a floor past the end is an
// empty page, not an error; malformed floors are rejected, not coerced; and
// the param opens no existence oracle across orgs.
describe('read_api.apiGetRunEvents — fromSequence window', () => {
  async function seedReadKeyNamed(t: ReturnType<typeof convexTest>, orgId: any, keyHash: string) {
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId, keyHash, name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
  }

  /** Seeds `count` contiguous events (sequence 1..count) for a run, per Event Log Rule 4. */
  async function seedEvents(t: ReturnType<typeof convexTest>, orgId: any, runId: any, count: number) {
    await t.run(async (ctx) => {
      const base = Date.now() - count * 10
      for (let i = 1; i <= count; i++) {
        await ctx.db.insert('events', {
          runId, orgId, type: i === 1 ? 'RUN_STARTED' : 'LLM_CALL', sequenceNumber: i,
          timestamp: base + i * 10, payload: { i },
        })
      }
    })
  }

  it('omitting fromSequence still returns the head of the log (unchanged behavior)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEvents(t, orgA, runId, 40)

    const result = await t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), limit: 5 })
    expect(result.events.map((e: any) => e.sequenceNumber)).toEqual([1, 2, 3, 4, 5])
  })

  it('fromSequence starts the page AT the floor, not at the head of the log', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEvents(t, orgA, runId, 40)

    const result = await t.mutation(api.read_api.apiGetRunEvents, {
      apiKeyHash: 'read_key', runId: String(runId), fromSequence: 30, limit: 5,
    })
    // The exact assertion an accept-and-ignore server fails: the FIRST event
    // is the floor, and nothing below the floor appears anywhere in the page.
    expect(result.events.map((e: any) => e.sequenceNumber)).toEqual([30, 31, 32, 33, 34])
    expect(result.events.every((e: any) => e.sequenceNumber >= 30)).toBe(true)
  })

  it('fromSequence: 1 is exactly equivalent to omitting it', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEvents(t, orgA, runId, 10)

    const withFloor = await t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), fromSequence: 1 })
    const without = await t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId) })
    expect(withFloor.events.map((e: any) => e._id)).toEqual(without.events.map((e: any) => e._id))
  })

  it('a fromSequence past the end of the run is an EMPTY page, not an error', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEvents(t, orgA, runId, 10)

    const result = await t.mutation(api.read_api.apiGetRunEvents, {
      apiKeyHash: 'read_key', runId: String(runId), fromSequence: 5000,
    })
    expect(result.events).toEqual([])
    expect(result.nextCursor).toBeUndefined()
  })

  it('a run with no events at all yields an empty page for any floor', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')

    const result = await t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), fromSequence: 3 })
    expect(result.events).toEqual([])
  })

  it('cursor pagination WITHIN a window never falls back below the floor', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEvents(t, orgA, runId, 40)

    const first = await t.mutation(api.read_api.apiGetRunEvents, {
      apiKeyHash: 'read_key', runId: String(runId), fromSequence: 20, limit: 5,
    })
    expect(first.events.map((e: any) => e.sequenceNumber)).toEqual([20, 21, 22, 23, 24])
    expect(first.nextCursor).toBeDefined()

    const second = await t.mutation(api.read_api.apiGetRunEvents, {
      apiKeyHash: 'read_key', runId: String(runId), fromSequence: 20, limit: 5, cursor: first.nextCursor,
    })
    expect(second.events.map((e: any) => e.sequenceNumber)).toEqual([25, 26, 27, 28, 29])
  })

  it('rejects a malformed floor rather than coercing it to a different window', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEvents(t, orgA, runId, 10)

    for (const bad of [0, -1, 2.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), fromSequence: bad }),
      ).rejects.toThrow(/INVALID_ARGUMENT/)
    }
  })

  it('an ingest-only key (no "read" scope) is rejected even with a window floor', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'ingest_only', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['ingest:write'] })
    })
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEvents(t, orgA, runId, 5)

    await expect(
      t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'ingest_only', runId: String(runId), fromSequence: 2 }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('never returns another org\'s events through the window', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key_a')
    const runInOrgB = await seedRun(t, orgB, projectB, agentB, 'completed')
    await seedEvents(t, orgB, runInOrgB, 40)

    await expect(
      t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key_a', runId: String(runInOrgB), fromSequence: 30 }),
    ).rejects.toThrow(/not found/i)
  })

  /**
   * EXISTENCE-ORACLE GUARD. A new query param is a new opportunity to open
   * one: if an unknown runId and a cross-org runId diverged in ANY observable
   * way, the endpoint would confirm the existence of another org's run. They
   * must be deep-equal, both with and without a floor.
   */
  it('an unknown runId and a cross-org runId are indistinguishable, with and without fromSequence', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedReadKeyNamed(t, orgA, 'read_key_a')

    // A syntactically valid id that resolves to nothing: seeded in the key's
    // own org, then deleted (direct db access, not a product mutation —
    // events remain append-only).
    const danglingRunId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await t.run(async (ctx) => { await ctx.db.delete(danglingRunId) })

    const runInOrgB = await seedRun(t, orgB, projectB, agentB, 'completed')
    await seedEvents(t, orgB, runInOrgB, 40)

    async function outcome(runId: string, fromSequence?: number) {
      try {
        return { ok: true, value: await t.mutation(api.read_api.apiGetRunEvents, {
          apiKeyHash: 'read_key_a', runId, ...(fromSequence !== undefined && { fromSequence }),
        }) }
      } catch (err: any) {
        // Normalize away anything id- or frame-specific so the comparison is
        // about the OBSERVABLE difference, not incidental formatting.
        return { ok: false, message: String(err?.message ?? err).split('\n')[0] }
      }
    }

    expect(await outcome(String(danglingRunId))).toEqual(await outcome(String(runInOrgB)))
    expect(await outcome(String(danglingRunId), 30)).toEqual(await outcome(String(runInOrgB), 30))
    // And a floor past the end of the (real, other-org) run must not become a
    // quiet empty page for one and an error for the other.
    expect(await outcome(String(danglingRunId), 5000)).toEqual(await outcome(String(runInOrgB), 5000))
  })
})

// Tests for apiListFailurePatterns — the key-authed (read scope) counterpart
// to the Failure Patterns rollup (PREVENTION cycle 1). Covers: read-scope
// enforcement (implicitly, via resolveReadApiKey being shared code already
// covered above), org scoping (cross-org patterns never leak), the empty
// case, and the --agent filter narrowing by affectedAgentVersionIds.
describe('read_api.apiListFailurePatterns', () => {
  async function seedPattern(
    t: ReturnType<typeof convexTest>,
    orgId: any,
    fingerprintHash: string,
    opts: {
      affectedAgentVersionIds?: any[];
      lastSeenAt?: number;
      lastSpikeAssessment?: { assessedAt: number; isSpiking: boolean; recentCount: number; baselineMean: number; z: number };
      muted?: boolean;
      status?: 'open' | 'acknowledged' | 'resolved';
      regressedAt?: number;
      resolvedAt?: number;
      resolvedAtOccurrenceCount?: number;
      lastFixConfidence?: any;
    } = {},
  ) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('failure_patterns', {
        orgId,
        fingerprintHash,
        class: 'tool_error',
        label: `Pattern ${fingerprintHash}`,
        salientKey: 'some_tool',
        count: 3,
        firstSeenAt: now - 10_000,
        lastSeenAt: opts.lastSeenAt ?? now,
        representativeRunIds: [],
        affectedAgentVersionIds: opts.affectedAgentVersionIds ?? [],
        ...(opts.lastSpikeAssessment !== undefined && { lastSpikeAssessment: opts.lastSpikeAssessment }),
        ...(opts.muted !== undefined && { muted: opts.muted }),
        ...(opts.status !== undefined && { status: opts.status }),
        ...(opts.regressedAt !== undefined && { regressedAt: opts.regressedAt }),
        ...(opts.resolvedAt !== undefined && { resolvedAt: opts.resolvedAt }),
        ...(opts.resolvedAtOccurrenceCount !== undefined && {
          resolvedAtOccurrenceCount: opts.resolvedAtOccurrenceCount,
        }),
        ...(opts.lastFixConfidence !== undefined && { lastFixConfidence: opts.lastFixConfidence }),
      });
    });
  }

  /** A usable fix-confidence snapshot for a pattern resolved at `resolvedAt`. */
  function snapshot(
    state: 'unproven' | 'proving' | 'confirmed' | 'regressed',
    resolvedAt: number,
    computedAt: number,
    score = 0.5,
  ) {
    return {
      computedAt,
      basisResolvedAt: resolvedAt,
      state,
      score,
      exposureRuns: 20,
      observedRuns: 20,
      exposureTruncated: false,
      versionAttribution: 'unknown' as const,
      recurred: state === 'regressed',
      limitingFactor: state === 'confirmed' ? ('none' as const) : ('accumulating' as const),
    };
  }

  it('a read-scoped key gets its own org\'s patterns, most-recently-seen first', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_old', { lastSeenAt: Date.now() - 5000 });
    await seedPattern(t, orgA, 'fp_new', { lastSeenAt: Date.now() });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key' });
    expect(result.patterns).toHaveLength(2);
    expect(result.patterns[0].fingerprintHash).toBe('fp_new');
    expect(result.patterns[1].fingerprintHash).toBe('fp_old');
  });

  it('an ingest-only key (no "read" scope) is rejected', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'ingest_only', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['ingest:write'] });
    });
    await seedPattern(t, orgA, 'fp_1');

    await expect(
      t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'ingest_only' }),
    ).rejects.toThrow(/Forbidden/);
  });

  it('never returns another org\'s patterns', async () => {
    const t = convexTest(schema, modules);
    const { orgA, orgB } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key_a', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgB, 'fp_org_b_secret');

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key_a' });
    expect(result.patterns).toHaveLength(0);
  });

  it('returns an empty list (not an error) when the org has no patterns yet', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key' });
    expect(result.patterns).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('--agent filter narrows to patterns affecting that agent\'s versions only', async () => {
    const t = convexTest(schema, modules);
    const { orgA, projectA, agentA } = await seedTwoOrgs(t);
    const otherAgent = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Other Agent', slug: 'other', createdAt: now, updatedAt: now });
    });
    const [versionForAgentA, versionForOtherAgent] = await t.run(async (ctx) => {
      const now = Date.now();
      const v1 = await ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: '1', createdAt: now });
      const v2 = await ctx.db.insert('agent_versions', { agentId: otherAgent, orgId: orgA, version: '1', createdAt: now });
      return [v1, v2];
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_agent_a', { affectedAgentVersionIds: [versionForAgentA] });
    await seedPattern(t, orgA, 'fp_other_agent', { affectedAgentVersionIds: [versionForOtherAgent] });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key',
      agentId: String(agentA),
    });
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].fingerprintHash).toBe('fp_agent_a');
  });

  it('rejects an --agent filter naming an agent from a different org', async () => {
    const t = convexTest(schema, modules);
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key_a', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });

    await expect(
      t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key_a', agentId: String(agentB) }),
    ).rejects.toThrow(/not found/i);
  });

  it('--spiking narrows to patterns whose lastSpikeAssessment.isSpiking is true (PREVENTION cycle 2)', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_spiking', {
      lastSpikeAssessment: { assessedAt: Date.now(), isSpiking: true, recentCount: 9, baselineMean: 1.2, z: 4.1 },
    });
    await seedPattern(t, orgA, 'fp_not_spiking', {
      lastSpikeAssessment: { assessedAt: Date.now(), isSpiking: false, recentCount: 1, baselineMean: 1.1, z: 0.2 },
    });
    await seedPattern(t, orgA, 'fp_no_assessment');

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', spiking: true });
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].fingerprintHash).toBe('fp_spiking');
  });

  it('spiking:false (or omitted) returns all patterns regardless of spike status', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_spiking', {
      lastSpikeAssessment: { assessedAt: Date.now(), isSpiking: true, recentCount: 9, baselineMean: 1.2, z: 4.1 },
    });
    await seedPattern(t, orgA, 'fp_not_spiking');

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', spiking: false });
    expect(result.patterns).toHaveLength(2);
  });

  it('--spiking composes with --agent (both filters applied)', async () => {
    const t = convexTest(schema, modules);
    const { orgA, projectA, agentA } = await seedTwoOrgs(t);
    const [versionForAgentA] = await t.run(async (ctx) => {
      const now = Date.now();
      const v1 = await ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: '1', createdAt: now });
      return [v1];
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_agent_a_spiking', {
      affectedAgentVersionIds: [versionForAgentA],
      lastSpikeAssessment: { assessedAt: Date.now(), isSpiking: true, recentCount: 9, baselineMean: 1.2, z: 4.1 },
    });
    await seedPattern(t, orgA, 'fp_agent_a_not_spiking', { affectedAgentVersionIds: [versionForAgentA] });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key',
      agentId: String(agentA),
      spiking: true,
    });
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].fingerprintHash).toBe('fp_agent_a_spiking');
  });

  // Resolution cycle 1 (docs/adr/006-failure-resolution.md, "resolution
  // reflection") — same overfetch-then-filter, read-side-only posture as
  // --spiking/--muted above.
  it('--status narrows to patterns with an exact lifecycle status match', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_resolved', { status: 'resolved' });
    await seedPattern(t, orgA, 'fp_acknowledged', { status: 'acknowledged' });
    await seedPattern(t, orgA, 'fp_open_explicit', { status: 'open' });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', status: 'resolved' });
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].fingerprintHash).toBe('fp_resolved');
  });

  it('--status open matches patterns with no status field set (absent means open)', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_no_status_field');
    await seedPattern(t, orgA, 'fp_resolved', { status: 'resolved' });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', status: 'open' });
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].fingerprintHash).toBe('fp_no_status_field');
  });

  it('omitting --status returns patterns of every lifecycle status', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_open');
    await seedPattern(t, orgA, 'fp_resolved', { status: 'resolved' });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key' });
    expect(result.patterns).toHaveLength(2);
  });

  it('--regressed narrows to patterns with regressedAt set', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_regressed', { status: 'open', regressedAt: Date.now() });
    await seedPattern(t, orgA, 'fp_not_regressed', { status: 'open' });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', regressed: true });
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].fingerprintHash).toBe('fp_regressed');
  });

  it('omitting --regressed returns patterns regardless of regression state', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_regressed', { regressedAt: Date.now() });
    await seedPattern(t, orgA, 'fp_not_regressed');

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key' });
    expect(result.patterns).toHaveLength(2);
  });

  it('--status and --agent compose (both filters applied)', async () => {
    const t = convexTest(schema, modules);
    const { orgA, projectA, agentA } = await seedTwoOrgs(t);
    const [versionForAgentA] = await t.run(async (ctx) => {
      const now = Date.now();
      const v1 = await ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: '1', createdAt: now });
      return [v1];
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
    await seedPattern(t, orgA, 'fp_agent_a_resolved', {
      affectedAgentVersionIds: [versionForAgentA],
      status: 'resolved',
    });
    await seedPattern(t, orgA, 'fp_agent_a_open', { affectedAgentVersionIds: [versionForAgentA] });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key',
      agentId: String(agentA),
      status: 'resolved',
    });
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].fingerprintHash).toBe('fp_agent_a_resolved');
  });

  // -------------------------------------------------------------------------
  // ADR-006 cycle 3 — the `--state` filter, served off the stored
  // `lastFixConfidence` snapshot. Cycle 2 could only answer "regressed";
  // all four are answerable now.
  // -------------------------------------------------------------------------

  async function seedReadKey(t: ReturnType<typeof convexTest>, orgId: any) {
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] });
    });
  }

  it('--state confirmed is answered off the snapshot (no longer a 422)', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    const now = Date.now();
    await seedPattern(t, orgA, 'fp_confirmed', {
      status: 'resolved', resolvedAt: now - 1000, lastFixConfidence: snapshot('confirmed', now - 1000, now, 0.82),
    });
    await seedPattern(t, orgA, 'fp_proving', {
      status: 'resolved', resolvedAt: now - 1000, lastFixConfidence: snapshot('proving', now - 1000, now, 0.31),
    });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'confirmed' });
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].fingerprintHash).toBe('fp_confirmed');
    expect(result.fixConfidence.entries[0].state).toBe('confirmed');
    expect(result.fixConfidence.entries[0].basis).toBe('snapshot');
    expect(result.fixConfidence.entries[0].stale).toBe(false);
  });

  it('--state unproven and --state proving each select only their own snapshot state', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    const now = Date.now();
    const r = now - 1000;
    await seedPattern(t, orgA, 'fp_unproven', { status: 'resolved', resolvedAt: r, lastFixConfidence: snapshot('unproven', r, now, 0) });
    await seedPattern(t, orgA, 'fp_proving', { status: 'resolved', resolvedAt: r, lastFixConfidence: snapshot('proving', r, now, 0.3) });
    await seedPattern(t, orgA, 'fp_confirmed', { status: 'resolved', resolvedAt: r, lastFixConfidence: snapshot('confirmed', r, now, 0.9) });

    const unproven = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'unproven' });
    expect(unproven.patterns.map((p: any) => p.fingerprintHash)).toEqual(['fp_unproven']);

    const proving = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'proving' });
    expect(proving.patterns.map((p: any) => p.fingerprintHash)).toEqual(['fp_proving']);
  });

  it('a never-resolved pattern matches no --state value and is not reported as unevaluated', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    await seedPattern(t, orgA, 'fp_never_resolved');

    for (const state of ['unproven', 'proving', 'confirmed', 'regressed'] as const) {
      const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state });
      expect(result.patterns).toHaveLength(0);
      expect(result.fixConfidence.unevaluated).toEqual([]);
    }
  });

  it('a resolved pattern with NO snapshot is reported in unevaluated, never silently treated as "not matching"', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    const now = Date.now();
    await seedPattern(t, orgA, 'fp_legacy_resolved', { status: 'resolved', resolvedAt: now - 5000 });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'confirmed' });
    expect(result.patterns).toHaveLength(0);
    expect(result.fixConfidence.unevaluated).toEqual(['fp_legacy_resolved']);
  });

  it('a snapshot describing a SUPERSEDED resolution episode is discarded, not served', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    const now = Date.now();
    // Snapshot says "confirmed", but it was computed against an EARLIER
    // resolvedAt — the pattern has since been reopened and re-resolved. The
    // old verdict is about a different question and must not answer this one.
    await seedPattern(t, orgA, 'fp_re_resolved', {
      status: 'resolved',
      resolvedAt: now - 1000,
      lastFixConfidence: snapshot('confirmed', now - 999_999, now, 0.9),
    });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'confirmed' });
    expect(result.patterns).toHaveLength(0);
    expect(result.fixConfidence.unevaluated).toEqual(['fp_re_resolved']);
  });

  it('a snapshot older than the staleness bound is still SERVED but flagged stale', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    const now = Date.now();
    const r = now - 100_000;
    const staleComputedAt = now - (7 * 60 * 60 * 1000); // 7h > the 6h bound

    await seedPattern(t, orgA, 'fp_stale_confirmed', {
      status: 'resolved', resolvedAt: r, lastFixConfidence: snapshot('confirmed', r, staleComputedAt, 0.8),
    });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'confirmed' });
    // Served, not dropped — dropping would be a silent lie by omission.
    expect(result.patterns).toHaveLength(1);
    const entry = result.fixConfidence.entries[0];
    expect(entry.stale).toBe(true);
    expect(entry.ageMs).toBeGreaterThan(result.fixConfidence.stalenessBoundMs);
    expect(result.fixConfidence.staleCount).toBe(1);
  });

  it('--state regressed keeps its exact, snapshot-free path (works with no snapshot at all)', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    const now = Date.now();
    // Regressed strictly after the live resolution, and never snapshotted.
    await seedPattern(t, orgA, 'fp_regressed_no_snapshot', {
      status: 'open', resolvedAt: now - 10_000, regressedAt: now - 5000,
    });
    // regressedAt PREDATES the current resolution — re-fixed, so not regressed.
    await seedPattern(t, orgA, 'fp_refixed', {
      status: 'resolved', resolvedAt: now - 1000, regressedAt: now - 50_000,
    });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'regressed' });
    expect(result.patterns.map((p: any) => p.fingerprintHash)).toEqual(['fp_regressed_no_snapshot']);
  });

  it('omitting --state still returns every pattern, with a confidence entry for each', async () => {
    const t = convexTest(schema, modules);
    const { orgA } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    const now = Date.now();
    await seedPattern(t, orgA, 'fp_a', { status: 'resolved', resolvedAt: now - 1, lastFixConfidence: snapshot('proving', now - 1, now) });
    await seedPattern(t, orgA, 'fp_b');

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key' });
    expect(result.patterns).toHaveLength(2);
    expect(result.fixConfidence.entries).toHaveLength(2);
    const byHash = Object.fromEntries(result.fixConfidence.entries.map((e: any) => [e.fingerprintHash, e]));
    expect(byHash['fp_a'].basis).toBe('snapshot');
    expect(byHash['fp_b'].basis).toBe('none');
    expect(byHash['fp_b'].state).toBeNull();
  });

  it('the --state filter never crosses org boundaries', async () => {
    const t = convexTest(schema, modules);
    const { orgA, orgB } = await seedTwoOrgs(t);
    await seedReadKey(t, orgA);
    const now = Date.now();
    await seedPattern(t, orgB, 'fp_org_b_confirmed', {
      status: 'resolved', resolvedAt: now - 1, lastFixConfidence: snapshot('confirmed', now - 1, now, 0.9),
    });

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'confirmed' });
    expect(result.patterns).toHaveLength(0);
  });
})
