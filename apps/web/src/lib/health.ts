/**
 * Health data computation — shared between the /api/health route and
 * SystemHealthPanel (which calls this directly to avoid same-origin loopback).
 *
 * This function is synchronous because it only reads process.env.
 * It must never expose env var values — only presence (boolean) and type.
 */

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
