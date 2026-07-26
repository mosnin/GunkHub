/* eslint-disable */
// Cycle 3 (Team C, Action Layer — cohesion): the end-to-end proof that the
// record -> search -> triage -> eval -> read -> export loop is actually
// connected, not just individually-tested pieces.
//
// WHY THIS LIVES IN convex/, NOT tests/: convex/vitest.config.ts documents
// that convex-test tests need the `edge-runtime` vitest environment (Convex's
// server runtime) and inline convex-test so its import.meta.glob resolves
// this package's own modules — that config is deliberately kept separate
// from tests/vitest.config.ts (plain `node` env, for product-type/contract
// tests with no live backend). Every other convex-test-driven test in this
// repo (action_layer.test.ts, adr002.test.ts, governance.test.ts,
// backend.test.ts, insights.test.ts) already lives here for the same reason.
// This file adds test coverage only — it does not change any convex/**
// implementation, so it does not cross the data-agent file-ownership
// boundary in CLAUDE.md's sense of "editing".
//
// TIERING (see docs/api_reference.md and tests/unit/api_keys_scopes.test.ts
// for the other tiers this cycle touches):
//   - Data-plane / backend logic: THIS FILE, via convexTest — calls the real
//     Convex functions (sdk_ingest, runs, evals via sdkRecordEval, usage,
//     read_api) in-process, no live deployment, no mocks of business logic.
//   - Route <-> Convex wiring (HTTP layer: header parsing, hashApiKey,
//     apiV1Envelope, error-code mapping): NOT re-proven here — already
//     covered by tests/unit/api_v1_envelope.test.ts, api_error_mapping.test.ts,
//     and cli_v1_api.test.ts (mocked-fetch tier). apps/web's route files
//     (app/api/v1/**, app/api/api-keys/**) are thin wrappers over exactly the
//     convex functions this file drives directly — see those routes' source
//     for the one-line pass-through.
//   - The `scopes` request-validation contract (POST /api/api-keys):
//     unit-tested in isolation in tests/unit/api_keys_scopes.test.ts (pure
//     logic, no Convex). THIS file proves the *other* half: that a key
//     Convex actually issues with `scopes: ["read"]` can read through
//     read_api.ts, and one issued with only `["ingest:write"]` cannot.
//   - Export bundle: apps/web's `GET /api/export/runs/[runId]` route is a
//     thin ndjson-streaming wrapper around exactly the queries this file
//     calls directly (listEvents/listComments/getVerificationResult) — see
//     that route's source. This file proves those underlying queries return
//     the run's full recorded state after the triage/eval/usage steps below;
//     the route's own streaming/formatting is not re-exercised here (no
//     Next.js runtime in this harness).
import { convexTest } from 'convex-test'
import { describe, expect, it, vi } from 'vitest'

