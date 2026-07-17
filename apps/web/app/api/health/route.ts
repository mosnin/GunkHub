import { NextResponse } from 'next/server'

import { checkHealth } from '@/lib/health'

// GET /api/health — unauthenticated, reports safe config + dependency status.
// Never exposes env var values or tenant data — only presence booleans and
// status strings. Pings Convex and blob storage with a ~2s deadline each and
// returns 503 when the hard dependency (Convex) is down.

// Dependency pings must run per-request, never at build time.
export const dynamic = 'force-dynamic'

export async function GET() {
  const { data, httpStatus } = await checkHealth()
  return NextResponse.json(data, { status: httpStatus })
}
