/** @type {import('next').NextConfig} */

// Full Content-Security-Policy, currently deployed in Report-Only mode while it
// is validated against real Clerk + Convex traffic. The enforced CSP below only
// restricts `frame-ancestors` (clickjacking), which is Clerk-safe. Once the
// Report-Only policy has soaked without violations, promote it to the enforced
// `Content-Security-Policy` header.
//
// Allowances:
//   script-src  — Clerk injects scripts from *.clerk.accounts.dev; Cloudflare
//                 Turnstile (challenges.cloudflare.com) is Clerk's bot check.
//                 'unsafe-inline'/'unsafe-eval' are required by Next.js dev/HMR
//                 and Clerk's runtime today; tighten with nonces later.
//   connect-src — Clerk APIs, Convex HTTP + WebSocket, Clerk telemetry.
//   img-src     — Clerk avatar CDN (img.clerk.com) plus data: URIs.
//   frame-src   — Cloudflare Turnstile iframe.
//   worker-src  — blob: workers used by Next.js/Clerk runtime.
//   report-uri/report-to — violations POST to /api/csp-report (log-only sink)
//                 so the Report-Only soak produces observable data. report-uri
//                 is the legacy directive; report-to targets the named
//                 endpoint declared in the Reporting-Endpoints header below.
const reportOnlyCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://challenges.cloudflare.com",
  "connect-src 'self' https://*.clerk.accounts.dev https://*.convex.cloud wss://*.convex.cloud https://clerk-telemetry.com",
  "img-src 'self' data: https://img.clerk.com",
  "style-src 'self' 'unsafe-inline'",
  'frame-src https://challenges.cloudflare.com',
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  'report-uri /api/csp-report',
  'report-to csp-endpoint',
].join('; ')

// Standard security header set applied to every route. The enforced CSP is
// deliberately minimal (frame-ancestors only): Clerk injects scripts and
// iframes from its own origins, and an over-tight enforced policy would break
// the auth flow. Clickjacking protection is achieved with X-Frame-Options:
// DENY plus `frame-ancestors 'none'` — this does not constrain what the page
// itself loads, so it is Clerk-safe. The full policy above runs in
// Report-Only mode alongside it.
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
    key: 'Content-Security-Policy-Report-Only',
    value: reportOnlyCsp,
  },
  {
    // Named reporting endpoint used by the `report-to` directive above.
    key: 'Reporting-Endpoints',
    value: 'csp-endpoint="/api/csp-report"',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'off',
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
