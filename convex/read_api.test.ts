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
    opts: { affectedAgentVersionIds?: any[]; lastSeenAt?: number } = {},
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
      });
    });
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
})
