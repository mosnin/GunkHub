import Link from 'next/link'

export const metadata = { title: 'Not Found' }

/**
 * Root 404 page. Neon system: Blackout ground, Whiteout primary text, GeistMono
 * for the status code, Ash secondary copy, and a Whiteout pill CTA back to the
 * dashboard. Depth via layered near-black surfaces, never shadows.
 */
export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-blackout px-6">
      <div className="flex flex-col items-center text-center max-w-sm">
        <span className="font-mono text-sm text-neon-glow tracking-wider">404</span>
        <h1 className="mt-3 text-2xl font-medium text-whiteout tracking-tight">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-ash leading-relaxed">
          The page you are looking for does not exist or may have been moved.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex items-center rounded-full bg-whiteout px-7 py-3 text-sm font-medium text-graphite-deep hover:bg-cloud transition-colors duration-150"
        >
          Back to dashboard
        </Link>
      </div>
    </main>
  )
}
