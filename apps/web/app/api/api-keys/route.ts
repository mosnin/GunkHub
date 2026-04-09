// API key management routes — Clerk-authenticated.
// POST: generate a new API key (raw key returned ONCE, only hash stored in Convex)
// GET:  list API keys (names + timestamps; raw key and hash are never returned)

import { randomBytes } from 'node:crypto'

import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, hashApiKey, resolveConvexOrgId } from '@/lib/convexServer'

// Convex returns untyped documents; we cast through unknown to avoid unsafe-any
// while still accessing the fields we know are present on the api_keys table.
interface ApiKeyDoc {
  _id: string
  name: string
  createdAt: number
  lastUsedAt?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConvexArgs = Record<string, any>

// Wrapper that isolates the any-typed Convex HTTP client calls so the rest of
// the file stays clean of unsafe-any usages.
async function convexMutation(
  client: Awaited<ReturnType<typeof getAuthedClient>>,
  fn: Parameters<typeof client.mutation>[0],
  args: ConvexArgs,
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return client.mutation(fn, args)
}

async function convexQuery(
  client: Awaited<ReturnType<typeof getAuthedClient>>,
  fn: Parameters<typeof client.query>[0],
  args: ConvexArgs,
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return client.query(fn, args)
}

// ---------------------------------------------------------------------------
// POST /api/api-keys — generate a new API key for the authenticated org
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const { userId, orgId: clerkOrgId } = auth()
  if (!userId || !clerkOrgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    )
  }

  let body: Record<string, unknown>
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    body = await req.json()
  } catch {
    return NextResponse.json<ApiError>(
      { code: 'BAD_REQUEST', message: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  const name = body['name']
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json<ApiError>(
      { code: 'VALIDATION_ERROR', message: 'name is required' },
      { status: 422 },
    )
  }

  try {
    const convexOrgId = await resolveConvexOrgId(clerkOrgId)
    const rawKey = randomBytes(32).toString('hex')
    const keyHash = hashApiKey(rawKey)

    const client = await getAuthedClient()
    const keyDoc = (await convexMutation(client, convex.api_keys.createApiKey, {
      orgId: convexOrgId,
      name: name.trim(),
      keyHash,
    })) as ApiKeyDoc

    // The raw key is returned ONCE and never stored — caller must persist it securely.
    return NextResponse.json(
      {
        id: keyDoc._id,
        name: keyDoc.name,
        createdAt: keyDoc.createdAt,
        key: rawKey,
      },
      { status: 201 },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    return NextResponse.json<ApiError>({ code: 'INTERNAL_ERROR', message }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// GET /api/api-keys — list API keys for the authenticated org
// ---------------------------------------------------------------------------

export async function GET() {
  const { userId, orgId: clerkOrgId } = auth()
  if (!userId || !clerkOrgId) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 },
    )
  }

  try {
    const convexOrgId = await resolveConvexOrgId(clerkOrgId)
    const client = await getAuthedClient()
    const keys = (await convexQuery(client, convex.api_keys.listApiKeys, {
      orgId: convexOrgId,
    })) as ApiKeyDoc[]

    // Return only safe fields — never the raw key or hash
    const safeKeys = keys.map((k) => ({
      id: k._id,
      name: k.name,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    }))

    return NextResponse.json({ keys: safeKeys })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    return NextResponse.json<ApiError>({ code: 'INTERNAL_ERROR', message }, { status: 500 })
  }
}
