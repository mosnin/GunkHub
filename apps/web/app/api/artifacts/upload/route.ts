import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

// POST /api/artifacts/upload — externalize a large event payload as an artifact.
// Blob storage backend is deferred (see ADR-0006).
// Until implemented, respond 501 so callers get a clear signal instead of silence.
export async function POST(_req: NextRequest) {
  return NextResponse.json<ApiError>(
    {
      code: 'NOT_IMPLEMENTED',
      message:
        'Artifact blob storage is not yet wired. Reduce event payload size to < 10 KB or wait for blob storage integration.',
    },
    { status: 501 }
  )
}
