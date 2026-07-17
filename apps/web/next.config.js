/** @type {import('next').NextConfig} */

// Standard security header set applied to every route. We deliberately avoid a
// broad Content-Security-Policy here: Clerk injects scripts and iframes from its
// own origins, and an over-tight `script-src`/`frame-src` policy would break the
// auth flow. Clickjacking protection is achieved with X-Frame-Options: DENY plus
// a minimal CSP that only restricts `frame-ancestors` (who may embed US) — this
// does not constrain what the page itself loads, so it is Clerk-safe.
const securityHeaders = [
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'",
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
]

const nextConfig = {
  transpilePackages: ['@agent-flight-recorder/contracts'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ]
  },
}
module.exports = nextConfig
