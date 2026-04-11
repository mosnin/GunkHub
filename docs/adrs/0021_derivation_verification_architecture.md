# ADR-0021: Derivation Verification via Internal Web Route

## Status

Accepted

## Date

2026-04-11

## Context

ADR-0020 established a daily Convex scheduled action (`verifyRecentRuns`) that checks
sequence integrity (no gaps, no duplicates) for recent terminal runs. It explicitly
documented that `buildReplayProjection` and `buildFailureSummary` were NOT called from
the Convex action because those functions live in `apps/web/src/lib/replay/` and cannot
be imported from a Convex action — the two runtimes are separate deployment contexts.

This left a trust gap: the green "verified" badge in the UI only meant that sequence
numbers were contiguous and unique. It did not mean that the stored events would
successfully render in the replay tab or that the failure summary would be produced
without errors. A corrupt payload shape or a bug introduced in the derivation functions
could produce a bad user experience without surfacing in the nightly cron.

### Options considered

**Option A — Extract to a shared package (`packages/derive`)**

Move `buildReplayProjection` and `buildFailureSummary` into a new workspace package that
both `apps/web` and `convex/` could import. This would allow the Convex action to call
the derivation functions directly.

Rejected: Convex's runtime environment does not support arbitrary Node.js packages and
has restrictions on what can be imported. Moving the derivation functions to a shared
package would require verifying Convex compatibility for every dependency they pull in
(currently none, but the constraint is fragile). It also increases build complexity with
a new package that must be versioned, published, and consumed. The benefit does not
justify the structural cost at v1 scale.

**Option B — Implement derivation logic inside Convex (`convex/` only)**

Duplicate `buildReplayProjection` and `buildFailureSummary` inline in
`convex/projection_verify.ts`, mirroring the pattern used for `checkSequenceIntegrity`.

Rejected: The derivation functions are materially more complex than the sequence check.
Duplicating them creates two codepaths that must be kept in sync by policy rather than
by the type system. The projection logic already has 500+ lines of tests in
`tests/unit/replay.test.ts` and `tests/unit/failure.test.ts`. Duplicating the
implementation would require duplicating all that test coverage as well. The maintenance
cost is unacceptably high.

**Option C — Internal HTTP route (chosen)**

Expose a `POST /api/internal/verify-derivation` route in `apps/web` protected by a
shared secret (`INTERNAL_VERIFY_SECRET`). The Convex action sends the run document and
its full event array to this route; the route calls `verifyProjectionIntegrity` (which
already calls `buildReplayProjection` and `buildFailureSummary`) and returns a structured
result. The Convex action stores the result in the `verification_results` table, now
including per-check pass/fail fields.

Selected: Keeps the canonical derivation logic in one place (`apps/web/src/lib/replay/`).
Convex can make outbound HTTP requests from actions. The route is simple and stateless.
Graceful degradation is straightforward — if the route is unreachable or unconfigured,
the action falls back to the existing sequence-only result.

## Decision

### Route: `POST /api/internal/verify-derivation`

A new Next.js API route protected by a shared secret in the `x-internal-secret` header.
The route:

1. Validates the `x-internal-secret` header against `INTERNAL_VERIFY_SECRET` from
   `apps/web/src/lib/env.ts`. Returns 401 if the header is missing or incorrect. Returns
   503 if `INTERNAL_VERIFY_SECRET` is not configured on the deployment.
2. Parses the JSON body: `{ run: <raw Convex run doc>, events: <raw Convex event docs[]> }`.
3. Maps the raw Convex documents to `Run` and `Event[]` contract types (Convex uses `_id`;
   contracts use `id`).
4. Calls `verifyProjectionIntegrity(run, events)` from `apps/web/src/lib/replay/verify.ts`.
5. Returns a JSON response with:
   - `isValid: boolean`
   - `summary: string`
   - `sequenceGaps: number[]`
   - `duplicateSeqNums: number[]`
   - `failureReason?: string`
   - `checksRan: string[]` — always `["sequence", "replay", "failureSummary"]`
   - `replayPassed: boolean` — true if no errors from `buildReplayProjection`
   - `failureSummaryPassed: boolean` — true if no errors from `buildFailureSummary`

### Convex action changes (`convex/projection_verify.ts`)

- **`_listEventsFull`**: New `internalQuery` that returns full event documents (not just
  sequence numbers), paginated at 500 items per page.
- **`_upsertVerificationResult`**: Extended with three optional args: `checksRan`,
  `replayPassed`, `failureSummaryPassed`. These are stored to the `verification_results`
  table when provided.
- **`verifyRecentRuns`**: Extended with a derivation check branch. If
  `INTERNAL_VERIFY_URL` and `INTERNAL_VERIFY_SECRET` are both set in the Convex
  environment, and the run has ≤ 500 events (`DERIVATION_MAX_EVENTS`), the action:
  1. Fetches full event documents via `_listEventsFull`.
  2. POSTs to `${INTERNAL_VERIFY_URL}/api/internal/verify-derivation` with a JSON body
     containing the run and events.
  3. Stores the extended result (including `checksRan`, `replayPassed`,
     `failureSummaryPassed`) via `_upsertVerificationResult`.
  4. Uses `continue` to skip the sequence-only fallback for this run.
  
  If the HTTP call fails (network error, non-200 status, or JSON parse error), the action
  falls through to the existing sequence-only path and stores a result without
  `checksRan`/`replayPassed`/`failureSummaryPassed`.