import schema from './schema'
import { api, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

describe('E2E cohesion: record -> search -> triage -> eval -> read -> export', () => {
  it('walks a realistic org/project/agent/version -> ingest -> triage -> eval -> read -> export flow', async () => {
    const t = convexTest(schema, modules)
    const now = Date.now()

    // -----------------------------------------------------------------
    // 1. Org/project/agent, an admin membership (createAgentVersion and
    //    setRunTriage both require admin/member Clerk auth).
    // -----------------------------------------------------------------
    const orgId = await t.run((ctx) =>
      ctx.db.insert('organizations', {
        clerkOrgId: 'clerk_cohesion_org',
        name: 'Cohesion Co',
        slug: 'cohesion-co',
        plan: 'free',
        createdAt: now,
        updatedAt: now,
      }),
    )
    await t.run((ctx) =>
      ctx.db.insert('user_memberships', {
        clerkUserId: 'admin_1',
        orgId,
        role: 'admin',
        joinedAt: now,
      }),
    )
    const asAdmin = t.withIdentity({ subject: 'admin_1', org_id: 'clerk_cohesion_org' })

    const projectId = await t.run((ctx) =>
      ctx.db.insert('projects', { orgId, name: 'Proj', slug: 'proj', createdAt: now, updatedAt: now }),
    )

    // agents.createAgent — real mutation, exercises the admin-gated create path.
    const agent = await asAdmin.mutation(api.agents.createAgent, {
      projectId,
      name: 'Support Bot',
      slug: 'support-bot',
    })

    // agent_versions.createAgentVersion — real mutation.
    const agentVersion = await asAdmin.mutation(api.agent_versions.createAgentVersion, {
      agentId: agent._id,
      version: '1.0.0',
    })

    // -----------------------------------------------------------------
    // 2. Mint an INGEST key via the real createApiKey mutation (Team A's
    //    `scopes` arg — the exact seam this cycle's route change consumes).
    //    Omitting `scopes` here mirrors the web route's default-omitted
    //    request body BEFORE Cycle 3 (i.e. what an existing ingest
    //    integration looks like) — full back-compat access, ingest included.
    // -----------------------------------------------------------------
    const ingestKeyName = 'sdk-ingest-key'
    const ingestKeyHash = 'hash_ingest_cohesion'
    await asAdmin.mutation(api.api_keys.createApiKey, {
      orgId,
      name: ingestKeyName,
      keyHash: ingestKeyHash,
      scopes: ['ingest:write'],
    })

    // -----------------------------------------------------------------
    // 3. SDK-style ingest: create a run, then a batch of events including
    //    an llm.response with token usage, then the terminal run.failed
    //    event (Event Log Rules 1/4/5 all exercised by sdkCreateEvents).
    // -----------------------------------------------------------------
    const createdRun = await t.mutation(api.sdk_ingest.sdkCreateRun, {
      apiKeyHash: ingestKeyHash,
      agentId: agent._id,
      agentVersionId: agentVersion._id,
      tags: ['prod', 'cohesion-e2e'],
      triggeredBy: 'scheduler',
      sdkVersion: '1.0.0',
    })
    const runId = createdRun.id

    // Force the run's single-unit usage flush (runsStarted) deterministic,
    // mirroring convex/adr002.test.ts's own usage-counter test — the flush
    // is intentionally probabilistic for single-unit calls (see usage.ts).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      await t.mutation(api.sdk_ingest.sdkCreateEvents, {
        apiKeyHash: ingestKeyHash,
        events: [
          { runId, type: 'run.started', sequenceNumber: 1, timestamp: now, payload: { type: 'run.started' } },
          {
            runId,
            type: 'llm.request',
            sequenceNumber: 2,
            timestamp: now + 1,
            payload: { type: 'llm.request', model: 'claude', prompt: 'hi' },
          },
          {
            runId,
            type: 'llm.response',
            sequenceNumber: 3,
            timestamp: now + 2,
            payload: { type: 'llm.response', usage: { input_tokens: 120, output_tokens: 45 } },
          },
          {
            runId,
            type: 'run.failed',
            sequenceNumber: 4,
            timestamp: now + 3,
            payload: { type: 'run.failed', error: { message: 'tool timeout while calling search' } },
          },
        ],
      })
    } finally {
      randomSpy.mockRestore()
    }

    // -----------------------------------------------------------------
    // Assertions: ingest produced a coherent, terminal, token-annotated run.
    // -----------------------------------------------------------------
    const runAfterIngest = await t.run((ctx) => ctx.db.get(runId))
    expect(runAfterIngest?.status).toBe('failed')
    expect(runAfterIngest?.tokensIn).toBe(120)
    expect(runAfterIngest?.tokensOut).toBe(45)
    expect(runAfterIngest?.searchText).toContain('tool timeout')

    // -----------------------------------------------------------------
    // 4. searchRuns — the run is findable by its failure text (Clerk-authed).
    // -----------------------------------------------------------------
    const searchResult = await asAdmin.query(api.runs.searchRuns, {
      orgId,
      searchTerm: 'timeout',
    })
    expect(searchResult.runs.map((r) => r._id)).toContain(runId)

    // -----------------------------------------------------------------
    // 5. setRunTriage — a failed run can be triaged (Clerk-authed, member+).
    // -----------------------------------------------------------------
    const triaged = await asAdmin.mutation(api.runs.setRunTriage, {
      runId,
      triageState: 'investigating',
    })
    expect(triaged?.triageState).toBe('investigating')

    // -----------------------------------------------------------------
    // 6. Record an eval against the run via the KEY-authed sdkRecordEval path
    //    (the same ingest key an automated eval pipeline would use).
    // -----------------------------------------------------------------
    await t.mutation(api.sdk_ingest.sdkRecordEval, {
      apiKeyHash: ingestKeyHash,
      runId,
      agentVersionId: agentVersion._id,
      name: 'no-tool-timeouts',
      kind: 'rule',
      passed: false,
      score: 0,
      details: 'tool timeout while calling search',
    })
    const evalsForRun = await asAdmin.query(api.evals.listEvalsForRun, { runId })
    expect(evalsForRun.some((e) => e.name === 'no-tool-timeouts' && e.passed === false)).toBe(true)

    // -----------------------------------------------------------------
    // 7. Usage counters incremented — the batch events call (4 events, a
    //    batch > 1 unit) flushes deterministically; the run-creation call's
    //    single-unit flush was forced above via the Math.random mock.
    // -----------------------------------------------------------------
    const day = new Date(now).toISOString().slice(0, 10)
    const usage = await asAdmin.query(api.usage.getUsageForDay, { orgId, day })
    expect(usage).not.toBeNull()
    expect(usage!.runsStarted).toBeGreaterThan(0)
    expect(usage!.eventsIngested).toBeGreaterThanOrEqual(4)
    expect(usage!.bytesIngested).toBeGreaterThan(0)

    // -----------------------------------------------------------------
    // 8. Mint a READ key (Team A's `scopes` arg, this cycle's route seam)
    //    and read the run back through read_api — apiListRuns/apiGetRun.
    //    Then prove an INGEST-ONLY key is REJECTED on the same read path.
    // -----------------------------------------------------------------
    const readKeyHash = 'hash_read_cohesion'
    await asAdmin.mutation(api.api_keys.createApiKey, {
      orgId,
      name: 'cli-read-key',
      keyHash: readKeyHash,
      scopes: ['read'],
    })

    const listed = await t.mutation(api.read_api.apiListRuns, {
      apiKeyHash: readKeyHash,
      status: 'failed',
    })
    expect(listed.runs.map((r: { _id: string }) => r._id)).toContain(runId)

    const fetched = await t.mutation(api.read_api.apiGetRun, {
      apiKeyHash: readKeyHash,
      runId,
    })
    expect(fetched.run._id).toBe(runId)
    expect(fetched.eventCount).toBe(4)

    // The ingest-only key (scopes: ["ingest:write"], no "read") must be
    // rejected by the exact same read_api function — this is the scope
    // seam Team E's key-creation UI and the CLI both depend on.
    await expect(
      t.mutation(api.read_api.apiGetRun, { apiKeyHash: ingestKeyHash, runId }),
    ).rejects.toThrow(/Forbidden.*scope.*"read"/)
    await expect(
      t.mutation(api.read_api.apiListRuns, { apiKeyHash: ingestKeyHash, status: 'failed' }),
    ).rejects.toThrow(/Forbidden.*scope.*"read"/)

    // -----------------------------------------------------------------
    // 9. Export the bundle — drive the exact queries
    //    apps/web/app/api/export/runs/[runId]/route.ts assembles (run,
    //    paginated events, comments, verification status). A run-level
    //    comment is added first so the comment line has something to export.
    // -----------------------------------------------------------------
    await asAdmin.mutation(api.comments.createComment, {
      orgId,
      targetId: runId,
      targetType: 'run',
      content: 'Investigating the search-tool timeout.',
    })

    const exportRun = await t.run((ctx) => ctx.db.get(runId))
    expect(exportRun).not.toBeNull()

    const exportEvents = await asAdmin.query(api.events.listEvents, { runId, limit: 500 })
    expect(exportEvents.events.map((e: { type: string }) => e.type)).toEqual([
      'run.started',
      'llm.request',
      'llm.response',
      'run.failed',
    ])

    const exportComments = await asAdmin.query(api.comments.listComments, {
      orgId,
      targetId: runId,
      targetType: 'run',
    })
    expect(exportComments).toHaveLength(1)
    expect(exportComments[0]!.content).toContain('search-tool timeout')

    // No reverifyRun action has run in this harness, so verification is
    // legitimately absent (null) — same as a freshly-ingested run in
    // production before its first scheduled/triggered verification pass.
    const exportVerification = await asAdmin.query(api.projection_verify.getVerificationResult, { runId })
    expect(exportVerification).toBeNull()

    // The full loop: ingested -> searchable -> triaged -> evaluated ->
    // usage-metered -> readable via a dedicated read key (and NOT via an
    // ingest-only key) -> exportable. Every step above operated on the SAME
    // runId end to end.
  })
})
