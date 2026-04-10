# Next Steps — v1.1 Candidates

**Document type:** State summary and v1.1 candidate list.
**Current state:** Prompt 14 complete.

---

## What Prompt 14 delivered

- Agent version backend: `createAgentVersion` (admin-gated, unique per agent), `listAgentVersions`, `getAgentVersion`
- Schema extended: `configSnapshot` field on `agent_versions`
- Contracts v0.6.1: `AgentVersion.configSnapshot`
- Version history UI on agent detail page (VersionHistory table, CreateVersionModal, VersionSection)
- Run list Version column: shows agent version label where available
- Run detail header: version badge next to agent name
- SDK snippets updated across three surfaces to include `agentVersionId`
- ADR-0019: version identity, config snapshot shape, no active-version pointer

---

## v1.1 Candidates

Listed in rough priority order.

### HIGH

**1. SDK auto-externalization**
The SDK does not detect payloads >10 KB before calling `POST /api/events`. See previous next_steps for full description.

**2. Artifact download error UX**
Download link is a plain `<a download>` anchor. See previous next_steps for full description.

### MEDIUM

**3. Run detail breadcrumb navigation**
No back-navigation from run detail to project or agent. Add `Organization → Project → Agent → Run <id>` breadcrumb with links.

**4. Convex schema drift check**
Add `scripts/check-schema-drift.ts` and call it from `validate.sh`.

**5. Version list pagination**
`listAgentVersions` uses `.collect()` — no pagination. Acceptable for v1 (agents typically have <100 versions). Add cursor-based pagination if version counts grow.

### LOW

**6. Event list virtualization**
Timeline and EventInspector load events in pages of 200 but do not virtualize the DOM. Consider `react-window`.

**7. Background projection verification**
No scheduled job verifies run sequence integrity. On-demand only via `rebuild-projection.ts`.

**8. Live run monitoring**
Run detail page does not auto-refresh while a run is in progress.

**9. RBAC viewer-vs-member on read paths**
Roles enforced on writes; read path distinction deferred.

**10. Version label enrichment at scale**
Run list fetches one `getAgentVersion` per distinct version ID on each page load. Consider caching or a batch query if pages regularly show many distinct versions.

---

## What must NOT be added in v1.1

- Real-time collaboration or live streaming of events to multiple viewers
- Analytics dashboards or aggregate metrics
- Agent marketplace or registry
- Policy engine or compliance features
- Billing or usage metering
- Full deployment/promotion workflows
- Config diffing or version comparison
