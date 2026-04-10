# ADR 0016 — Artifact Download via Proxied GET Route

**Status**: Accepted
**Date**: 2026-04-10

## Context

Artifacts recorded for a run are visible in the ArtifactList component — engineers can see the name, MIME type, size, and storage key — but there is no way to retrieve the actual file contents from the UI. Retrieving a blob currently requires direct access to the Convex dashboard or the blob storage backend, which is not acceptable for an engineering debugging tool that promises explainability at every level.

## Decision

Add a GET route `/api/artifacts/[id]/download` that proxies the blob from Vercel Blob storage to the browser as a file download.

The route enforces two layers of authorization:

1. **Clerk session auth** — `auth()` from `@clerk/nextjs/server` must return a `userId`. Unauthenticated requests receive 401.
2. **Org membership via Convex** — the `getArtifact` query (new) resolves the artifact from the database and calls `requireOrgMembership`, which throws if the authenticated user is not a member of the artifact's org. This prevents cross-org access.

The route fetches the blob from `${BLOB_STORE_URL}/${artifact.storageKey}` using an optional bearer token (`BLOB_STORE_TOKEN`). It streams the response body directly to the client, setting `Content-Type`, `Content-Disposition: attachment`, and `Content-Length` from the artifact record stored in Convex.

Error responses are JSON `{ code, message }` objects using the `ApiError` contract type, with status codes:
- 401 — not authenticated
- 404 — artifact not found or org membership denied
- 502 — blob storage not configured or returned a non-OK response
- 500 — unexpected internal error

The `ArtifactList` component adds a download anchor per artifact row using plain HTML (`<a href="..." download>`). The component remains a server component — no `use client` directive is added.

## Consequences

Blob traffic is routed through Next.js serverless functions rather than served directly from blob storage. This adds latency and function invocation cost proportional to artifact size. At v1 scale (small team, infrequent artifact downloads for debugging purposes) this is acceptable. If artifact sizes or download frequency grow significantly, the route can be replaced with a short-lived pre-signed URL redirect — the API surface (`/api/artifacts/[id]/download`) is stable either way.