### Schema changes (`convex/schema.ts`)

Three optional fields added to `verification_results`:

```typescript
checksRan: v.optional(v.array(v.string())),       // absent on sequence-only records
replayPassed: v.optional(v.boolean()),             // true = buildReplayProjection succeeded
failureSummaryPassed: v.optional(v.boolean()),     // true = buildFailureSummary succeeded
```

These fields are absent on records created by the sequence-only path (pre-Prompt 21 or
graceful degradation). The `VerificationStatus` service type maps absent fields to `null`
(`checksRan` maps to `[]`).

### UI: richer badge states (`IntegrityBadge.tsx`)

| Condition | Badge | Colour |
|-----------|-------|--------|
| Never verified | `unverified` | neutral gray |
| Verified + valid + `checksRan` includes `"replay"` | `verified` | emerald |
| Verified + valid + `checksRan` does not include `"replay"` | `seq verified` | sky blue |
| Verified + invalid (any check) | `check failed` | red |

The badge distinguishes between full derivation verification and sequence-only
verification. Old records (pre-Prompt 21) that have `checksRan` absent will map to
`checksRan: []` and display as `seq verified`, which is accurate — they were
sequence-only.

### Size cap: `DERIVATION_MAX_EVENTS = 500`

Runs with more than 500 events are excluded from the full derivation check and receive
a sequence-only result. This prevents the Convex action from constructing and sending
a very large JSON body over HTTP. 500 events is generous for v1 agent runs; if the cap
is hit, the sequence check still provides meaningful coverage.

### Environment variables

| Variable | Where set | Purpose |
|----------|-----------|---------|
| `INTERNAL_VERIFY_SECRET` | Web deployment (`.env.local` or Vercel) | Shared secret for the internal route. Also set in Convex: `npx convex env set INTERNAL_VERIFY_SECRET ...` |
| `INTERNAL_VERIFY_URL` | Convex deployment only | Base URL of the web app. Set via `npx convex env set INTERNAL_VERIFY_URL https://yourapp.com` |

Both variables are optional. If either is absent, `verifyRecentRuns` silently falls
back to sequence-only verification. No error is surfaced — the cron continues to provide
its existing guarantee.

## Rationale

### One canonical implementation

The derivation logic (`buildReplayProjection`, `buildFailureSummary`) is implemented
exactly once, in `apps/web/src/lib/replay/`. All callers — the replay API route, the
rebuild CLI script, and now the nightly cron (via HTTP) — run the same code. If a bug
is fixed in the derivation logic, the fix is automatically reflected in all three paths.

### Graceful degradation as the default

The derivation check is opt-in via environment variables. Operators who do not configure
`INTERNAL_VERIFY_URL` get the same sequence-only verification they had before. There is
no regression for existing deployments. When configured, the check adds value without
requiring any migration of existing data.

### Stateless HTTP round-trip

The internal route is stateless: it takes a run and events, calls a pure function, and
returns a result. No database calls, no Clerk auth, no side effects. This makes it easy
to reason about, test, and replace if the architecture changes.

### `checksRan` records attempt, not outcome

The `checksRan` array includes `"replay"` even if `replayPassed` is false. This
distinguishes "we tried and it failed" from "we never tried". Operators can tell at a
glance whether the full check was attempted for a given run.

## Consequences

### Positive

- Full derivation verification is now possible from the nightly cron without code
  duplication.
- The badge reliably distinguishes sequence-only from full-derivation verification.
- Graceful degradation: sequence-only verification continues to work with no configuration.
- The internal route is pure, stateless, and easy to test without Convex infrastructure.
- Old records (`checksRan` absent) display as `seq verified` — accurately representing
  their verification level.

### Negative

- The Convex action now makes an outbound HTTP request, introducing a network dependency
  that was not present before. If the web deployment is down during the 04:30 UTC cron
  window, the derivation check degrades to sequence-only for all runs. The sequence check
  still runs regardless.
- The JSON body for a 500-event run may be several hundred kilobytes (events with large
  payloads). Convex actions have an HTTP response size limit. If event payloads are large
  (near the 10KB externalization threshold), the body may be trimmed. The 500-event cap
  is a safety bound but not a byte-size bound. Operators should monitor cron logs if they
  expect many runs near the 10KB payload threshold.
- `INTERNAL_VERIFY_SECRET` must be kept in sync between the web deployment and the Convex
  deployment. If they diverge (e.g., secret rotated in one place but not the other), the
  derivation check will fail silently and fall back to sequence-only for all runs until
  the secret is re-synced.

### Migration

No data migration is required. The new `checksRan`, `replayPassed`, and
`failureSummaryPassed` fields are optional in the Convex schema. Existing records are
unaffected. Old records display as `seq verified` in the badge, which is correct.

## Related ADRs

- **ADR-0002** — Event Log Is Canonical and Append-Only. The verification action reads
  from but never writes to the event log.
- **ADR-0005** — On-Demand Replay and Diff Projection Strategy. The nightly derivation
  check runs the same projection logic as the on-demand replay route, via the shared
  internal HTTP route.
- **ADR-0020** — Scheduled Projection Integrity Verification Scope. This ADR extends
  (but does not replace) ADR-0020. The sequence-only path from ADR-0020 is preserved
  as the graceful degradation fallback. The `DERIVATION_MAX_EVENTS = 500` cap is a new
  constraint added by this ADR.
