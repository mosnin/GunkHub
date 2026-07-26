# Enterprise Auth: SSO/SAML, SCIM, and the Session/JWT Trust Model

Audience: engineers evaluating or configuring enterprise identity for an Agent
Flight Recorder org. Accurate to the code as of this cycle — every claim below
cites the file it describes. Auth in this repo is **fully Clerk-delegated**:
Agent Flight Recorder never implements its own identity provider, session
store, or SAML/OIDC handshake. This document describes what Clerk gives us,
what already works unchanged, and what SCIM wiring would require.

---

## 1. SSO / SAML — Clerk Enhanced/Enterprise SSO connections

Agent Flight Recorder authenticates entirely through Clerk
(`@clerk/nextjs`, see `apps/web/middleware.ts` and `apps/web/src/lib/auth.ts`).
Clerk Organizations (not a bespoke tenancy table) is the identity source for
both "who is this user" and "which org are they acting as."

**What Clerk's dashboard configures, outside this repo:**

- SAML/OIDC enterprise connections are configured per-organization in the
  Clerk Dashboard (Clerk "Enhanced" / "Enterprise SSO" plans support this).
  An org admin adds their IdP (Okta, Azure AD, Google Workspace, generic
  SAML, etc.), maps attributes, and Clerk handles the full SSO handshake.
- This repo has **no code path that needs to change** for a customer to turn
  on SAML — Clerk issues the same session/JWT shape regardless of whether the
  user authenticated via password, social login, or an enterprise IdP. The
  application layer is IdP-agnostic by construction.

**What already works unchanged once SSO is enabled for an org:**

- `apps/web/middleware.ts` gates `/projects`, `/agents`, `/runs`, `/dashboard`,
  `/settings`, `/diff` behind `clerkMiddleware()` + `auth().protect()` — this
  does not care how the session was established.
- `apps/web/src/lib/auth.ts` (`getCurrentAuth()`) reads `auth().userId`,
  `auth().orgId`, and `auth().orgRole` from the Clerk session claims. These
  three fields are what the entire web tier treats as identity — an
  SSO-authenticated session populates the exact same fields.
- `convex/auth.ts` (`getAuthContext()`) does the equivalent on the Convex side:
  it calls `ctx.auth.getUserIdentity()`, reads the `org_id` custom claim off
  the Clerk JWT, and resolves that Clerk org ID to the local `organizations`
  row via the `by_clerk_org_id` index (see `convex/organizations.ts`,
  `getOrganization`). This is the **only** join point between Clerk's
  identity model and Convex's tenancy model (CLAUDE.md "Tenancy Rules" #4).
- Because org claims flow through Clerk's session token unchanged regardless
  of auth method, **no code in `getAuthContext`, `requireOrgMembership`, or
  `getCurrentAuth` needs to branch on "is this an SSO session."** SSO is
  invisible below the Clerk SDK boundary.

**What is NOT yet exposed in-product:** there is no UI in this repo for an
org admin to configure their SAML connection — that happens in the Clerk
Dashboard directly today. A future cycle could add a deep-link from
`/settings` into the relevant Clerk Dashboard org-settings page, but building
a SAML config UI ourselves would fork configuration authority away from Clerk
and is out of scope (see CLAUDE.md "Not in v1": no policy engine / compliance
UI this cycle, and the Members section explicitly keeps role authority in
Clerk rather than forking it — see `apps/web/src/components/settings/MembersSection.tsx`).

---

## 2. SCIM — status and what wiring would look like

**Current status: not wired.** Clerk offers SCIM provisioning as part of its
Enterprise SSO connections (IdP-initiated user/group lifecycle sync — create,
update, deactivate). This repo does not currently configure or consume a SCIM
endpoint; provisioning today happens via Clerk's own organization membership
UI/API, propagated to Convex through the existing webhook path described
below.

**What already exists that SCIM deprovisioning would reuse, unmodified:**

SCIM's most consequential event for a debugging tool like this one is **user
deactivation** — when an offboarded employee should immediately lose access.
That plumbing already exists and does not depend on SCIM being wired up:

- `apps/web/app/api/webhooks/clerk/route.ts` handles the Clerk
  `organizationMembership.deleted` event (line ~188) by calling
  `organizations:removeMembership` (`convex/organizations.ts`), which deletes
  the `user_memberships` row for `(clerkOrgId, clerkUserId)` and records an
  audit event (`membership.removed`). This is exactly the event a
  SCIM-driven "deactivate user" action fires in Clerk — Clerk emits
  `organizationMembership.deleted` (or a membership role transition) the same
  way whether the removal was triggered by an admin clicking "Remove member"
  in the Clerk dashboard, an IdP-driven deprovisioning event via SCIM, or an
  API call. **No new webhook handler is needed for the deactivation path** —
  it is already correct per `convex/auth.ts`'s `requireOrgMembership`, which
  throws `Unauthorized: not a member of this organization` the moment that
  row is gone, on every subsequent Convex call.
- Role changes flow the same way through `organizationMembership.updated` →
  `organizations:upsertMembership` (idempotent patch + `membership.upserted`
  audit row).
- Full org offboarding (SCIM "deprovision tenant") maps to Clerk's
  `organization.deleted` event, already handled by
  `organizations:markOrganizationPendingDeletion` — this only **marks**
  `pendingDeletionAt`; actual data erasure remains the deliberate,
  operator-invoked `retention:purgeOrganization` path per ADR-001
  (`docs/adr/001-data-retention-and-erasure.md`). SCIM would not change this:
  the repo's stance is that irreversible deletion is never a side effect of
  an identity-provider event, SCIM-driven or not.

