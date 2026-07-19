/**
 * exportFormat.ts — pure, HTTP-free helpers backing the /api/export/* routes.
 *
 * Everything in this file is a pure function over plain data. It exists so
 * the export routes (`apps/web/app/api/export/**`) can be exercised by unit
 * tests without going through Next.js request/response plumbing or Convex.
 * The routes themselves own auth, org scoping, and the actual paginated
 * fetch loop — this file only knows how to turn already-fetched records
 * into CSV/ndjson text and how to interpret query-string filters.
 */
import type { Artifact, Comment, Event, Run } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export type ExportFormat = 'json' | 'csv' | 'ndjson'

const VALID_FORMATS = new Set<ExportFormat>(['json', 'csv', 'ndjson'])

/** Parse the `format` query param. Defaults to `ndjson` (the streamable default). */
export function parseExportFormat(raw: string | null): ExportFormat {
  if (raw && VALID_FORMATS.has(raw as ExportFormat)) return raw as ExportFormat
  return 'ndjson'
}

export function contentTypeForFormat(format: ExportFormat): string {
  switch (format) {
    case 'json':
      return 'application/json; charset=utf-8'
    case 'csv':
      return 'text/csv; charset=utf-8'
    case 'ndjson':
      return 'application/x-ndjson; charset=utf-8'
  }
}

// ---------------------------------------------------------------------------
// Limit / truncation
// ---------------------------------------------------------------------------

/** Hard cap on rows returned by a single export request. */
export const EXPORT_MAX_LIMIT = 5000
/** Default row count when the caller does not specify `limit`. */
export const EXPORT_DEFAULT_LIMIT = 1000

/**
 * Resolve the `limit` query param into a safe, bounded integer in
 * `[1, EXPORT_MAX_LIMIT]`. Non-numeric, missing, zero, or negative input
 * falls back to `EXPORT_DEFAULT_LIMIT`.
 */
export function resolveExportLimit(raw: string | null): number {
  if (raw === null || raw === '') return EXPORT_DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return EXPORT_DEFAULT_LIMIT
  return Math.min(Math.floor(n), EXPORT_MAX_LIMIT)
}

/**
 * Whether the export was cut off by the limit. Callers fetch `limit + 1`
 * records internally; if more than `limit` came back, the result set was
 * truncated and the extra record is discarded before formatting.
 */
export function isExportTruncated(fetchedCount: number, limit: number): boolean {
  return fetchedCount > limit
}

export const EXPORT_TRUNCATED_HEADER = 'x-export-truncated'

// ---------------------------------------------------------------------------
// Filter passthrough
// ---------------------------------------------------------------------------

export interface RunExportFilters {
  format: ExportFormat
  status?: Run['status']
  agentId?: string
  projectId?: string
  limit: number
}

const VALID_RUN_STATUSES = new Set<Run['status']>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
])

/** Parse and validate the query params accepted by `GET /api/export/runs`. */
export function parseRunExportFilters(searchParams: URLSearchParams): RunExportFilters {
  const status = searchParams.get('status')
  const agentId = searchParams.get('agentId')
  const projectId = searchParams.get('projectId')
  return {
    format: parseExportFormat(searchParams.get('format')),
    ...(status && VALID_RUN_STATUSES.has(status as Run['status'])
      ? { status: status as Run['status'] }
      : {}),
    ...(agentId ? { agentId } : {}),
    ...(projectId ? { projectId } : {}),
    limit: resolveExportLimit(searchParams.get('limit')),
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Escape a single CSV field value.
 *
 * - Formula-injection guard: if the raw value starts with `=`, `+`, `-`, `@`,
 *   a tab, or a carriage return (the characters spreadsheet apps treat as a
 *   formula prefix), prefix it with a literal single quote so it is opened
 *   as inert text, never evaluated as a formula.
 * - RFC 4180 quoting: if the (possibly prefixed) value contains a comma,
 *   double quote, or newline, wrap it in double quotes and double any
 *   embedded double quotes.
 */
export function csvEscapeField(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)

  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`
  }

  if (/[",\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`
  }

  return s
}

/** Stable column order for the runs CSV export. Never reorder — this is a public contract. */
export const RUN_CSV_COLUMNS = [
  'id',
  'orgId',
  'projectId',
  'agentId',
  'agentVersionId',
  'status',
  'startedAt',
  'endedAt',
  'tags',
  'triggeredBy',
  'sdkVersion',
  'metadataJson',
] as const

export function buildCsvHeaderRow(): string {
  return RUN_CSV_COLUMNS.join(',')
}

/** Render one `Run` as a single CSV row (no trailing newline). */
export function runToCsvRow(run: Run): string {
  const values: Record<(typeof RUN_CSV_COLUMNS)[number], unknown> = {
    id: run.id,
    orgId: run.orgId,
    projectId: run.projectId,
    agentId: run.agentId,
    agentVersionId: run.agentVersionId ?? '',
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? '',
    tags: run.tags.join(';'),
    triggeredBy: run.triggeredBy ?? '',
    sdkVersion: run.sdkVersion ?? '',
    metadataJson: Object.keys(run.metadata ?? {}).length > 0 ? JSON.stringify(run.metadata) : '',
  }
  return RUN_CSV_COLUMNS.map((col) => csvEscapeField(values[col])).join(',')
}

// ---------------------------------------------------------------------------
// ndjson
// ---------------------------------------------------------------------------

/** Serialize a single record as one ndjson line (includes the trailing `\n`). */
export function toNdjsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

// ---------------------------------------------------------------------------
// Single-run bundle (GET /api/export/runs/[runId]) — typed ndjson records
// ---------------------------------------------------------------------------

/**
 * The single-run bundle export is ndjson-only: each line is a JSON object
 * with a `record` discriminator so a streaming consumer can process the
 * (potentially very large) event list without waiting for the whole
 * document, and without needing a schema per record type up front.
 */
export type RunBundleRecord =
  | { record: 'run'; run: Run }
  | { record: 'event'; event: Event }
  | { record: 'artifact'; artifact: Artifact }
  | { record: 'comment'; comment: Comment }
  | {
      record: 'verification'
      verification: {
        verified: boolean
        isValid: boolean | null
        verifiedAt: number | null
        summary: string | null
      }
    }

export function runBundleRunLine(run: Run): string {
  return toNdjsonLine({ record: 'run', run } satisfies RunBundleRecord)
}

export function runBundleEventLine(event: Event): string {
  return toNdjsonLine({ record: 'event', event } satisfies RunBundleRecord)
}

export function runBundleArtifactLine(artifact: Artifact): string {
  return toNdjsonLine({ record: 'artifact', artifact } satisfies RunBundleRecord)
}

export function runBundleCommentLine(comment: Comment): string {
  return toNdjsonLine({ record: 'comment', comment } satisfies RunBundleRecord)
}

export function runBundleVerificationLine(verification: {
  verified: boolean
  isValid: boolean | null
  verifiedAt: number | null
  summary: string | null
}): string {
  return toNdjsonLine({ record: 'verification', verification } satisfies RunBundleRecord)
}

// ---------------------------------------------------------------------------
// Content-Disposition
// ---------------------------------------------------------------------------

/** Build a safe `Content-Disposition: attachment` header value. */
export function exportContentDisposition(filename: string): string {
  const safe = filename.replace(/"/g, '\\"')
  return `attachment; filename="${safe}"`
}

export function fileExtensionForFormat(format: ExportFormat): string {
  switch (format) {
    case 'json':
      return 'json'
    case 'csv':
      return 'csv'
    case 'ndjson':
      return 'ndjson'
  }
}
