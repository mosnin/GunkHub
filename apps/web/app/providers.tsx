'use client'

import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { useMemo } from 'react'

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL

function getConvexClient(): ConvexReactClient {
  if (!convexUrl) {
    // During build/SSR, return a dummy — real validation happens in env.ts
    return new ConvexReactClient('https://placeholder.convex.cloud')
  }
  return new ConvexReactClient(convexUrl)
}

// Singleton to avoid re-creating on every render
let _client: ConvexReactClient | null = null
function getClient(): ConvexReactClient {
  if (!_client) _client = getConvexClient()
  return _client
}

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => getClient(), [])
  return <ConvexProvider client={client}>{children}</ConvexProvider>
}

export function Providers({ children }: { children: React.ReactNode }) {
  return <ConvexClientProvider>{children}</ConvexClientProvider>
}