**What SCIM wiring would actually require**, if a customer needs standards-based
provisioning:

1. Enabling Clerk's SCIM feature for the org's enterprise connection (Clerk
   Dashboard / Clerk's SCIM API — outside this repo).
2. Verifying that Clerk's SCIM-driven user/group operations emit the same
   `organizationMembership.*` and `organization.*` webhook events already
   consumed at `apps/web/app/api/webhooks/clerk/route.ts` — Clerk's docs
   indicate they do, since SCIM operations go through the same organization
   membership model Clerk uses everywhere else. No separate SCIM endpoint
   needs to be built in this repo as a result.
3. If Clerk ever introduces SCIM-specific webhook event types distinct from
   the existing `organizationMembership.*` family, add matching `case`
   branches to the `switch (event.type)` block in
   `apps/web/app/api/webhooks/clerk/route.ts` (currently handles
   `organization.created/updated/deleted`,
   `organizationMembership.created/updated/deleted` — unrecognized event
   types are acknowledged and ignored, not errored, so this is additive and
   safe to defer).
4. Role mapping: `clerkRoleToInternal()` in that same route currently maps
   Clerk's `org:admin` → `admin`, everything else → `member`. `viewer` is a
   local-only role with no Clerk equivalent (`convex/schema.ts`
   `user_memberships.role`) — a SCIM group-to-role mapping would need either
   a Clerk custom role or a manual promotion step, same as today for `viewer`.

---

## 3. Session / JWT trust model

- **Clerk issues the JWT.** The web tier gets it via `@clerk/nextjs`'s
  `auth()` helper (server components, API routes) — see
  `apps/web/src/lib/auth.ts`. Convex gets a Convex-templated Clerk JWT via
  `getAuthedClient()` (`apps/web/src/lib/convexServer.ts`), which calls
  `auth().getToken({ template: 'convex' })` and sets it on the
  `ConvexHttpClient`. Convex functions read the org claim off that token
  through `ctx.auth.getUserIdentity()` (`convex/auth.ts`).
- **The `org_id` custom claim is the trust anchor.** Every Convex query/
  mutation that touches org-scoped data calls `getAuthContext()` or
  `requireOrgMembership()` first (CLAUDE.md "Tenancy Rules" #1, #5), which
  resolves that claim to a `organizations` row via `by_clerk_org_id` — never
  by trusting an org ID passed as a plain argument. `getOrganization`
  (`convex/organizations.ts`) additionally asserts the caller's own `org_id`
  claim matches the org being resolved, so a caller cannot probe another
  org's metadata by guessing IDs.
- **Two distinct auth planes, never conflated:**
  1. **Clerk session (JWT)** — used for every page under `(app)/` and every
     `apps/web/app/api/**` route that serves the browser UI (Members, API
     Keys, Usage, Retention, etc. all require `auth().userId`/`orgId` per
     the `withApiHandler` pattern — see `apps/web/src/lib/apiHandler.ts`).
  2. **API key (`x-api-key` header, SHA-256 hash stored in Convex)** — used
     exclusively by the SDK ingestion routes (`/api/events`, `/api/runs`,
     `/api/artifacts`). This plane never touches Clerk and is scoped,
     rate-limited, and revocable independently (`convex/api_keys.ts`). See
     the Rotation flow in `apps/web/src/components/settings/ApiKeysSection.tsx`
     for the human-driven key lifecycle (no session/JWT trust involved here
     at all — possession of the raw key is the only credential).
- **Webhook plane (Svix signature, not a session at all).** The Clerk→Convex
  sync path (`apps/web/app/api/webhooks/clerk/route.ts`) is authenticated by
  Svix signature verification, then re-authenticated into Convex via a
  shared secret (`CONVEX_WEBHOOK_SECRET`, checked with a constant-time
  compare in `assertWebhookSecret()`, `convex/organizations.ts`) — because
  the webhook-only mutations (`upsertOrganization`, `upsertMembership`,
  `removeMembership`, `markOrganizationPendingDeletion`) are reachable on
  Convex's public function surface and a Clerk JWT is never present on this
  path (ADR-0023 tracks moving this to an internal-mutation + in-backend
  Svix verification model).
- **Nothing in this repo issues, refreshes, or invalidates sessions itself.**
  Sign-out, session expiry, and MFA are entirely Clerk's responsibility;
  the app only ever reads the current session's claims.

---

## References

- `apps/web/middleware.ts` — route protection matcher
- `apps/web/src/lib/auth.ts` — `getCurrentAuth()`
- `apps/web/src/lib/convexServer.ts` — `getAuthedClient()`, Convex-templated JWT
- `convex/auth.ts` — `getAuthContext()`, `requireOrgMembership()`
- `convex/organizations.ts` — org resolution, membership upsert/remove,
  pending-deletion marker, `listMemberships` (added this cycle)
- `apps/web/app/api/webhooks/clerk/route.ts` — Clerk→Convex sync, event types
  handled, role mapping
- `docs/adr/001-data-retention-and-erasure.md` — erasure model referenced above
- CLAUDE.md — "Tenancy Rules", "Event Log Rules" #6 (audit trail)
