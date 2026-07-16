// Clerk middleware. REQUIRED: in @clerk/nextjs v5, `auth()` throws at runtime
// ("Clerk can't detect usage of clerkMiddleware()") unless clerkMiddleware runs
// on the request. Without this file every Clerk-authenticated route and server
// action 500s. See ADR-0023.
//
// Auth model per route class:
//   - App pages under /projects, /agents, /runs, /dashboard, /settings, /diff
//     require a signed-in Clerk session (redirected to sign-in otherwise).
//   - SDK ingest routes (/api/events, /api/runs, /api/artifacts, ...) authenticate
//     via x-api-key, NOT a Clerk session, so they are left public here.
//   - The Clerk webhook (/api/webhooks/clerk) authenticates via Svix signature.
//   - Health and internal routes carry their own guards.

import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Pages that require an interactive Clerk session.
const isProtectedPage = createRouteMatcher([
  '/projects(.*)',
  '/agents(.*)',
  '/runs(.*)',
  '/dashboard(.*)',
  '/settings(.*)',
  '/diff(.*)',
])

export default clerkMiddleware((auth, req) => {
  // Clerk v5.7: `auth` is a function returning the auth object; `.protect()`
  // redirects unauthenticated page requests to sign-in.
  if (isProtectedPage(req)) {
    auth().protect()
  }
})

export const config = {
  matcher: [
    // Run on everything except Next internals and static assets, but always on
    // API/tRPC routes so auth() works inside route handlers.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
