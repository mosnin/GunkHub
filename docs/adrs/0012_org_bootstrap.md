# ADR-0012: Organization Bootstrap via Clerk Webhooks

**Status:** Accepted
**Date:** 2026-04-10
**Authors:** Prompt 10 implementation

## Context

Agent Flight Recorder uses Clerk for authentication and organization management. When an
engineer signs up and creates an organization in Clerk, the application must create a
corresponding organization record in Convex before that engineer can use the product.
Similarly, when a user is added to a Clerk organization, a membership row must exist in
Convex so that `requireOrgMembership` can authorize that user's requests.

Without Convex records, Convex queries and mutations cannot enforce tenancy: every query
must filter by `organizationId`, and that value is resolved from the Convex organization
table using `clerkOrgId` as the join key.

### Why webhooks

Clerk does not provide a synchronous server-side hook that runs during organization
creation and allows us to write to Convex in the same transaction. The only supported
mechanism for reacting to Clerk organization lifecycle events is the Clerk webhook system,
which delivers signed HTTP payloads to a registered endpoint.

Webhooks are asynchronous. They are delivered by Clerk after the event has occurred, with
at-least-once delivery semantics. This means:

1. The endpoint must be idempotent — receiving the same event twice must produce the same
   outcome as receiving it once.
2. There is no strict ordering guarantee between `organization.created` and
   `organizationMembership.created`. The membership webhook may arrive while the org
   upsert is still being processed, or (in edge cases) may arrive first.

### The four webhook event types

The following Clerk event types trigger bootstrap mutations:

| Event type | Handler | Convex mutation |
|---|---|---|
| `organization.created` | `handleOrganizationCreated` | `upsertOrganization` |
| `organization.updated` | `handleOrganizationUpdated` | `upsertOrganization` |
| `organizationMembership.created` | `handleOrganizationMembershipCreated` | `upsertOrganization` (defensive) + `upsertMembership` |
| `organizationMembership.updated` | `handleOrganizationMembershipUpdated` | `upsertMembership` |

## Decision

All organization and membership provisioning flows through Clerk webhooks into idempotent
Convex upsert mutations. There is no separate "create org on first login" path, no eager
provisioning from the Clerk dashboard, and no manual SQL seed step.

The two primary mutations are:

- **`upsertOrganization({ clerkOrgId, name, slug })`** — inserts an organization row if
  one with that `clerkOrgId` does not exist; patches `name` and `slug` if it does exist.
  Always defaults `plan` to `"free"` on insert.
- **`upsertMembership({ clerkUserId, clerkOrgId, role })`** — looks up the organization
  by `clerkOrgId`, then inserts a membership row if none exists for
  `(clerkUserId, orgId)`; patches `role` if the membership exists and the role changed.

Both mutations return the current record (post-upsert) and are safe to call multiple
times with identical inputs.

## Bootstrap flow

1. **User creates an organization in Clerk.**
   Clerk sends `organization.created` to `POST /api/webhooks/clerk`.
   The handler calls `upsertOrganization({ clerkOrgId, name, slug })`.
   A new organization row is inserted in Convex with `plan: "free"`.

2. **Clerk adds the creating user as an org admin.**
   Clerk sends `organizationMembership.created` with `role: "org:admin"`.
   The handler defensively calls `upsertOrganization` first (in case the org webhook
   has not yet been processed or was dropped), then calls `upsertMembership` with the
   resolved Convex `orgId` and the mapped internal role `"admin"`.

3. **An existing member's role is updated.**
   Clerk sends `organizationMembership.updated` with the new Clerk role.
   The handler calls `upsertMembership`. If the internal role has changed, the
   membership row is patched; if it has not changed, the write is skipped.

4. **An organization's name or slug changes.**
   Clerk sends `organization.updated`.
   The handler calls `upsertOrganization`. The name and slug fields are patched on the
   existing Convex record. No new record is created.

## Idempotency

All four mutations are idempotent by design:

