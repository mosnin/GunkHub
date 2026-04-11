# Next Steps — v1.1 Candidates

**Document type:** State summary and v1.1 candidate list.
**Current state:** Prompt 15 complete.

---

## What Prompt 15 delivered

- Run detail breadcrumb: `RunBreadcrumb.tsx` component + `getAgent()` service function + breadcrumb wired into run detail page above RunHeader. Two non-fatal Convex queries (project + agent) per page load; failure degrades gracefully without breaking the run detail view.
- Schema drift check: `scripts/check-schema-drift.ts` parses `convex/schema.ts` and `packages/contracts/src/entities.ts`, compares field sets per entity, exits 1 on any mismatch. Exports `parseSchemaTableFields` and `parseContractsInterfaceProperties` as named exports.
- `scripts/validate.sh` updated: drift check is now the fourth mandatory check.
- `.github/workflows/ci.yml` updated: `schema-drift` job runs on every push and pull request.
- `docs/ops/ci_setup.md` updated to document the schema-drift job.
- `tests/unit/schema_drift.test.ts`: 12 unit tests for both parsing functions including exclusion logic.
- Final test count: **513 passing, 5 skipped, 18 test files, all green**.

---

## v1.1 Candidates

Listed in rough priority order.

### HIGH

**1. SDK auto-externalization**
The SDK does not detect payloads >10 KB before calling `POST /api/events`. If a payload exceeds the limit, the API returns HTTP 413 and the SDK surfaces that error to the caller. Auto-externalization (upload to `POST /api/artifacts/upload` then replace payload with an `ExternalizedPayload` pointer) would eliminate the silent failure that callers currently must handle.

**2. Artifact download error UX**
The download link in `ArtifactList.tsx` is a plain `<a download>` anchor. If the route returns 404 or 502, the browser silently downloads a JSON error body. Convert to a `'use client'` component with programmatic `fetch`, inline error display, and a loading state.

### MEDIUM

**3. Version list pagination**
`listAgentVersions` uses `.collect()` — no pagination. Acceptable for v1 (agents typically have <100 versions). Add cursor-based pagination if version counts grow.

### LOW

**4. Event list virtualization**
Timeline and EventInspector load events in pages of 200 but do not virtualize the DOM list. Runs with 10,000+ events loaded incrementally may have sluggish scroll performance. Consider `react-window`.

**5. Background projection verification**
No scheduled job verifies run sequence integrity in production. Integrity checks are on-demand only via `scripts/rebuild-projection.ts`. A Convex cron checking a sample of recent runs would provide proactive alerting.

**6. Live run monitoring**
The run detail page does not auto-refresh while a run is in progress. Engineers watching a live run must manually reload. A polling interval or Convex real-time subscription would improve the debugging workflow.

**7. RBAC viewer-vs-member on read paths**
Roles (`admin`, `member`, `viewer`) are stored and enforced on write mutations. The viewer-vs-member distinction on read paths is deferred.

**8. Version label enrichment at scale**
The run list page fetches one `getAgentVersion` per distinct version ID per page load. At v1 scale (1–3 distinct versions per page) this is fast. Consider caching or a batch query if pages regularly show many distinct versions.

---

## What must NOT be added in v1.1

- Real-time collaboration or live streaming of events to multiple viewers
- Analytics dashboards or aggregate metrics
- Agent marketplace or registry
- Policy engine or compliance features
- Billing or usage metering
- Full deployment/promotion workflows
- Config diffing or version comparison
