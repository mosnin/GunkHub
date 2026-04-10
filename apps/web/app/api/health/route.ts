import { NextResponse } from 'next/server'

import { getHealthData } from '@/lib/health'

// GET /api/health — unauthenticated, reports safe config status only.
// Never exposes env var values — only whether they are set.
export function GET() {
  return NextResponse.json(getHealthData())
}
