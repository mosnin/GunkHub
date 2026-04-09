// Server-side Convex client helpers.
// These are only imported in server components and API route handlers — never in client components.

import { createHash } from 'node:crypto'

import { auth } from '@clerk/nextjs/server'
import { ConvexHttpClient } from 'convex/browser'

import { convex } from './convexFunctions'
import { env } from './env'

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
