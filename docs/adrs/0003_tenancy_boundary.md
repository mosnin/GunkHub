# ADR-0003: Organization is the Tenancy and Authorization Boundary

**Status:** Accepted
**Date:** 2026-04-09
**Deciders:** Initial foundation team (Prompt 1)

---

## Context

Agent Flight Recorder is a multi-tenant SaaS product. Data isolation between customers is a non-negotiable security requirement — a data leak between tenants would be a critical security incident.

The question is: at what granularity should tenancy be enforced?

**Option A: User-level tenancy** — each user owns their own data. Users cannot share data with teammates.

**Option B: Organization-level tenancy (CHOSEN)** — each Clerk organization owns all data created by its members. Members can see each other's runs.

**Option C: Workspace-level tenancy** — a user can have multiple isolated workspaces within an account, potentially spanning organizations.

The system must choose a tenancy model before writing a single Convex table definition, because `orgId` must be present as an index field on every table.

---

## Decision

**Organization is the tenancy and authorization boundary.**

Specifically:
- The `organizations` table in Convex maps 1:1 to Clerk organizations via `clerkOrgId`
- Every other table has a required `orgId: v.id("organizations")` field
- Every Convex query and mutation must call `getAuthContext(ctx)` and scope all data access to the returned `orgId`
- Cross-organization data access is architecturally impossible — the query structure prevents it
- `requireOrgMembership(ctx, orgId)` must be called before accessing any data, verifying the authenticated user is a member of the target org

---

## Rationale

**Natural billing unit.** Organizations are the natural unit for billing, plan limits, and feature access. Aligning tenancy with the billing unit avoids complexity later — there is no mapping between "the entity that pays" and "the entity that owns data."

**Team collaboration.** Engineers within the same company need to share access to runs, projects, and agents. User A needs to see User B's failed run to debug it together. User-level isolation makes this impossible without a sharing mechanism, which adds complexity.

**Clerk alignment.** Clerk has first-class support for organizations. The Clerk JWT includes `org_id` as a standard claim. `convex/auth.ts` extracts `org_id` from the JWT and looks up the corresponding Convex org record. This integration is clean and well-tested by the Clerk ecosystem.

**Security by default.** Putting `orgId` on every table and requiring it in every query creates a structural guarantee. A query that lacks `orgId` filtering will either fail to compile (if `orgId` is a required parameter) or return no results (if the filter produces an empty result set). Data leakage requires an active mistake, not a passive omission.

**Appropriate granularity for v1.** Workspace-level isolation (e.g., Slack-style "workspaces" within an account) is a common enterprise upsell feature. Starting at org level preserves the option to add workspace sub-tenancy later without rebuilding the security model. The `orgId` → `projectId` hierarchy already provides one level of logical grouping below the org.

---

## Consequences

**Every query must include orgId.** This is not optional. `getAuthContext()` must be called first, and the returned `orgId` must be used in every index query. This is enforced by convention (CLAUDE.md, agent definitions) and by the fact that every index on every table includes `orgId` as the primary component.

**Clerk org change = context change.** If a user switches their Clerk organization (via Clerk's organization switcher), the frontend must re-initialize all Convex queries with the new org context. The `ConvexProviderWithClerk` integration handles token rotation, but the UI must handle the state transition gracefully (redirect to dashboard, clear stale data).

**No admin cross-org queries in v1.** There is no super-admin role or cross-org query mechanism. Internal support tooling (if needed) requires a separate implementation outside the normal query path. Do not add cross-org admin queries without a dedicated ADR.

**Organization bootstrap required.** When a new Clerk organization is created, a corresponding Convex `organizations` record must be created. This is done via a Clerk webhook that fires `organization.created` events to a Next.js webhook handler. The handler calls the `createOrg` Convex mutation. Without this bootstrap, users in a new org will get "organization not found" errors. Prompt 2 must implement this webhook.

**Role enforcement is layered.** `requireOrgMembership()` currently verifies that the user is a member of the org, but does not enforce role-based access (admin vs. member vs. viewer). Full RBAC is a Prompt 3+ feature. The `UserMembership.role` field already exists in the schema for when this is needed.

---

## Enforcement Mechanisms

1. **Database design:** `orgId: v.id("organizations")` is a required field on `projects`, `agents`, `agent_versions`, `runs`, `events`, `artifacts`, `comments`, `user_memberships`. There is no table (except `organizations` itself) that lacks `orgId`.

2. **`getAuthContext()` helper:** `convex/auth.ts` exports `getAuthContext(ctx)` which extracts the Clerk user identity and resolves the Convex `orgId`. All mutations and queries call this before any data access.

3. **`requireOrgMembership()` helper:** `convex/auth.ts` exports `requireOrgMembership(ctx, orgId)` which verifies the authenticated user has a `UserMembership` record for the given org. Called in every mutation and query that accesses org-scoped data.

4. **CLAUDE.md rule:** "Never return data across org boundaries. If a query for org A could ever return a record belonging to org B, it is a security defect."

5. **`.claude/agents/data.md` forbidden behavior:** "NEVER return data across org boundaries." This rule is visible to the data agent at the start of every session.

6. **Index design:** Every table's primary index includes `orgId` as the first component (e.g., `by_org: ["orgId"]`). Queries that use these indexes will only scan documents belonging to the target org.

---

## Alternatives Considered

### Option A: User-level tenancy

Each user owns their data. Sharing requires explicit sharing grants.

Rejected because: prevents natural team collaboration. An ML engineer who ran a failing experiment cannot share the run with their tech lead for review without a sharing mechanism. Building that sharing mechanism adds more complexity than organization-level tenancy avoids.

### Option B: Account-level tenancy (separate from Clerk org)

Create a custom "Account" entity distinct from Clerk organizations. Users can belong to multiple accounts.

Rejected because: this duplicates Clerk's organization model. Clerk already handles multi-org membership, org switching, and org-level roles. Creating a parallel structure adds complexity without benefit.

### Option C: Workspace-level tenancy

A user can create multiple isolated workspaces (like Slack workspaces or Notion workspaces) within an account. Each workspace is a separate tenancy unit.

Rejected for v1 because: adds a concept ("workspace") that is not in the required stack and not needed to deliver the core debugging value. The `Project` entity already provides logical grouping within an org. Workspace-level isolation can be layered on top of the org model in a future version if demand emerges.
