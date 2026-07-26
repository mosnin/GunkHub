# Dependency Audit Ignores

Authoritative record of every GHSA advisory suppressed via
`pnpm.auditConfig.ignoreGhsas` in the root `package.json`. The CI
`dependency-audit` job (`.github/workflows/ci.yml`) gates on high/critical
advisories in production dependencies and points here for rationale.

**Rules:**

- Every entry in `ignoreGhsas` MUST have a row in this table.
- Every row MUST have a concrete revisit condition — "never" is not a valid
  entry.
- When the revisit condition is met (e.g. the framework upgrade lands), remove
  the ignore in the same PR and confirm `pnpm audit --prod --audit-level=high`
  passes.

## Currently ignored advisories

| GHSA | Package | Why it cannot be remediated today | Revisit condition |
|------|---------|-----------------------------------|-------------------|
| GHSA-h25m-26qc-wcjf | `next` | Patched range is `>=15.x` only. We run the latest 14.2.x (14.2.35), which contains all backported 14.2-line security fixes. | Next.js 15 upgrade |
| GHSA-q4gf-8mx6-v5v3 | `next` | Same as above — 15.x-only patch; 14.2.35 carries the 14.2-line backports. | Next.js 15 upgrade |
| GHSA-8h8q-6873-q5fj | `next` | Same as above — 15.x-only patch; 14.2.35 carries the 14.2-line backports. | Next.js 15 upgrade |
| GHSA-c4j6-fc7j-m34r | `next` | Same as above — 15.x-only patch; 14.2.35 carries the 14.2-line backports. | Next.js 15 upgrade |
| GHSA-36qx-fr4f-26g5 | `next` | Same as above — 15.x-only patch; 14.2.35 carries the 14.2-line backports. | Next.js 15 upgrade |
| GHSA-w24r-5266-9c3c | `@clerk/clerk-react` (transitive via `@clerk/nextjs@5.x`, which pins `clerk-react` 5.12.0, and `convex`) | Fixed range (`>=5.61.6`) requires `@clerk/shared` 3.x, which is incompatible with the Clerk 5.x line we are on. | Clerk 6 upgrade |
| GHSA-p9j2-gv94-2wf4 | `next` | SSRF via an attacker-controlled `destination` hostname in a `rewrites()` rule. **We define no rewrites at all.** `apps/web/next.config.js` exports only `transpilePackages` and an `async headers()` block — there is no `rewrites`, `redirects`, or `beforeFiles`/`afterFiles`/`fallback` proxy rule anywhere in the repo. With no rewrite destination there is no attacker-reachable sink for this bug. Patched range is `>=15.5.21`; the 14.2 line received no backport and 14.2.35 is the final 14.2.x release. | Adding **any** `rewrites()` rule to `apps/web/next.config.js` — especially one interpolating a request value (`:path*`, header, or query) into `destination` — makes this immediately exploitable and the ignore must be dropped. Otherwise revisit at the Next.js 15 upgrade. |
| GHSA-89xv-2m56-2m9x | `next` | SSRF in Server Actions **on custom servers**. The advisory's precondition is a self-hosted custom Node server (`server.js` calling `next({...})` and hand-rolling request routing), where the `Host`/`Origin` headers Next.js trusts for Server Action origin checks are supplied by the wrapper. **We run no custom server.** `apps/web/package.json` scripts are plain `next dev` / `next start`, there is no `server.js`/`server.ts` in the repo, and production runs on Vercel's managed Next.js runtime, which sets these headers itself. Patched range is `>=15.5.21`, with no 14.2 backport. | Introducing a custom Node server entrypoint for `apps/web`, or moving off Vercel's managed runtime to self-hosted `next start` behind a proxy that forwards a client-controlled `Host`/`X-Forwarded-Host`. Otherwise revisit at the Next.js 15 upgrade. |
| GHSA-m99w-x7hq-7vfj | `next` | **This one genuinely applies to our code — it is an accepted risk, not a non-applicable finding.** We do use App Router Server Actions: six modules under `apps/web/src/lib/actions/` (`projects`, `agents`, `agent_versions`, `runs`, `comments`, `verification`). A malformed/oversized Server Action request body can be made to consume disproportionate server resources. Partial mitigation, verified: every call site is a component rendered under `/projects`, `/agents`, or `/runs`, all of which `apps/web/middleware.ts` matches via `isProtectedPage` and guards with `auth().protect()`. Clerk middleware runs before the Server Action body is parsed, so an anonymous attacker is redirected to sign-in and never reaches the vulnerable path — this narrows the surface from the open internet to an authenticated member of a provisioned org, but it does **not** eliminate the bug. No remediation exists on our major version: patched range is `>=15.5.21` and the 14.2 line got no backport, so the only fix is a Next.js 15 major upgrade, which is out of scope for this change. | Next.js 15 upgrade — this should be a **priority driver** for scheduling it, not a passive wait. Also revisit immediately if any Server Action is ever invoked from an unauthenticated route (i.e. a call site appears outside the `isProtectedPage` matcher), which would restore full pre-auth exposure. |

## Process for adding a new ignore

1. Confirm the advisory genuinely cannot be remediated on the current
   dependency line (no patched version compatible with our major versions).
2. Add the GHSA ID to `pnpm.auditConfig.ignoreGhsas` in the root
   `package.json`.
3. Add a row to the table above with package, rationale, and a concrete
   revisit condition.
4. Both changes land in the same PR.
