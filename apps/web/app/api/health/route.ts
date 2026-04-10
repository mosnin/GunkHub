import { NextResponse } from 'next/server'

// GET /api/health — unauthenticated, reports safe config status only.
// Never exposes env var values — only whether they are set.
export function GET() {
  const blobToken = process.env['BLOB_STORE_TOKEN']
  const configured = Boolean(blobToken && blobToken.length > 0)
  const adapter = configured ? 'vercel' : 'stub'

  const env = process.env['NODE_ENV'] ?? 'development'
  const environment = env === 'production' ? 'production' : env === 'test' ? 'test' : 'development'

  // Degraded: production runtime without a real storage adapter
  const status = environment === 'production' && adapter === 'stub' ? 'degraded' : 'ok'

  return NextResponse.json({
    status,
    storage: {
      adapter,
      configured,
    },
    projection: {
      model: 'on-demand',
      materializationEnabled: false,
    },
    environment,
    timestamp: new Date().toISOString(),
  })
}
