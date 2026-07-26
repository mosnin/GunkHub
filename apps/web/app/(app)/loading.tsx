import { LoadingState } from '@/components/ui/LoadingState'

/**
 * Route-segment loading fallback for the authenticated app. Rendered by Next.js
 * while a server component in this segment is fetching. Neon system: Blackout
 * ground, centered spinner via the shared LoadingState primitive.
 */
export default function AppLoading() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-blackout">
      <LoadingState message="Loading…" />
    </div>
  )
}
