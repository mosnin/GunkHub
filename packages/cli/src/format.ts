/**
 * Plain-text output helpers shared by the `runs list`, `runs get`, `replay`,
 * `tail`, and `export` commands. Deliberately dependency-free (no chalk/table
 * libraries) — the CLI ships with native fetch only.
 */

/** Truncate an id to `len` chars, appending `…` when it was longer. Ids shorter than `len` pass through unchanged. */
export function truncateId(id: string, len = 12): string {
  if (id.length <= len) return id
  return `${id.slice(0, len - 1)}…`
}

/** Format a Unix-ms timestamp as an ISO-8601 string, or `-` when undefined. */
export function formatTimestamp(ms: number | undefined): string {
  if (ms === undefined) return '-'
  return new Date(ms).toISOString()
}

/** Format a millisecond duration as `12.3s` / `4m5s` / `-` (when either end is missing). */
export function formatDuration(startedAt: number | undefined, endedAt: number | undefined): string {
  if (startedAt === undefined || endedAt === undefined) return '-'
  const ms = endedAt - startedAt
  if (ms < 0) return '-'
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return `${minutes}m${seconds}s`
}

/**
 * Render rows as a simple aligned, plain-text table: header row, then one
 * row per record, columns padded to the widest value in each column.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const renderRow = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd()
  return [renderRow(headers), ...rows.map(renderRow)].join('\n')
}
