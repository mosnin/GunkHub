# ADR 0003: Organization as the Tenancy and Authorization Boundary

**Status:** Accepted
**Date:** April 2026
**Deciders:** Team A (Platform), Team B (Data)

---

## Context

Agent Flight Recorder is a multi-tenant SaaS product. Multiple companies (organizations) use it. Each organization must see only its own data — runs, events, agents, projects. There must be no data leakage between organizations.

We need to define:
1. What the tenancy unit is (user? organization? workspace?)
2. How tenancy maps to authentication (Clerk)
3. How tenancy is enforced in the database layer (Convex)

---

## Decision

**Organization is the tenancy and authorization boundary.**

- Every data entity (Project, Agent, Run, Event, Artifact, Comment) has an `orgId` field that identifies which organization owns it.
- **Every Convex query and mutation must filter by `orgId`.** There are no cross-organization queries.
- **Clerk organizations map 1:1 to Convex orgIds.** The `orgId` stored in all data records is the Clerk organization ID (from the `org_id` JWT claim).
- A user can belong to multiple organizations. The currently active organization is determined by Clerk's `active organization` session concept. Each session operates within exactly one organization context.
- Roles within an organization are: `owner` (1 per org), `admin` (0..n), `member` (0..n). Roles are stored in Clerk, not in AFR's database.

---

## Alternatives Considered

### Option A: User is the tenancy boundary

Each user has their own isolated data. Organizations are a UI grouping only.

**Rejected because:**
- Agent debugging is a team activity. Engineers need to share run views, add comments, and collaborate on post-mortems.
- If data belongs to a user, sharing requires explicit permission grants — complex to build.
- B2B products are sold to organizations, not individuals. Tenancy at the org level matches the business model.

### Option B: Workspace as tenancy (separate from organization)

Introduce a "workspace" concept that sits between user and organization. Users can create multiple workspaces, each with its own data.

**Rejected because:**
- Adds a new concept that doesn't map to anything in Clerk's auth model.
- Over-engineered for v1. If workspaces are needed later, they can be added as a sub-grouping within an organization.
- Clerk already solves the multi-org problem for us with organizations.

### Option C (chosen): Clerk organization = tenancy boundary

Use Clerk's native organization concept. `orgId` from Clerk JWT = tenancy scope in Convex.

This is the simplest approach that gives us multi-tenancy out of the box with Clerk's tooling.

---

## Consequences

### Positive

- **Zero custom auth infrastructure:** Clerk handles user-org membership, org creation, invites, and JWT issuance. AFR inherits all of this for free.
- **Strong security by default:** If a query in Convex forgets to filter by `orgId`, it is a bug that is immediately visible in testing (data from other orgs appears). The pattern is easy to audit.
- **Matches business model:** B2B products are sold per-organization. Billing, limits, and plan features naturally attach to the organization.
- **No org management code needed:** Adding a member to an organization, setting roles, and removing a member all happen in Clerk's dashboard or via Clerk's SDK. AFR does not build any of this.

### Negative / Trade-offs

- **Users without an active org cannot use AFR.** If a user is not a member of any Clerk organization, they will see an empty/onboarding state. This is an edge case but must be handled in the UI.
- **Org creation is Clerk-managed.** The onboarding flow for a new team must guide them to create a Clerk organization. AFR cannot create organizations directly — it just reads the org from the JWT.
- **Changing orgId is a migration.** If a Clerk organization is deleted or merged, the historical data in AFR remains under the original `orgId`. There is no cascading delete. This is acceptable for v1.

### Invariants Established by This Decision

- Every Convex table that stores org-scoped data must have an `orgId` field with a `by_org` index.
- Every Convex `query` function that reads org-scoped data must:
  1. Call `ctx.auth.getUserIdentity()` and verify the identity is not null.
  2. Extract `identity.orgId` from the JWT.
  3. Filter all database queries to `where("orgId", identity.orgId)`.
  4. Never pass `orgId` as a user-supplied argument without verifying it matches `identity.orgId`.
- Every Convex `mutation` function that writes org-scoped data must:
  1. Extract `orgId` from the verified JWT identity.
  2. Stamp the `orgId` onto all created records.
  3. Verify that any existing records being updated/referenced belong to `identity.orgId`.
- The `events` and `runs` tables must have `by_org_run` indexes for efficient org-scoped event queries.
- No Convex function may accept an `orgId` argument from the client and use it without verifying it against the JWT claim.

### Helper Utility

A shared helper function in `convex/_helpers/orgScope.ts` will:
- Extract `orgId` from `ctx.auth`
- Throw `ConvexError("Unauthenticated")` if no identity
- Throw `ConvexError("No active organization")` if no orgId in JWT
- Return the verified `orgId`

All queries and mutations that access org-scoped data must use this helper. This is enforced by code review and can be enforced by a custom ESLint rule if needed.
