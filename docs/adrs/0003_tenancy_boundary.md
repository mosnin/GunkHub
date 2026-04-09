# ADR 0003: Organization is the Tenancy Boundary

**Status:** Accepted  
**Date:** 2026-04-09

---

## Context

Agent Flight Recorder is a multi-tenant SaaS product. Data isolation between customers is a non-negotiable security requirement. The question is: at what granularity should tenancy be enforced?

Options:
1. User-level tenancy (each user owns their data)
2. Organization-level tenancy (each organization owns its data)
3. Workspace-level tenancy (a user can have multiple isolated workspaces)

---

## Decision

**Organization is the tenancy and authorization boundary.**

- Every database table has an `orgId` field.
- Every Convex query and mutation must scope results to the caller's organization.
- Clerk organizations map 1:1 to Convex organization records.
- Cross-organization data access is architecturally impossible.

---

## Rationale

1. **Natural billing unit**: Organizations are the natural unit for billing, plans, and limits. Aligning tenancy with billing avoids complexity later.

2. **Team collaboration**: Engineers within the same organization need to share access to runs, projects, and agents. User-level isolation would prevent this.

3. **Clerk alignment**: Clerk has first-class support for organizations. Clerk's `orgId` maps directly to the tenancy boundary, simplifying auth integration.

4. **Security by default**: Putting `orgId` on every table and scoping every query is the simplest enforcement mechanism. It's hard to accidentally return data across org boundaries.

5. **Appropriate granularity for v1**: Workspace-level isolation is a common upsell feature (e.g., "team workspaces"). Starting at org level preserves the option to add workspace sub-tenancy later without rebuilding the security model.

---

## Consequences

- **Every query must include orgId**: This is a query-time requirement, enforced by `getAuthContext()` in `convex/auth.ts`.
- **Clerk org change = context change**: If a user switches Clerk organizations, all queries must re-scope. The frontend must handle this transition cleanly.
- **No admin cross-org queries in v1**: There is no super-admin role in v1. Future admin features require explicit design.
- **Organization bootstrap required**: When a Clerk organization is created, a corresponding Convex organization record must be created (via webhook).

---

## Enforcement Mechanisms

1. **Database design**: `orgId` is a required field on every table.
2. **`getAuthContext()` helper**: All Convex mutations and queries must call this and use the returned `orgId` for scoping.
3. **`CLAUDE.md` rule**: "Never return data across org boundaries."
4. **`.claude/agents/data.md` forbidden behavior**: "NEVER return data across org boundaries."
5. **TypeScript**: All service functions accept and pass `orgId` explicitly.

---

## Alternatives Considered

### Option A: User-level tenancy
- **Rejected**: Prevents team collaboration. User A cannot share a run with User B even within the same company.

### Option B: Account-level tenancy (separate from Clerk org)
- **Rejected**: Adds a separate concept that duplicates Clerk's organization model. Complexity without benefit.

### Option C: Project-level tenancy
- **Rejected**: Too granular. Projects should be shareable within an org. Cross-project access controls can be added in v2 if needed.
