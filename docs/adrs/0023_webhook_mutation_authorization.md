# ADR-0023: Authorization for Webhook-Only Lifecycle Mutations

**Status:** Accepted (interim) — supersedes the implicit trust model in ADR-0012
**Date:** 2026-07-16
**Context:** Comprehensive audit (Phase 0 remediation) — critical tenancy defect

---

## Context

The organization-lifecycle mutations in `convex/organizations.ts` —
`upsertOrganization`, `createOrganization`, and `upsertMembership` — were exported
as **public** Convex `mutation`s with no authorization check. The design intent
(documented in ADR-0012, org bootstrap) was that only the Clerk webhook route
would ever call them, after verifying the Svix signature.

The audit proved this intent is not enforced. Public Convex functions are callable
by anyone who knows the deployment URL. Because the webhook route calls them via an
*unauthenticated* `ConvexHttpClient` (`getPublicClient()`), there is no session,
signature, or secret on the Convex side to distinguish the trusted webhook from an
attacker. Concretely:

```
convex.organizations.upsertMembership({
  clerkUserId: <attacker's own Clerk subject>,
  clerkOrgId:  <victim org — a public org_… id, not a secret>,
  role:        "admin",
})
```

This inserts a `user_memberships` row binding the attacker to the victim org as
admin. Every downstream authorization check is `requireOrgMembership`, which only
verifies the presence of such a row — so the attacker then passes every membership
and admin gate for the victim tenant: read all runs/events/artifacts/comments, and
mint or revoke API keys. This defeats the entire tenancy boundary (the product's
first-order security guarantee).

`upsertOrganization` / `createOrganization` are the same class of defect at lower
impact (org rename / slug rewrite / squatting).

---

## Decision

### Interim (shipped in this change)

Gate all three lifecycle mutations behind a **shared secret**. Each mutation takes
a `webhookSecret` argument and rejects the call unless it matches the
`CONVEX_WEBHOOK_SECRET` environment variable configured on the Convex deployment.
The Next.js webhook route — which has already verified the Svix signature —
presents the secret from its own `CONVEX_WEBHOOK_SECRET` env var.

This closes the hole: an attacker calling the public mutation directly does not
possess the secret and is rejected with `Unauthorized`.

### Target (tracked, not yet implemented)

Convert the three mutations to `internalMutation`, which is unreachable from any
external client. Move Svix signature verification into a Convex `httpAction`
(`convex/http.ts`) that receives the raw webhook, verifies the signature in-backend,
and calls the internal mutations. At that point the Next.js webhook route and the
shared secret are removed entirely — the signature *is* the authorization, verified
where the data lives. This is the correct end state; the shared secret is scaffolding
until it lands.

---

## Consequences

- **Positive:** the critical cross-tenant escalation is closed immediately with a
  minimal, reviewable change. No restructuring of the webhook flow required.
- **Negative:** two secrets must now be kept in sync (`CONVEX_WEBHOOK_SECRET` on
  both the Convex deployment and the Next.js runtime). Documented in `.env.example`.
- **Negative:** the mutations remain on the public function surface until the
  `internalMutation` migration; a leaked secret re-opens the hole. Rotate on suspicion.
- **Follow-up:** `getOrganization` is still a public query returning org metadata by
  `clerkOrgId`. It should become an `internalQuery`; tracked separately.

---

## Related

- ADR-0003 (tenancy boundary) — the guarantee this defect violated.
- ADR-0012 (org bootstrap) — established the webhook-only assumption, now enforced.
