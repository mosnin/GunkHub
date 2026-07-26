/**
 * Health data computation — shared between the /api/health route and
 * SystemHealthPanel (which calls getHealthData directly to avoid same-origin
 * loopback).
 *
 * Two layers:
 *   - getHealthData(): synchronous config snapshot (reads process.env only).
 *   - checkHealth(): async deep check that also pings real dependencies
 *     (Convex, blob storage) with a short timeout each. Used by /api/health.
 *
 * These functions must never expose env var values or tenant data — only
 * presence booleans and status strings.
 */

import { ConvexHttpClient } from 'convex/browser'

import { convex } from './convexFunctions'
import { env } from './env'

export interface HealthData {
  status: 'ok' | 'degraded'
  storage: {
    adapter: 'vercel' | 'stub'
    configured: boolean
  }
  projection: {
    model: string
    materializationEnabled: boolean
  }
  environment: 'production' | 'development' | 'test'
  timestamp: string
}

export type DependencyStatus = 'ok' | 'down' | 'skipped'

export interface DeepHealthData extends HealthData {
  dependencies: {
    /** Convex backend reachability — hard dependency; 'down' means 503. */
    convex: DependencyStatus
    /** Blob storage reachability — soft dependency (stub fallback exists). */
    blob: DependencyStatus
  }
}

/** Per-dependency ping deadline. Keeps /api/health cheap even during outages. */
const DEPENDENCY_TIMEOUT_MS = 2_000

export function getHealthData(): HealthData {
  const blobToken = process.env['BLOB_STORE_TOKEN']
  const configured = Boolean(blobToken && blobToken.length > 0)
  const adapter = configured ? ('vercel' as const) : ('stub' as const)

  const nodeEnv = process.env['NODE_ENV'] ?? 'development'
  const environment: HealthData['environment'] =
    nodeEnv === 'production' ? 'production' : nodeEnv === 'test' ? 'test' : 'development'

  const status: HealthData['status'] =
    environment === 'production' && adapter === 'stub' ? 'degraded' : 'ok'

  return {
    status,
    storage: { adapter, configured },
    projection: { model: 'on-demand', materializationEnabled: false },
    environment,
    timestamp: new Date().toISOString(),
  }
}

/** Race a probe against a short deadline; a deadline loss reports 'down'. */
async function withDeadline(probe: Promise<DependencyStatus>): Promise<DependencyStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<DependencyStatus>((resolve) => {
    timer = setTimeout(() => {
      resolve('down')
    }, DEPENDENCY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([probe, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Lightweight Convex ping: run a trivial query with a sentinel argument.
 * Any response from the deployment — including an application-level error —
 * proves the backend is up; only transport failures / timeouts count as down.
 */
async function pingConvex(): Promise<DependencyStatus> {
  if (!env.NEXT_PUBLIC_CONVEX_URL) return 'down'
  const probe = (async (): Promise<DependencyStatus> => {
    const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL)
    try {
      await client.query(convex.organizations.getOrganization, {
        clerkOrgId: 'health-check-sentinel',
      })
      return 'ok'
    } catch (err) {
      // A structured Convex error means the server answered — it is up. Only
      // network-level failures (fetch failed, DNS, refused) mean down.
      const message = err instanceof Error ? err.message : String(err)
      const transportFailure = /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket/i.test(message)
      return transportFailure ? 'down' : 'ok'
    }
  })()
  return withDeadline(probe)
}

/**
 * Blob storage ping: HEAD the store base URL. Skipped when the stub adapter is
 * active (nothing external to check). Any HTTP response counts as reachable —
 * we probe transport, not object existence.
 */
async function pingBlobStorage(): Promise<DependencyStatus> {
  if (!env.BLOB_STORE_TOKEN || !env.BLOB_STORE_URL) return 'skipped'
  const probe = (async (): Promise<DependencyStatus> => {
    try {
      await fetch(env.BLOB_STORE_URL, { method: 'HEAD' })
      return 'ok'
    } catch {
      return 'down'
    }
  })()
  return withDeadline(probe)
}

/**
 * Deep health check for /api/health. Convex is a hard dependency — when it is
 * down the route returns 503. Blob storage is soft (stub fallback) — when it
 * is down the overall status degrades but the route stays 200.
 */
export async function checkHealth(): Promise<{ data: DeepHealthData; httpStatus: number }> {
  const base = getHealthData()
  const [convexStatus, blobStatus] = await Promise.all([pingConvex(), pingBlobStorage()])

  const degraded = base.status === 'degraded' || convexStatus === 'down' || blobStatus === 'down'

  const data: DeepHealthData = {
    ...base,
    status: degraded ? 'degraded' : 'ok',
    dependencies: {
      convex: convexStatus,
      blob: blobStatus,
    },
  }

  return { data, httpStatus: convexStatus === 'down' ? 503 : 200 }
}
