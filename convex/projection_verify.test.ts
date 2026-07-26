/* eslint-disable */
/**
 * Tests for the tenancy properties of convex/projection_verify.ts's public
 * read/reverify surfaces.
 *
 * The property under test (CLAUDE.md Tenancy Rule 3): a runId belonging to
 * ANOTHER organization must be indistinguishable from a runId that does not
 * exist at all. If the two produce different observable outcomes — a different
 * return value, or a different error — the query is an existence oracle: any
 * authenticated caller can enumerate run IDs and learn which ones are real in
 * organizations they cannot see.
 *
 * These tests assert EQUALITY OF THE ACTUAL OUTCOMES (returned value, or thrown
 * message), not merely that neither path throws. "Neither throws" would still
 * pass if one returned a record and the other returned null.
 *
 * The counterweight test in each block: genuine failures must still surface as
 * errors rather than being flattened into null. Collapsing cross-org into
 * "nothing here" is correct; collapsing a broken query into "nothing here" is
 * the conflation that was removed elsewhere this cycle and must not come back.
 */
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

async function seedTwoOrgs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const orgA = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_a', name: 'Org A', slug: 'org-a', plan: 'free', createdAt: now, updatedAt: now,
    })
    const orgB = await ctx.db.insert('organizations', {
      clerkOrgId: 'clerk_b', name: 'Org B', slug: 'org-b', plan: 'free', createdAt: now, updatedAt: now,
    })

    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const projectB = await ctx.db.insert('projects', { orgId: orgB, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent A', slug: 'a', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projectB, name: 'Agent B', slug: 'b', createdAt: now, updatedAt: now })

    // user_a is a member of org A only. It has no visibility into org B at all.
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_a', orgId: orgA, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'viewer_a', orgId: orgA, role: 'viewer', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'user_b', orgId: orgB, role: 'member', joinedAt: now })

    return { orgA, orgB, projectA, projectB, agentA, agentB }
  })
}

async function seedRun(
  t: ReturnType<typeof convexTest>,
  orgId: any,
  projectId: any,
  agentId: any,
) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    return await ctx.db.insert('runs', {
      orgId, projectId, agentId, status: 'completed',
      startedAt: now - 1000, endedAt: now, metadata: {}, tags: [],
    })
  })
}

async function seedVerification(t: ReturnType<typeof convexTest>, orgId: any, runId: any, isValid = true) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('verification_results', {
      runId, orgId, verifiedAt: Date.now(), isValid,
      summary: isValid ? 'OK: 3 events, no gaps, sequence valid' : 'INVALID: 1 sequence gap [2]',
      sequenceGaps: isValid ? [] : [2], duplicateSeqNums: [],
      ...(isValid ? {} : { failureReason: '1 sequence gap [2]' }),
    })
  })
}

/**
 * Produce a syntactically valid Id<"runs"> that refers to no document, by
 * inserting a run and deleting it. A caller probing for run IDs is doing
 * exactly this: presenting well-formed IDs and reading the response.
 */
async function danglingRunId(t: ReturnType<typeof convexTest>, orgId: any, projectId: any, agentId: any) {
  const runId = await seedRun(t, orgId, projectId, agentId)
  await t.run(async (ctx) => { await ctx.db.delete(runId) })
  return runId
}

/** Capture an outcome as a comparable value: either the resolved value or the thrown message. */
async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

describe('projection_verify.getVerificationResult — cross-org existence oracle', () => {
  it('a cross-org runId and a nonexistent runId return deep-equal results', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    // Org B has a real run WITH a verification result — the most revealing case.
    const runInOtherOrg = await seedRun(t, orgB, projectB, agentB)
    await seedVerification(t, orgB, runInOtherOrg, false)

    const missingRunId = await danglingRunId(t, orgA, projectA, agentA)

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })

    const crossOrg = await outcome(() =>
      asUserA.query(api.projection_verify.getVerificationResult, { runId: runInOtherOrg }),
    )
    const nonexistent = await outcome(() =>
      asUserA.query(api.projection_verify.getVerificationResult, { runId: missingRunId }),
    )

    // Neither may throw, AND the values themselves must be identical.
    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.ok).toBe(true)
    expect(crossOrg.value).toBeNull()
    expect(nonexistent.value).toBeNull()
  })

  it('a cross-org runId with NO verification result is also indistinguishable', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const runInOtherOrg = await seedRun(t, orgB, projectB, agentB) // no verification row
    const missingRunId = await danglingRunId(t, orgA, projectA, agentA)

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })

    const crossOrg = await outcome(() =>
      asUserA.query(api.projection_verify.getVerificationResult, { runId: runInOtherOrg }),
    )
    const nonexistent = await outcome(() =>
      asUserA.query(api.projection_verify.getVerificationResult, { runId: missingRunId }),
    )

    expect(crossOrg).toEqual(nonexistent)
    expect(crossOrg.value).toBeNull()
  })

  it('a verification row stamped with another org is never returned, even if its run is visible', async () => {
    // Defence in depth: mismatched orgId between run and verification row is a
    // data defect; it must not become a cross-boundary read.
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentA } = await seedTwoOrgs(t)

    const runId = await seedRun(t, orgA, projectA, agentA)
    await seedVerification(t, orgB, runId, false) // wrong org stamped on the row

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
    const result = await asUserA.query(api.projection_verify.getVerificationResult, { runId })

    expect(result).toBeNull()
  })

  // --- counterweight: the fix must not become blanket silence -------------

  it('still returns the real result for a run the caller CAN see', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)

    const runId = await seedRun(t, orgA, projectA, agentA)
    await seedVerification(t, orgA, runId, false)

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
    const result = await asUserA.query(api.projection_verify.getVerificationResult, { runId })

    expect(result).not.toBeNull()
    expect(result!.isValid).toBe(false)
    expect(result!.summary).toBe('INVALID: 1 sequence gap [2]')
    expect(result!.sequenceGaps).toEqual([2])
  })

  it('returns null (not an error) for a visible run that has never been verified', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
    expect(await asUserA.query(api.projection_verify.getVerificationResult, { runId })).toBeNull()
  })

  it('an unauthenticated caller gets an ERROR, not null', async () => {
    // Genuine auth failure must stay loud. Flattening it into null would report
    // "this run has never been verified" to someone who simply is not logged in.
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await seedVerification(t, orgA, runId)

    await expect(
      t.query(api.projection_verify.getVerificationResult, { runId }),
    ).rejects.toThrow(/Unauthorized/)
  })

  it('an authenticated caller with no org context gets an ERROR, not null', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await seedVerification(t, orgA, runId)

    const noOrg = t.withIdentity({ subject: 'user_a' })
    await expect(
      noOrg.query(api.projection_verify.getVerificationResult, { runId }),
    ).rejects.toThrow(/Unauthorized/)
  })

  it('a caller whose active org has no membership row gets an ERROR, not null', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await seedVerification(t, orgA, runId)

    const stranger = t.withIdentity({ subject: 'nobody', org_id: 'clerk_a' })
    await expect(
      stranger.query(api.projection_verify.getVerificationResult, { runId }),
    ).rejects.toThrow(/not a member/)
  })
})

