# Deployment Checklist — Agent Flight Recorder

Use this checklist when moving between environments. Work through each section in
order. Every unchecked item is a potential failure mode in production.

---

## Pre-deployment (all environments)

- [ ] `pnpm typecheck` passes with zero errors across all packages
- [ ] `./scripts/validate.sh` passes all three checks (typecheck, build, lint)
- [ ] `pnpm test` passes — all 356+ tests green, no regressions
- [ ] `.env.local` is complete — all required variables are set (see `.env.example`)
- [ ] No `.env.local` or secret files are staged for commit

---

## Convex deployment

- [ ] Run `npx convex deploy` to push the schema and functions to the target deployment
- [ ] Verify in the Convex dashboard that all tables are present:
  `organizations`, `projects`, `agents`, `agent_versions`, `runs`, `events`,
  `artifacts`, `comments`, `user_memberships`
- [ ] Verify indexes are in place (check the schema tab in the Convex dashboard)
- [ ] Verify `CLERK_JWT_ISSUER_DOMAIN` in `convex/auth.config.ts` matches the
  production Clerk frontend API domain
- [ ] Verify `NEXT_PUBLIC_CONVEX_URL` is set to the production deployment URL
  (format: `https://<deployment-name>.convex.cloud`)

---

## Clerk setup

- [ ] Production Clerk application created and configured at https://dashboard.clerk.com
- [ ] `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` set to the production publishable key
  (starts with `pk_live_`)
- [ ] `CLERK_SECRET_KEY` set to the production secret key (starts with `sk_live_`)
- [ ] Clerk JWT Template named exactly `"convex"` is configured:
  Clerk Dashboard → JWT Templates → New Template → select "Convex" → name "convex"
- [ ] Clerk webhook endpoint configured:
  Clerk Dashboard → Webhooks → Add Endpoint → `https://<prod-domain>/api/webhooks/clerk`
- [ ] Clerk webhook subscribed to the following events:
  - `organization.created`
  - `organization.updated`
  - `organizationMembership.created`
- [ ] `CLERK_WEBHOOK_SECRET` set to the signing secret from the webhook endpoint
  (format: `whsec_...`)

---

## Blob storage (required for event payloads > 10 KB)

- [ ] Blob store created (Vercel dashboard → Storage → Blob → Create Store)
- [ ] `BLOB_STORE_TOKEN` set to the read-write token from the blob store
  (Vercel dashboard → Storage → your store → `.env.local` tab)
- [ ] `BLOB_STORE_URL` set to the public base URL of the blob store
  (format: `https://<store-name>.public.blob.vercel-storage.com`)
- [ ] Smoke test artifact upload:
  ```
  curl -X POST https://<prod-domain>/api/artifacts/upload \
    -H "x-api-key: <your-api-key>" \
    -H "Content-Type: application/json" \
    -d '{"runId":"test","key":"test/smoke.json","payload":"'$(python3 -c "print('x'*11000)"}'"}'
  ```
  Expected: HTTP 200 with `{ "storageKey": "...", "checksum": "...", "size": ... }`
- [ ] `GET /api/health` shows `storage.adapter = "vercel"` and `storage.configured = true`

---

## Vercel deployment

- [ ] All environment variables are set in Vercel project settings for the
  **Production** environment (Settings → Environment Variables):
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
  - `CLERK_SECRET_KEY`
  - `CLERK_WEBHOOK_SECRET`
  - `CLERK_JWT_ISSUER_DOMAIN`
  - `NEXT_PUBLIC_CONVEX_URL`
  - `CONVEX_DEPLOY_KEY`
  - `BLOB_STORE_TOKEN`
  - `BLOB_STORE_URL`
- [ ] Run `vercel deploy --prod` (or push to `main` if auto-deploy is enabled)
- [ ] Deployment completes without build errors
- [ ] Smoke test: visit `https://<prod-domain>`, sign in with Clerk, create or join
  an org, verify the dashboard loads with no console errors
- [ ] Verify the run list page loads without errors (may be empty — that is fine)

---

## Post-deployment verification

- [ ] `GET /api/health` returns HTTP 200 with:
  ```json
  {
    "status": "ok",
    "storage": { "adapter": "vercel", "configured": true },
    ...
  }
  ```
  If `adapter` is `"stub"` in production: `BLOB_STORE_TOKEN` env var is missing.
  Add it in Vercel project settings and redeploy.
- [ ] SDK end-to-end smoke test: run the SDK against the production URL with a real
  API key, record a short run, and verify it appears in the dashboard
- [ ] Check the Convex dashboard → Logs tab for any function errors in the last 5 minutes
- [ ] Check Vercel Functions logs for any 500 responses on API routes

---

## Rollback procedure

If a production deployment is broken and must be reverted immediately:

1. **Vercel rollback**: Vercel dashboard → Deployments → locate the previous stable
   deployment → click the three-dot menu → Promote to Production. This is instant.
2. **Convex rollback** (only if schema changed): Convex does NOT support automatic
   schema rollback. To roll back a schema change:
   a. Revert the `convex/schema.ts` commit in the codebase.
   b. Run `npx convex deploy` to push the reverted schema.
   c. Note: any data written under the new schema may be incompatible with the
      reverted schema — assess the impact before reverting.
3. After rollback, verify `GET /api/health` returns `"status": "ok"`.
4. Notify the team via the agreed incident channel.
