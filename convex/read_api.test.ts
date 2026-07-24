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
