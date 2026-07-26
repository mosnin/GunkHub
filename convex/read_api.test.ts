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

// ===========================================================================
// apiListFailurePatterns — FILTER/PAGINATION ORDERING
// ===========================================================================
//
// Regression suite for the silent-empty-page bug: every filter on this
// endpoint is in-memory (none of the fields it reads is indexed), and they all
// used to run over ONE already-paginated page. `numItems` therefore counted
// ROWS EXAMINED rather than rows MATCHED, so a request for N could come back
// with zero matches and a `nextCursor` while matches sat further down.
//
// WHY EVERY ASSERTION BELOW IS EXPLICIT ABOUT COUNTS AND CURSORS. The broken
// behavior does not throw, does not warn, and does not return a malformed
// response — it returns a perfectly well-formed empty page. Nothing catches
// that except a test that seeds matches BEYOND the first batch and then insists
// on seeing them. In particular `--state regressed` is a CI gate ("fail the
// build if a confirmed-fixed pattern regressed"); a false all-clear there turns
// a red build green, which is the single worst failure this endpoint has.
//
// These tests were verified to FAIL against the filter-after-paginate ordering
// before being committed. A test for this class of bug that has never been
// seen red is not a test.
describe('read_api.apiListFailurePatterns — filters are applied BEFORE the page is cut', () => {
  async function seedOrgAndKey(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const orgId = await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_pag', name: 'Org Pag', slug: 'org-pag', plan: 'free', createdAt: now, updatedAt: now,
      });
      await ctx.db.insert('api_keys', {
        orgId, keyHash: 'read_key', name: 'k', createdBy: 'u', createdAt: now, scopes: ['read'],
      });
      return orgId;
    });
  }

  /**
   * Bulk-seed `count` patterns, newest-first by index: index 0 has the most
   * recent `lastSeenAt`, so it is the FIRST row the `by_org_lastSeenAt` desc
   * scan sees. `decorate` receives the index, so a test can place a matching
   * row at a chosen distance down the scan.
   */
  async function seedPatterns(
    t: ReturnType<typeof convexTest>,
    orgId: any,
    count: number,
    decorate: (i: number) => Record<string, unknown> = () => ({}),
  ) {
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < count; i++) {
        await ctx.db.insert('failure_patterns', {
          orgId,
          fingerprintHash: `fp_${String(i).padStart(4, '0')}`,
          class: 'tool_error',
          label: `Pattern ${i}`,
          salientKey: 'some_tool',
          count: 1,
          firstSeenAt: now - 1_000_000,
          lastSeenAt: now - i * 1000,
          representativeRunIds: [],
          affectedAgentVersionIds: [],
          ...decorate(i),
        });
      }
    });
  }

  it('finds a match that sits far past the first batch instead of returning an empty page', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    // 60 patterns; only the LAST one down the scan is muted. With limit 5 the
    // old implementation read rows 0-4, filtered them to nothing, and returned
    // an empty page with a cursor — the match was never reachable in one call.
    await seedPatterns(t, orgId, 60, (i) => (i === 59 ? { muted: true } : {}));

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key', muted: true, limit: 5,
    });

    expect(result.patterns.map((p: any) => p.fingerprintHash)).toEqual(['fp_0059']);
    expect(result.scanTruncated).toBe(false);
  });

  it('CI GATE: --state regressed finds a regression buried past the first batch', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    const now = Date.now();
    // 40 healthy patterns, then one whose fix did NOT hold: it recurred
    // strictly after its resolvedAt. `afr patterns --state regressed` is the
    // build gate; the old ordering answered "all clear" here and shipped the
    // regression.
    await seedPatterns(t, orgId, 41, (i) =>
      i === 40 ? { status: 'resolved' as const, resolvedAt: now - 10_000, regressedAt: now - 5_000 } : {},
    );

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key', state: 'regressed', limit: 5,
    });

    expect(result.patterns.map((p: any) => p.fingerprintHash)).toEqual(['fp_0040']);
    expect(result.scanTruncated).toBe(false);
  });

  it('an empty page means NOTHING MATCHED: no cursor is handed back when the scan is exhausted', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    await seedPatterns(t, orgId, 60); // none spiking

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key', spiking: true, limit: 5,
    });

    expect(result.patterns).toEqual([]);
    // The load-bearing half: the old code returned `[]` WITH a cursor, which is
    // indistinguishable from a genuinely empty result to any caller that does
    // not follow cursors — and `afr patterns` did not.
    expect(result.nextCursor).toBeUndefined();
    expect(result.scanTruncated).toBe(false);
  });

  it('a full page of matches is delivered when matches are sparse across many batches', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    // Every 10th row matches: 8 matches spread over 80 rows. limit 5 means the
    // scan must cross several batches to fill one page.
    await seedPatterns(t, orgId, 80, (i) => (i % 10 === 0 ? { muted: true } : {}));

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key', muted: true, limit: 5,
    });

    expect(result.patterns).toHaveLength(5);
    expect(result.patterns.map((p: any) => p.fingerprintHash)).toEqual([
      'fp_0000', 'fp_0010', 'fp_0020', 'fp_0030', 'fp_0040',
    ]);
    expect(result.nextCursor).toBeDefined();
  });

  it('walking the cursor to exhaustion yields every match exactly once — no gaps, no repeats', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    await seedPatterns(t, orgId, 80, (i) => (i % 7 === 0 ? { muted: true } : {}));
    const expected = Array.from({ length: 80 }, (_, i) => i)
      .filter((i) => i % 7 === 0)
      .map((i) => `fp_${String(i).padStart(4, '0')}`);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const result: any = await t.mutation(api.read_api.apiListFailurePatterns, {
        apiKeyHash: 'read_key', muted: true, limit: 3, ...(cursor !== undefined && { cursor }),
      });
      seen.push(...result.patterns.map((p: any) => p.fingerprintHash));
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('surplus matches inside one batch are resumable, not dropped', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    // limit 1 => a batch of 4 rows, all three of which match. The naive fix
    // (return `limit` matches, advance the underlying cursor) loses matches 2
    // and 3 forever — the exact bug runs.ts's VerifyCursor comment records.
    await seedPatterns(t, orgId, 3, () => ({ muted: true }));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const result: any = await t.mutation(api.read_api.apiListFailurePatterns, {
        apiKeyHash: 'read_key', muted: true, limit: 1, ...(cursor !== undefined && { cursor }),
      });
      seen.push(...result.patterns.map((p: any) => p.fingerprintHash));
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }

    expect(seen).toEqual(['fp_0000', 'fp_0001', 'fp_0002']);
  });

  it('a raw underlying cursor from the previous implementation still resumes instead of erroring', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    await seedPatterns(t, orgId, 10);

    // A RAW underlying Convex cursor — the exact string the previous
    // implementation handed out, and what an in-flight `afr patterns`
    // pagination would still be holding across the deploy that introduced the
    // composite cursor. It must resume, not throw and not silently restart.
    const first = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', limit: 2 });
    const legacyCursor = JSON.parse(first.nextCursor as string).underlyingCursor as string;

    const resumed = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key', limit: 2, cursor: legacyCursor,
    });
    expect(resumed.patterns.map((p: any) => p.fingerprintHash)).toEqual(['fp_0002', 'fp_0003']);
  });

  it('the scan ceiling is DECLARED, never silent: scanTruncated marks a short page', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    // Enough rows that three full 800-row batches (limit 200 x 4) are consumed
    // without exhausting the table, so the ceiling — not the end of the data —
    // is what stops the scan.
    await seedPatterns(t, orgId, 2500);

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key', spiking: true, limit: 200,
    });

    expect(result.patterns).toEqual([]);
    // Empty AND truncated: the caller is told, in the response, that this
    // empty page is not an answer about the whole table.
    expect(result.scanTruncated).toBe(true);
    expect(result.nextCursor).toBeDefined();
    expect(result.scannedRows).toBeGreaterThanOrEqual(result.scanRowCeiling);
  });

  it('a page filled before exhaustion behaves exactly as before: limit rows, cursor set', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    await seedPatterns(t, orgId, 30);

    const result = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', limit: 10 });
    expect(result.patterns).toHaveLength(10);
    expect(result.patterns[0].fingerprintHash).toBe('fp_0000');
    expect(result.nextCursor).toBeDefined();
    expect(result.scanTruncated).toBe(false);
    expect(result.fixConfidence.entries).toHaveLength(10);
  });

  it('unevaluated still names ungradable patterns found anywhere in the scan', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    const now = Date.now();
    // A resolved pattern with no usable snapshot, sitting past the first
    // batch. It cannot match `state=confirmed`, but the caller must still be
    // told it could not be graded rather than silently counted as "not
    // confirmed".
    await seedPatterns(t, orgId, 30, (i) => (i === 25 ? { status: 'resolved' as const, resolvedAt: now - 1000 } : {}));

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key', state: 'confirmed', limit: 5,
    });

    expect(result.patterns).toEqual([]);
    expect(result.fixConfidence.unevaluated).toEqual(['fp_0025']);
    expect(result.fixConfidence.unevaluatedTruncated).toBe(false);
    expect(result.scanTruncated).toBe(false);
  });

  it('the bounded scan never crosses an org boundary', async () => {
    const t = convexTest(schema, modules);
    const orgId = await seedOrgAndKey(t);
    const otherOrg = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_other', name: 'Other', slug: 'other', plan: 'free', createdAt: now, updatedAt: now,
      });
    });
    await seedPatterns(t, orgId, 40);
    // The other org's rows are the ONLY muted ones anywhere. A scan that
    // widened its index range while chasing matches would surface them.
    await seedPatterns(t, otherOrg, 40, () => ({ muted: true }));

    const result = await t.mutation(api.read_api.apiListFailurePatterns, {
      apiKeyHash: 'read_key', muted: true, limit: 5,
    });
    expect(result.patterns).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
})

