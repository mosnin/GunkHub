// PATCH /api/runs/:id/triage — Clerk-authenticated (browser callers, not the
// SDK). No Team C route exists for this surface, so it is added here per the
// Cycle-2 UI brief (item 9 — triage). Wraps convex/runs.ts `setRunTriage` and
// `setRunLabels`, which are member-gated and enforce their own invariants
// (triage: linear open -> investigating -> resolved state machine, settable
// only on failed/timed_out runs; labels: <= 10 entries, <= 40 chars each) —
// this route surfaces whatever they throw rather than re-validating.
import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError, RunTriageState } from '@agent-flight-recorder/contracts'

import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { setRunLabels, setRunTriage } from '@/lib/services/runs'

interface RouteParams {
  params: { id: string }
}

const TRIAGE_STATES = new Set<string>(['open', 'investigating', 'resolved'])

export const PATCH = withApiHandler(
  '/api/runs/[id]/triage',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const { userId, orgId } = auth()
    if (!userId || !orgId) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    ctx.setOrgId(orgId)

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

    const triageState = body['triageState']
    const labels = body['labels']

    if (triageState === undefined && labels === undefined) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'Provide triageState and/or labels' },
        { status: 422 },
      )
    }
    if (triageState !== undefined && (typeof triageState !== 'string' || !TRIAGE_STATES.has(triageState))) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'triageState must be one of open, investigating, resolved' },
        { status: 422 },
      )
    }
    if (
      labels !== undefined &&
      (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string'))
    ) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'labels must be an array of strings' },
        { status: 422 },
      )
    }

    try {
      let run
      if (triageState !== undefined) {
        run = await setRunTriage(params.id, triageState as RunTriageState)
      }
      if (labels !== undefined) {
        run = await setRunLabels(params.id, labels as string[])
      }
      return NextResponse.json({ run })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } },
)
