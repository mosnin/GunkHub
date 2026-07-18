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

## Process for adding a new ignore

1. Confirm the advisory genuinely cannot be remediated on the current
   dependency line (no patched version compatible with our major versions).
2. Add the GHSA ID to `pnpm.auditConfig.ignoreGhsas` in the root
   `package.json`.
3. Add a row to the table above with package, rationale, and a concrete
   revisit condition.
4. Both changes land in the same PR.