// ===========================================================================
// FIELD PROJECTION (`fields`) — convex/read_api.ts §FIELD PROJECTION
// ===========================================================================
//
// The five contract rules, each with a test that fails if the rule is broken:
//
//   1. omitting `fields` returns the full document (backward compatibility)
//   2. an unknown field name is a HARD ERROR, never silently dropped
//   3. the identity field is always returned (`_id` / `sequenceNumber` /
//      `fingerprintHash`)
//   4. `fields: []` is an error, not "return nothing"
//   5. projection is applied AFTER org filtering and can only change what a
//      record CONTAINS, never WHICH records come back
//
// Plus the tenancy guard that motivated the ordering: the unknown-field error
// must be byte-identical whether the referenced record exists in the caller's
// org, does not exist at all, or belongs to another org.
describe('read_api — field projection (`fields`)', () => {
  async function seedKey(t: ReturnType<typeof convexTest>, orgId: any, keyHash: string) {
    await t.run(async (ctx) => {
      await ctx.db.insert('api_keys', { orgId, keyHash, name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['read'] })
    })
  }

  async function seedEventsFP(t: ReturnType<typeof convexTest>, orgId: any, runId: any, count: number) {
    await t.run(async (ctx) => {
      const base = Date.now() - count * 10
      for (let i = 1; i <= count; i++) {
        await ctx.db.insert('events', {
          runId, orgId, type: i === 1 ? 'RUN_STARTED' : 'LLM_CALL', sequenceNumber: i,
          timestamp: base + i * 10, payload: { big: 'x'.repeat(200), i },
        })
      }
    })
  }

  async function seedPattern(t: ReturnType<typeof convexTest>, orgId: any, fingerprintHash: string, extra: any = {}) {
    return await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert('failure_patterns', {
        orgId, fingerprintHash, class: 'llm_error', label: 'Timeout talking to model',
        salientKey: 'timeout', count: 7, firstSeenAt: now - 100000, lastSeenAt: now,
        representativeRunIds: [], affectedAgentVersionIds: [], ...extra,
      })
    })
  }

  /** First line of a rejection message, with nothing id- or frame-specific left in it. */
  async function failureMessage(p: Promise<unknown>): Promise<string> {
    try {
      await p
      return '<<did not throw>>'
    } catch (err: any) {
      return String(err?.message ?? err).split('\n')[0]
    }
  }

  /** The valid-field set the implementation must be using, derived from the SAME schema it derives from. */
  function expectedValidFields(table: 'runs' | 'events' | 'failure_patterns'): string[] {
    return ['_id', '_creationTime', ...Object.keys((schema as any).tables[table].validator.fields)].sort()
  }

  // -------------------------------------------------------------------------
  // Rule 1 — omitting `fields` is perfectly backward compatible
  // -------------------------------------------------------------------------

  it('RULE 1: omitting `fields` returns the FULL run document, unchanged', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'failed')

    const list = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key' })
    const got = list.runs[0]
    const stored = await t.run(async (ctx: any) => await ctx.db.get(runId))
    expect(Object.keys(got).sort()).toEqual(Object.keys(stored).sort())
    expect(got).toEqual(stored)
  })

  it('RULE 1: omitting `fields` returns the FULL event document, unchanged', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEventsFP(t, orgA, runId, 3)

    const res = await t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId) })
    expect(Object.keys(res.events[0]).sort()).toEqual(
      ['_id', '_creationTime', 'runId', 'orgId', 'type', 'sequenceNumber', 'timestamp', 'payload'].sort(),
    )
    // The payload — the expensive thing projection exists to drop — is present in full when not projected.
    expect(res.events[0].payload.big).toHaveLength(200)
  })

  it('RULE 1: omitting `fields` returns the FULL pattern document, unchanged', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    await seedPattern(t, orgA, 'fp_full')

    const res = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key' })
    expect(res.patterns[0].class).toBe('llm_error')
    expect(res.patterns[0].salientKey).toBe('timeout')
    expect(res.patterns[0].count).toBe(7)
    expect(res.patterns[0].representativeRunIds).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Rule 3 — the identity field is always returned
  // -------------------------------------------------------------------------

  it('RULE 3: apiListRuns projects to exactly the requested fields PLUS `_id`', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    await seedRun(t, orgA, projectA, agentA, 'failed')

    const res = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: ['status', 'startedAt'] })
    // `_id` was NOT requested and MUST be present anyway — a row you cannot address is not useful.
    expect(Object.keys(res.runs[0]).sort()).toEqual(['_id', 'startedAt', 'status'])
    expect(res.runs[0].status).toBe('failed')
    // Everything else is genuinely gone, not merely undefined.
    expect('metadata' in res.runs[0]).toBe(false)
    expect('tags' in res.runs[0]).toBe(false)
    expect('orgId' in res.runs[0]).toBe(false)
  })

  it('RULE 3: apiGetRun projects the run and leaves the derived counts intact', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEventsFP(t, orgA, runId, 6)

    const res = await t.mutation(api.read_api.apiGetRun, { apiKeyHash: 'read_key', runId: String(runId), fields: ['status'] })
    expect(Object.keys(res.run).sort()).toEqual(['_id', 'status'])
    // eventCount/artifactCount are DERIVED, not run fields — always returned.
    expect(res.eventCount).toBe(6)
    expect(res.artifactCount).toBe(0)
  })

  it('RULE 3: apiGetRunEvents keeps `sequenceNumber` — the event identity — even when unasked', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEventsFP(t, orgA, runId, 5)

    const res = await t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), fields: ['type'] })
    expect(Object.keys(res.events[0]).sort()).toEqual(['sequenceNumber', 'type'])
    // The whole point: the log is still ordered and addressable without the payloads.
    expect(res.events.map((e: any) => e.sequenceNumber)).toEqual([1, 2, 3, 4, 5])
    expect(res.events.every((e: any) => !('payload' in e))).toBe(true)
  })

  it('RULE 3: apiListFailurePatterns keeps `fingerprintHash` — the pattern identity — even when unasked', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    await seedPattern(t, orgA, 'fp_identity')

    const res = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', fields: ['label'] })
    expect(Object.keys(res.patterns[0]).sort()).toEqual(['fingerprintHash', 'label'])
    expect(res.patterns[0].fingerprintHash).toBe('fp_identity')
    // The confidence envelope is keyed by fingerprintHash, so it stays joinable to a projected page.
    expect(res.fixConfidence.entries[0].fingerprintHash).toBe('fp_identity')
  })

  it('RULE 3: apiGetFailurePatternEvidence projects the pattern, never the derived evidence', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    await seedPattern(t, orgA, 'fp_ev')

    const res = await t.mutation(api.read_api.apiGetFailurePatternEvidence, {
      apiKeyHash: 'read_key', fingerprintHash: 'fp_ev', fields: ['count'],
    })
    expect(Object.keys(res.pattern).sort()).toEqual(['count', 'fingerprintHash'])
    expect(res.resolution).toBeNull()
    expect(res.exposure).toBeNull()
    expect(res.transitions).toEqual([])
  })

  it('RULE 3: explicitly requesting the identity field is idempotent, not a duplicate', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    await seedRun(t, orgA, projectA, agentA, 'failed')

    const implicit = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: ['status'] })
    const explicit = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: ['status', '_id'] })
    expect(implicit.runs).toEqual(explicit.runs)
  })

  it('a requested-but-UNSET optional field stays ABSENT, never an explicit undefined key', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    // A still-running run has no endedAt, no sessionId, no environment.
    await t.run(async (ctx: any) => {
      await ctx.db.insert('runs', {
        orgId: orgA, projectId: projectA, agentId: agentA, status: 'running',
        startedAt: Date.now(), metadata: {}, tags: [],
      })
    })

    const res = await t.mutation(api.read_api.apiListRuns, {
      apiKeyHash: 'read_key', fields: ['status', 'endedAt', 'environment'],
    })
    // Projecting a slice of a document must be indistinguishable from that
    // slice OF the full document — an absent optional stays absent.
    expect(Object.keys(res.runs[0]).sort()).toEqual(['_id', 'status'])
    expect('endedAt' in res.runs[0]).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Rule 2 — an unknown field is a hard error, with an exact message
  // -------------------------------------------------------------------------

  it('RULE 2: an unknown field name is REJECTED, never silently dropped', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'failed')
    await seedEventsFP(t, orgA, runId, 2)
    await seedPattern(t, orgA, 'fp_bad')

    await expect(t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: ['statuss'] }))
      .rejects.toThrow(/INVALID_ARGUMENT: unknown field "statuss" for runs; valid fields are: /)
    await expect(t.mutation(api.read_api.apiGetRun, { apiKeyHash: 'read_key', runId: String(runId), fields: ['nope'] }))
      .rejects.toThrow(/INVALID_ARGUMENT: unknown field "nope" for runs; valid fields are: /)
    await expect(t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), fields: ['typ'] }))
      .rejects.toThrow(/INVALID_ARGUMENT: unknown field "typ" for events; valid fields are: /)
    await expect(t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', fields: ['labl'] }))
      .rejects.toThrow(/INVALID_ARGUMENT: unknown field "labl" for failure_patterns; valid fields are: /)
    await expect(t.mutation(api.read_api.apiGetFailurePatternEvidence, { apiKeyHash: 'read_key', fingerprintHash: 'fp_bad', fields: ['labl'] }))
      .rejects.toThrow(/INVALID_ARGUMENT: unknown field "labl" for failure_patterns; valid fields are: /)
  })

  it('RULE 2: a field valid on ANOTHER resource is still unknown here (no cross-resource leniency)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'failed')

    // `sequenceNumber` is an EVENT field; asking for it on runs is a caller bug.
    await expect(t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: ['sequenceNumber'] }))
      .rejects.toThrow(/unknown field "sequenceNumber" for runs/)
    // `status` is a RUN field; events have no such column.
    await expect(t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), fields: ['status'] }))
      .rejects.toThrow(/unknown field "status" for events/)
  })

  it('RULE 2: the advertised valid-field list is exactly the schema, sorted and stable', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'failed')

    const cases: Array<[string, Promise<unknown>]> = [
      ['runs', t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: ['zzz'] })],
      ['events', t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), fields: ['zzz'] })],
      ['failure_patterns', t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', fields: ['zzz'] })],
    ]
    for (const [table, p] of cases) {
      const msg = await failureMessage(p)
      const expected = expectedValidFields(table as any)
      expect(msg).toBe(`INVALID_ARGUMENT: unknown field "zzz" for ${table}; valid fields are: ${expected.join(', ')}`)
      // Sorted, so two deployments cannot advertise the same set in different orders.
      expect([...expected].sort()).toEqual(expected)
    }
  })

  it('RULE 2: every advertised valid field is actually SELECTABLE (the list is not aspirational)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    await seedRun(t, orgA, projectA, agentA, 'failed')

    for (const field of expectedValidFields('runs')) {
      const res = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: [field] })
      expect(res.runs).toHaveLength(1)
    }
  })

  // -------------------------------------------------------------------------
  // Rule 4 — an empty array is an error
  // -------------------------------------------------------------------------

  it('RULE 4: `fields: []` is an ERROR, not "return nothing" and not "return everything"', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'failed')
    await seedEventsFP(t, orgA, runId, 2)
    await seedPattern(t, orgA, 'fp_empty')

    await expect(t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: [] }))
      .rejects.toThrow(/INVALID_ARGUMENT: fields must not be empty for runs/)
    await expect(t.mutation(api.read_api.apiGetRun, { apiKeyHash: 'read_key', runId: String(runId), fields: [] }))
      .rejects.toThrow(/INVALID_ARGUMENT: fields must not be empty for runs/)
    await expect(t.mutation(api.read_api.apiGetRunEvents, { apiKeyHash: 'read_key', runId: String(runId), fields: [] }))
      .rejects.toThrow(/INVALID_ARGUMENT: fields must not be empty for events/)
    await expect(t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', fields: [] }))
      .rejects.toThrow(/INVALID_ARGUMENT: fields must not be empty for failure_patterns/)
    await expect(t.mutation(api.read_api.apiGetFailurePatternEvidence, { apiKeyHash: 'read_key', fingerprintHash: 'fp_empty', fields: [] }))
      .rejects.toThrow(/INVALID_ARGUMENT: fields must not be empty for failure_patterns/)
  })

  // -------------------------------------------------------------------------
  // Rule 5 — projection changes CONTENT, never MEMBERSHIP
  // -------------------------------------------------------------------------

  it('RULE 5: the same runs come back with and without `fields` (identical ids, identical order)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    for (let i = 0; i < 5; i++) await seedRun(t, orgA, projectA, agentA, i % 2 === 0 ? 'failed' : 'completed')

    const full = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key' })
    const projected = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', fields: ['status'] })
    expect(projected.runs.map((r: any) => r._id)).toEqual(full.runs.map((r: any) => r._id))
    expect(projected.pageSize).toBe(full.pageSize)
  })

  it('RULE 5: a filter still applies when the field it filters on is NOT selected', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    await seedRun(t, orgA, projectA, agentA, 'failed')
    await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedRun(t, orgA, projectA, agentA, 'completed')

    // `status` drives the filter but is deliberately excluded from the projection.
    const res = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', status: 'failed', fields: ['startedAt'] })
    expect(res.runs).toHaveLength(1)
    expect('status' in res.runs[0]).toBe(false)
  })

  it('RULE 5: the sessionId branch of apiListRuns projects too, and still filters', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    await t.run(async (ctx: any) => {
      const now = Date.now()
      await ctx.db.insert('runs', { orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: now, metadata: {}, tags: [], sessionId: 'sess-1' })
      await ctx.db.insert('runs', { orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: now, metadata: {}, tags: [], sessionId: 'sess-2' })
    })

    const res = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key', sessionId: 'sess-1', fields: ['status'] })
    expect(res.runs).toHaveLength(1)
    expect(res.pageSize).toBe(1)
    expect(Object.keys(res.runs[0]).sort()).toEqual(['_id', 'status'])
  })

  it('RULE 5: the `fromSequence` window is unaffected by projection', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')
    await seedEventsFP(t, orgA, runId, 40)

    const res = await t.mutation(api.read_api.apiGetRunEvents, {
      apiKeyHash: 'read_key', runId: String(runId), fromSequence: 30, limit: 5, fields: ['type'],
    })
    expect(res.events.map((e: any) => e.sequenceNumber)).toEqual([30, 31, 32, 33, 34])
  })

  it('RULE 5: the pattern `state` filter still applies when its inputs are not selected', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    const now = Date.now()
    // A resolved pattern that recurred after the fix => state "regressed",
    // decided from resolvedAt/regressedAt — neither of which is selected.
    await seedPattern(t, orgA, 'fp_regressed', { status: 'resolved', resolvedAt: now - 10000, regressedAt: now - 100 })
    await seedPattern(t, orgA, 'fp_clean')

    const res = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', state: 'regressed', fields: ['label'] })
    expect(res.patterns).toHaveLength(1)
    expect(res.patterns[0].fingerprintHash).toBe('fp_regressed')
    expect('resolvedAt' in res.patterns[0]).toBe(false)
    expect('regressedAt' in res.patterns[0]).toBe(false)
  })

  it('RULE 5: `unevaluated` and the confidence envelope are computed from the FULL documents', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key')
    // Resolved, no usable snapshot => must appear in `unevaluated` even though
    // `resolvedAt` is projected away from the returned document.
    await seedPattern(t, orgA, 'fp_unevaluated', { status: 'resolved', resolvedAt: Date.now() - 5000 })

    const res = await t.mutation(api.read_api.apiListFailurePatterns, { apiKeyHash: 'read_key', fields: ['label'] })
    expect(res.fixConfidence.unevaluated).toEqual(['fp_unevaluated'])
    expect(res.fixConfidence.entries[0]).toEqual({
      fingerprintHash: 'fp_unevaluated', state: null, score: null, computedAt: null, ageMs: null, stale: false, basis: 'none',
    })
    expect('resolvedAt' in res.patterns[0]).toBe(false)
  })

  it('RULE 5: projection never widens org scope — another org\'s runs stay invisible', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key_a')
    await seedRun(t, orgB, projectB, agentB, 'failed')

    const res = await t.mutation(api.read_api.apiListRuns, { apiKeyHash: 'read_key_a', fields: ['status'] })
    expect(res.runs).toEqual([])
  })

  // -------------------------------------------------------------------------
  // TENANCY — the unknown-field error must not become an existence oracle
  // -------------------------------------------------------------------------

  /**
   * EXISTENCE-ORACLE GUARD, the reason `fields` is validated BEFORE the record
   * lookup (exactly where `fromSequence` is validated, and for the same
   * reason). If the unknown-field error differed in ANY observable way between
   * "record is in my org", "record does not exist" and "record belongs to
   * another org", a caller could enumerate another org's ids by sending a
   * deliberately bad field name and reading which error came back.
   */
  it('TENANCY: the unknown-field error is byte-identical for present / absent / other-org runs', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key_a')

    const mine = await seedRun(t, orgA, projectA, agentA, 'completed')
    const dangling = await seedRun(t, orgA, projectA, agentA, 'completed')
    await t.run(async (ctx: any) => { await ctx.db.delete(dangling) })
    const foreign = await seedRun(t, orgB, projectB, agentB, 'completed')

    for (const [fn, table] of [[api.read_api.apiGetRun, 'runs'], [api.read_api.apiGetRunEvents, 'events']] as const) {
      const messages = await Promise.all(
        [mine, dangling, foreign].map((runId) =>
          failureMessage(t.mutation(fn as any, { apiKeyHash: 'read_key_a', runId: String(runId), fields: ['bogus'] })),
        ),
      )
      // All three identical...
      expect(messages[0]).toBe(messages[1])
      expect(messages[1]).toBe(messages[2])
      // ...and identical to the field error, NOT to a "not found" that would
      // itself distinguish the cases.
      expect(messages[0]).toBe(
        `INVALID_ARGUMENT: unknown field "bogus" for ${table}; valid fields are: ${expectedValidFields(table).join(', ')}`,
      )
      expect(messages[0]).not.toMatch(/not found/i)
    }
  })

  it('TENANCY: the empty-`fields` error is byte-identical for present / absent / other-org runs', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key_a')

    const mine = await seedRun(t, orgA, projectA, agentA, 'completed')
    const dangling = await seedRun(t, orgA, projectA, agentA, 'completed')
    await t.run(async (ctx: any) => { await ctx.db.delete(dangling) })
    const foreign = await seedRun(t, orgB, projectB, agentB, 'completed')

    const messages = await Promise.all(
      [mine, dangling, foreign].map((runId) =>
        failureMessage(t.mutation(api.read_api.apiGetRun, { apiKeyHash: 'read_key_a', runId: String(runId), fields: [] })),
      ),
    )
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toMatch(/^INVALID_ARGUMENT: fields must not be empty for runs/)
  })

  it('TENANCY: the unknown-field error is byte-identical for present / absent / other-org fingerprints', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB } = await seedTwoOrgs(t)
    await seedKey(t, orgA, 'read_key_a')
    await seedPattern(t, orgA, 'fp_mine')
    await seedPattern(t, orgB, 'fp_theirs')

    const messages = await Promise.all(
      ['fp_mine', 'fp_never_existed', 'fp_theirs'].map((fingerprintHash) =>
        failureMessage(t.mutation(api.read_api.apiGetFailurePatternEvidence, {
          apiKeyHash: 'read_key_a', fingerprintHash, fields: ['bogus'],
        })),
      ),
    )
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toBe(
      `INVALID_ARGUMENT: unknown field "bogus" for failure_patterns; valid fields are: ${expectedValidFields('failure_patterns').join(', ')}`,
    )
    // Without `fields`, the same three cases still behave as before: the two
    // unreachable ones are an indistinguishable null, the reachable one is a hit.
    const plain = await Promise.all(
      ['fp_mine', 'fp_never_existed', 'fp_theirs'].map((fingerprintHash) =>
        t.mutation(api.read_api.apiGetFailurePatternEvidence, { apiKeyHash: 'read_key_a', fingerprintHash }),
      ),
    )
    expect(plain[1]).toBeNull()
    expect(plain[2]).toBeNull()
    expect(plain[0]).not.toBeNull()
  })

  it('TENANCY: scope enforcement still precedes field validation (a write-only key learns nothing)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await t.run(async (ctx: any) => {
      await ctx.db.insert('api_keys', { orgId: orgA, keyHash: 'ingest_only', name: 'k', createdBy: 'u', createdAt: Date.now(), scopes: ['ingest:write'] })
    })
    const runId = await seedRun(t, orgA, projectA, agentA, 'completed')

    // A key without `read` is rejected on scope — it does not get to probe the
    // schema through the valid-field list in an INVALID_ARGUMENT message.
    const msg = await failureMessage(
      t.mutation(api.read_api.apiGetRun, { apiKeyHash: 'ingest_only', runId: String(runId), fields: ['bogus'] }),
    )
    expect(msg).toMatch(/Forbidden/)
    expect(msg).not.toMatch(/INVALID_ARGUMENT/)
  })
})
