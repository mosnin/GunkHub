// Server-side Convex client helpers.
// These are only imported in server components and API route handlers — never in client components.

import { createHash } from 'node:crypto'

import { auth } from '@clerk/nextjs/server'
import { ConvexHttpClient } from 'convex/browser'

import { convex } from './convexFunctions'
import { env } from './env'

/**
 * Default upper bound for a single server-side Convex call. Bounded failure,
 * no retries — retry loops from every serverless instance amplify an outage
 * (thundering herd). Routes map ConvexTimeoutError to a 503 JSON response.
 */
export const CONVEX_CALL_TIMEOUT_MS = 10_000

/** Typed error thrown when a Convex call exceeds its deadline. */
export class ConvexTimeoutError extends Error {
  constructor(ms: number) {
    super(`Convex call timed out after ${String(ms)}ms`)
    this.name = 'ConvexTimeoutError'
  }
}

/**
 * Bound a Convex call (or any promise) with an explicit deadline.
 * Usage: `await withConvexTimeout(client.mutation(fn, args))`.
 * On timeout the underlying request is abandoned (ConvexHttpClient does not
 * expose an abort hook) but the route fails fast with a typed error.
 */
export async function withConvexTimeout<T>(
  promise: Promise<T>,
  ms: number = CONVEX_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ConvexTimeoutError(ms))
    }, ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } catch (err) {
    if (err instanceof ConvexTimeoutError) {
      // The abandoned call may still reject later — swallow it so it does not
      // surface as an unhandled promise rejection.
      void promise.catch(() => undefined)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Return a Convex HTTP client authenticated with the current Clerk session JWT. */
export async function getAuthedClient(): Promise<ConvexHttpClient> {
  const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL)
  const { getToken } = auth()
  const token = await getToken({ template: 'convex' })
  if (token) client.setAuth(token)
  return client
}

/** Return an unauthenticated Convex HTTP client for SDK-ingestion routes. */
export function getPublicClient(): ConvexHttpClient {
  return new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL)
}

/**
 * Resolve a Clerk org ID to a Convex document ID.
 * Throws if no organization record is found.
 */
export async function resolveConvexOrgId(clerkOrgId: string): Promise<string> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
  if (!org) throw new Error(`Organization not found for Clerk org: ${clerkOrgId}`)
  return (org as Record<string, unknown>)._id as string
}

/** SHA-256 hex hash of an API key string. Matches the hash stored in api_keys.keyHash. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}
