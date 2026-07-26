/**
 * POST /api/csp-report — sink for Content-Security-Policy violation reports.
 *
 * The Report-Only CSP in next.config.js points `report-uri` / `report-to`
 * here so the soak period produces observable data. Reports are LOG-ONLY:
 * each violation is emitted as a structured log line and the body is never
 * echoed back or stored.
 *
 * Tolerates both wire formats:
 *   - application/csp-report (report-uri):    { "csp-report": { ... } }
 *   - application/reports+json (report-to):   [ { type, url, body: { ... } }, ... ]
 *
 * Unauthenticated by design (browsers send reports without credentials), so
 * it is tightly rate-limited per IP and every field is truncated before
 * logging to bound hostile input.
 */
import { type NextRequest, NextResponse } from 'next/server'

import { withApiHandler } from '@/lib/apiHandler'
import { logger } from '@/lib/logger'

const MAX_BODY_BYTES = 32 * 1024
const MAX_FIELD_LEN = 512
const MAX_REPORTS_PER_REQUEST = 10

function str(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.slice(0, MAX_FIELD_LEN)
}

/** Pull the interesting CSP fields out of one report object (either format). */
function extractViolation(report: Record<string, unknown>): Record<string, unknown> {
  return {
    documentUri: str(report['document-uri'] ?? report['documentURL']),
    effectiveDirective: str(report['effective-directive'] ?? report['effectiveDirective']),
    violatedDirective: str(report['violated-directive']),
    blockedUri: str(report['blocked-uri'] ?? report['blockedURL']),
    sourceFile: str(report['source-file'] ?? report['sourceFile']),
    lineNumber: typeof report['line-number'] === 'number' ? report['line-number'] : report['lineNumber'],
    disposition: str(report['disposition']),
  }
}

export const POST = withApiHandler(
  '/api/csp-report',
  async (req: NextRequest, ctx) => {
    const raw = await req.text()
    if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
      // Nothing useful to log (or a hostile oversized body) — accept silently.
      return new NextResponse(null, { status: 204 })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Malformed report — browsers get a 204 either way; never echo the body.
      return new NextResponse(null, { status: 204 })
    }

    const violations: Record<string, unknown>[] = []
    if (Array.isArray(parsed)) {
      // application/reports+json: [{ type: 'csp-violation', body: {...} }, ...]
      for (const entry of parsed.slice(0, MAX_REPORTS_PER_REQUEST)) {
        if (entry && typeof entry === 'object') {
          const body = (entry as Record<string, unknown>)['body']
          if (body && typeof body === 'object') {
            violations.push(extractViolation(body as Record<string, unknown>))
          }
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      // application/csp-report: { "csp-report": {...} } — or a bare report object.
      const wrapped = (parsed as Record<string, unknown>)['csp-report']
      const report = wrapped && typeof wrapped === 'object' ? wrapped : parsed
      violations.push(extractViolation(report as Record<string, unknown>))
    }

    for (const violation of violations) {
      logger.warn('csp-violation', {
        requestId: ctx.requestId,
        route: '/api/csp-report',
        ...violation,
      })
    }

    return new NextResponse(null, { status: 204 })
  },
  { rateLimit: { key: 'ip', limitPerMin: 10 } }
)
