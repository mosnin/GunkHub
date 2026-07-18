# e2e/fixtures

## dev-browser-storage-state.json

A Playwright `storageState` snapshot containing exactly one cookie:
`__clerk_db_jwt=e2e-fixture-dev-browser-token` for domain `localhost`.

### Why this exists

`apps/web/middleware.ts` runs `clerkMiddleware` on every request. With a
`pk_test_*` (development instance) publishable key, `@clerk/backend`'s
`authenticateRequestWithTokenInCookie` treats **any** request that lacks the
`__clerk_db_jwt` cookie (or matching query param) as needing a "dev browser"
handshake, and responds with a 307 redirect to the Clerk Frontend API domain
encoded in the publishable key (e.g.
`https://<domain>/v1/client/handshake?...&__clerk_hs_reason=dev-browser-missing`)
before it will serve **any** page — including the public landing page, which
only calls `auth()` to check for a signed-in user.

That redirect target is a fake domain in this suite (no real Clerk instance
backs it), so without this cookie, literally every navigation in the
unauthenticated tier fails outside the app entirely (DNS/TLS error against the
Clerk domain), regardless of Convex.

Pre-seeding this one cookie via `storageState` satisfies the
`hasDevBrowserToken` check in that same function
(`node_modules/@clerk/backend/dist/internal.js`, search
`DevBrowserMissing`), so middleware skips the handshake redirect and serves
the actual page. Clerk does not validate this value beyond "is it present" on
this code path — it is not a session, not a credential, and grants no access;
it only suppresses the dev-instance handshake redirect. Regenerate it (if
ever needed) by running the small script in this file's git history via
`node`, or just hand-edit the `value`/`expires` fields — nothing about its
contents is meaningful.

This is separate from and unrelated to `auth.spec.ts`'s authenticated tier
(actual signed-in sessions), which is skipped — see the comment at the top of
that file.