describe('projection_verify.reverifyRun — cross-org existence oracle', () => {
  it('a cross-org runId and a nonexistent runId throw the SAME error', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const runInOtherOrg = await seedRun(t, orgB, projectB, agentB)
    const missingRunId = await danglingRunId(t, orgA, projectA, agentA)

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })

    const crossOrg = await outcome(() =>
      asUserA.action(api.projection_verify.reverifyRun, { runId: runInOtherOrg }),
    )
    const nonexistent = await outcome(() =>
      asUserA.action(api.projection_verify.reverifyRun, { runId: missingRunId }),
    )

    expect(crossOrg.ok).toBe(false)
    expect(nonexistent.ok).toBe(false)
    // The messages must match exactly — "Run not found" vs "not a member of
    // this organization" is precisely the distinguisher being closed.
    expect(crossOrg.error).toEqual(nonexistent.error)
    expect(crossOrg.error).toMatch(/Run not found/)
  })

  it('reverifying a cross-org run writes nothing into the other org', async () => {
    const t = convexTest(schema, modules)
    const { orgB, projectB, agentB } = await seedTwoOrgs(t)
    const runInOtherOrg = await seedRun(t, orgB, projectB, agentB)

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
    await expect(
      asUserA.action(api.projection_verify.reverifyRun, { runId: runInOtherOrg }),
    ).rejects.toThrow(/Run not found/)

    const rows = await t.run(async (ctx) => await ctx.db.query('verification_results').collect())
    expect(rows).toHaveLength(0)
  })

  // --- counterweight -------------------------------------------------------

  it('still reverifies a run the caller CAN see', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    await t.run(async (ctx) => {
      const now = Date.now()
      for (const n of [1, 2, 3]) {
        await ctx.db.insert('events', {
          orgId: orgA, runId, type: 'LLM_CALL', sequenceNumber: n,
          timestamp: now + n, payload: {},
        })
      }
    })

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
    const result = await asUserA.action(api.projection_verify.reverifyRun, { runId })

    expect(result.isValid).toBe(true)
    expect(result.sequenceGaps).toEqual([])
  })

  it('a viewer in the run\'s own org is still refused on ROLE grounds', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    const asViewer = t.withIdentity({ subject: 'viewer_a', org_id: 'clerk_a' })
    await expect(
      asViewer.action(api.projection_verify.reverifyRun, { runId }),
    ).rejects.toThrow(/Forbidden/)
  })

  it('an unauthenticated caller gets an ERROR', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)

    await expect(
      t.action(api.projection_verify.reverifyRun, { runId }),
    ).rejects.toThrow(/Unauthorized/)
  })
})

describe('projection_verify.batchGetVerificationResults — regression guard', () => {
  it('a cross-org runId and a nonexistent runId produce deep-equal entries', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)

    const runInOtherOrg = await seedRun(t, orgB, projectB, agentB)
    await seedVerification(t, orgB, runInOtherOrg, false)
    const missingRunId = await danglingRunId(t, orgA, projectA, agentA)

    const asUserA = t.withIdentity({ subject: 'user_a', org_id: 'clerk_a' })
    const rows = await asUserA.query(api.projection_verify.batchGetVerificationResults, {
      orgId: orgA,
      runIds: [runInOtherOrg, missingRunId],
    })

    expect(rows[0]!.result).toEqual(rows[1]!.result)
    expect(rows[0]!.result).toBeNull()
  })
})