- **`upsertOrganization`** is idempotent on `clerkOrgId`. If an org with that Clerk ID
  already exists, the mutation updates its name/slug and returns the existing record.
  Re-delivering `organization.created` (Clerk's at-least-once guarantee) is harmless.

- **`upsertMembership`** is idempotent on the compound key `(clerkUserId, orgId)`.
  If a membership already exists with the same role, no write occurs. If the role
  changed, the row is patched. Re-delivering `organizationMembership.created` is
  harmless.

The defensive `upsertOrganization` call inside `handleOrganizationMembershipCreated`
makes the membership handler idempotent even when it races with the org webhook: if the
org row does not exist yet, it is created; if it already exists, the upsert is a no-op.

## Role mapping

Clerk roles are strings prefixed with `org:`. The internal `role` field in Convex
membership rows uses the values defined in `AuthContext['orgRole']` from
`@agent-flight-recorder/contracts`:

| Clerk role | Internal role | Notes |
|---|---|---|
| `org:admin` | `admin` | Exact match required |
| `org:member` | `member` | |
| Any other value | `member` | Safe default — never escalate unknown roles |

`"viewer"` is a local-only internal role. It is never produced by `clerkRoleToInternal`.
Viewer membership rows can only be created by explicit in-app mutation (e.g., an org
admin grants view-only access to a contractor). Clerk has no corresponding role concept.

The `clerkRoleToInternal` function is implemented in
`apps/web/app/api/webhooks/clerk/route.ts`. Its contract is:

```typescript
function clerkRoleToInternal(clerkRole: string): 'admin' | 'member' | 'viewer' {
  if (clerkRole === 'org:admin') return 'admin'
  return 'member'
}
```

## Consequences

### Access timing

Users can only access the application after `organizationMembership.created` has been
delivered and processed. If the webhook is delayed (Clerk webhook queue backlog) or
fails processing (unhandled exception in the route handler), the user will see a 403
from `requireOrgMembership` even though they have a valid Clerk session.

`requireOrgMembership` looks up the membership row in Convex using the Clerk user ID and
org ID from the JWT. If no row is found, it throws and the request is rejected. This is
intentional: no Convex row means the bootstrap has not completed.

### Webhook delivery ordering is not guaranteed

The `organizationMembership.created` webhook can arrive before `organization.created` in
some edge cases (e.g., webhook infrastructure retries, race between Clerk internal
services). The defensive `upsertOrganization` call in `handleOrganizationMembershipCreated`
handles this: it ensures the org row exists before the membership row is inserted,
regardless of delivery order.

### Webhook signature validation

The handler validates the `svix-id`, `svix-timestamp`, and `svix-signature` headers
using the `CLERK_WEBHOOK_SECRET` environment variable. If the secret is misconfigured
(wrong value, missing value), all webhook deliveries are rejected with a 400 response.
Clerk will retry rejected deliveries. This results in a loop of failed deliveries until
the secret is corrected. The failure mode is visible in the Clerk dashboard webhook
delivery log.

### Pre-existing Clerk users

If the deployment receives Clerk users who joined an organization before the webhook
endpoint was registered (e.g., during initial deployment), those users will have no
membership rows in Convex. They will see 403 errors on every request. These users
require manual membership row creation via a seed script or direct Convex mutation.

## Known limitations

1. **Misconfigured `CLERK_WEBHOOK_SECRET` produces silent user-facing failures.** If the
   secret is wrong, bootstrap never runs, users cannot access the product, and the only
   diagnostic signal is the Clerk dashboard's webhook delivery log showing repeated 400
   responses. The error message in the route handler logs the rejection reason, but it is
   not surfaced in the UI.

2. **First-party users who predated webhook registration need manual bootstrap.** Any
   Clerk organization that existed before the webhook endpoint was activated will never
   receive `organization.created` or `organizationMembership.created` events. An
   operator must manually call `upsertOrganization` and `upsertMembership` for each
   such organization, or run a one-time migration script against the Clerk API.

3. **No retry on Convex mutation failure.** If `upsertOrganization` or `upsertMembership`
   throws (e.g., Convex deployment is temporarily unavailable), the webhook handler
   returns a non-2xx status and Clerk will retry the delivery. This is correct behavior,
   but the retry interval is controlled by Clerk (exponential backoff with a maximum
   retry window). Extended Convex downtime could exceed Clerk's retry window, causing
   the event to be permanently dropped.

4. **`plan` field is always initialized to `"free"`.** Webhook bootstrap does not have
   visibility into billing state. Plan upgrades must be handled via a separate billing
   webhook or in-app flow, not via the org lifecycle webhooks.

## Related ADRs

- ADR-0003: Tenancy Boundary (defines the orgId enforcement requirement)
- ADR-0004: Shared Contracts Package (defines the `Organization` and `AuthContext` types)
- ADR-0007: Ingestion Idempotency (establishes the idempotency pattern for other mutations)
