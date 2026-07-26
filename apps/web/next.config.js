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

  // OTLP endpoint compatibility.
  //
  // The OTLP trace endpoint lives at `/api/v1/traces` deliberately, so it
  // inherits the `/api/v1/**` auth, rate class and request-id logging rather
  // than growing a parallel set of its own.
  //
  // The cost is a silent adoption failure. `OTEL_EXPORTER_OTLP_ENDPOINT` is the
  // BASE-URL form of the exporter config — the SDK appends the signal path
  // (`/v1/traces`) itself — and it is the more common configuration in the
  // wild, because one variable covers traces, metrics and logs. An exporter
  // configured that way POSTs to `/v1/traces`, gets a 404, and an OTLP exporter
  // treats a 404 as a retryable transport failure: it retries, backs off, and
  // drops spans. The user sees no data and no error they can act on. (The
  // per-signal form, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, takes the FULL path
  // and works against `/api/v1/traces` today without this rewrite.)
  //
  // `afterFiles` is load-bearing, not incidental. It is consulted only after
  // filesystem routes and static pages have failed to match, so it cannot
  // shadow or reorder any existing route. `beforeFiles` runs ahead of the
  // filesystem and could. There is no `app/v1` segment and the only catch-all
  // routes in the tree are `/sign-in/[[...sign-in]]` and
  // `/sign-up/[[...sign-up]]`, neither of which can match `/v1/traces`, so this
  // rewrite fires exactly on the path that would otherwise 404.
  //
  // Rewrite, NOT redirect: a 307/308 would require the exporter to follow
  // redirects on a POST with a binary protobuf body, which not every OTLP
  // exporter does reliably.
  //
  // Only `traces` is rewritten. `/v1/metrics` and `/v1/logs` continue to 404
  // because we do not ingest those signals, and mapping them onto a route that
  // would also reject them buys nothing.
  //
  // The rewrite is transparent to the handler: `app/api/v1/traces/route.ts`
  // does not read the request pathname, so it behaves identically on either
  // entry point. `middleware.ts` needs no change — its `isProtectedPage`
  // matcher does not cover `/v1(.*)`, so `/v1/traces` is public in exactly the
  // way `/api/v1/traces` already is, and OTLP auth stays with the route's own
  // `x-api-key` check.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: '/v1/traces',
          destination: '/api/v1/traces',
        },
      ],
      fallback: [],
    }
  },
}
module.exports = nextConfig
