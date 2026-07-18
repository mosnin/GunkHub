import { type NextRequest, NextResponse } from 'next/server'

import { withApiHandler } from '@/lib/apiHandler'
import { checkHealth } from '@/lib/health'

// GET /api/health — unauthenticated, reports safe config + dependency status.
// Never exposes env var values or tenant data — only presence booleans and
// status strings. Pings Convex and blob storage with a ~2s deadline each and
// returns 503 when the hard dependency (Convex) is down.
//
// Rate limiting is deliberately disabled: uptime probes hit this endpoint on
// tight schedules and must never be turned away. The wrapper still supplies
// requestId propagation and the structured request log line.

// Dependency pings must run per-request, never at build time.
export const dynamic = 'force-dynamic'

export const GET = withApiHandler(
  '/api/health',
  async (_req: NextRequest) => {
    const { data, httpStatus } = await checkHealth()
    return NextResponse.json(data, { status: httpStatus })
  },
  { rateLimit: { disabled: true } }
)
