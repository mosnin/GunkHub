export const env = {
  // Public — safe to expose to the browser
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
  NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL ?? '',
  // Server-only — never sent to the browser
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY ?? '',
  CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET ?? '',
  // Blob storage — optional for local dev; required in production for large payload externalization.
  // When unset, the StubBlobStorageAdapter is used (in-memory, data lost on restart).
  // See .env.example for setup instructions.
  BLOB_STORE_TOKEN: process.env.BLOB_STORE_TOKEN ?? '',
  BLOB_STORE_URL: process.env.BLOB_STORE_URL ?? '',
}

// Validate public vars at startup in the browser
if (typeof window !== 'undefined') {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
    throw new Error('Missing required env var: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
  if (!env.NEXT_PUBLIC_CONVEX_URL)
    throw new Error('Missing required env var: NEXT_PUBLIC_CONVEX_URL')
}

// Server-only vars (CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET) are validated
// lazily in the route handlers that consume them, not at module load time.
// Throwing at import time breaks `next build` where env vars are absent.
