/**
 * Minimal structured logger — one JSON object per line to stdout/stderr.
 *
 * Fields: ts, level, msg, plus any context passed by the caller
 * (requestId, route, orgId, err, ...). Values are never nested loggers or
 * transports — this is deliberately tiny so API routes can emit
 * machine-parseable logs without a dependency.
 *
 * Usage:
 *   logger.error('Svix verification failed', { requestId, route: '/api/webhooks/clerk', err })
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  requestId?: string
  route?: string
  orgId?: string
  /** Error object — serialized to { name, message, stack }. */
  err?: unknown
  [key: string]: unknown
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { message: String(err) }
}

function emit(level: LogLevel, msg: string, context: LogContext = {}): void {
  const { err, ...rest } = context
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...rest,
  }
  if (err !== undefined) line['err'] = serializeError(err)
  const out = JSON.stringify(line)
  // console is the structured log sink by design: stderr for warn/error, stdout otherwise.
  if (level === 'error' || level === 'warn') {
    console.error(out)
  } else {
    console.log(out)
  }
}

export const logger = {
  debug: (msg: string, context?: LogContext) => emit('debug', msg, context),
  info: (msg: string, context?: LogContext) => emit('info', msg, context),
  warn: (msg: string, context?: LogContext) => emit('warn', msg, context),
  error: (msg: string, context?: LogContext) => emit('error', msg, context),
}

/**
 * Resolve the request ID for an inbound request: honor a caller-supplied
 * `x-request-id` header (so IDs propagate across services), otherwise mint one.
 * Include the returned ID in error responses (and the `x-request-id` response
 * header) so users can quote it to support.
 */
export function getRequestId(req: Request): string {
  const inbound = req.headers.get('x-request-id')
  // Basic sanity limit so a hostile header can't bloat logs.
  if (inbound && inbound.length <= 128) return inbound
  return crypto.randomUUID()
}
