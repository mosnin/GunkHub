/**
 * Generic projection primitives shared by every consumer that shapes a v1 read
 * API response into a smaller, budgeted one.
 *
 * WHY THESE LIVE IN THE SDK. They arrived in `packages/mcp/src/projections.ts`,
 * alongside the MCP-specific projections that use them. They were hoisted here
 * when `afr triage` needed the same ranking the MCP server has, because
 * `packages/mcp` is a leaf APPLICATION (a `bin`), not a shared library — a CLI
 * depending on it would invert the dependency graph and drag an MCP server and
 * its transport into a published command-line binary.
 *
 * They were SPLIT rather than COPIED, and that distinction is load-bearing.
 * {@link truncateProse} emits an in-band `…[truncated, N more chars]` marker
 * that callers and tests both read. Two copies of a truncation marker are the
 * same failure shape as two copies of a ranking: they start identical, so
 * nobody notices when they stop being identical, and then the SDK and the MCP
 * server disagree about what "truncated" looks like on the wire. One
 * declaration, imported by both.
 *
 * The MCP-specific projections (`toListRunsResult`, `toPatternEvidenceResult`,
 * the tier byte caps, and so on) deliberately did NOT move — they are genuinely
 * MCP-shaped, and this file is only for what is genuinely not.
 */

// ---------------------------------------------------------------------------
// Column tables — the single declaration of what a projection emits AND what it
// therefore asks the server for
// ---------------------------------------------------------------------------

/**
 * One column of a projection, paired with the SOURCE DOCUMENT FIELD it reads.
 *
 * WHY THE PAIRING EXISTS. A projection asks the read API for exactly the
 * columns it will emit (`fields` — convex/read_api.ts §FIELD PROJECTION). The
 * requested list and the emitted list are the same fact stated twice, and two
 * lists that can disagree are precisely the drift this pairing exists to
 * prevent:
 *
 *   - a column added to the projection but not to the request reads
 *     `undefined` on every row, and an all-`undefined` column is dropped by the
 *     columnar encoder — so it disappears silently rather than failing;
 *   - a name that is wrong in the other direction is worse than silent: the
 *     read API's rule 2 makes an UNKNOWN FIELD A HARD ERROR, so a stale entry
 *     fails the whole call rather than one column.
 *
 * So the list is written ONCE, per projection, and both the columnar header
 * ({@link columnsOf}) and the request ({@link requestFieldsOf}) are derived
 * from it. Neither is ever written out by hand a second time.
 */
export interface ProjectedColumn<C extends string> {
  /** The column name this projection emits. */
  readonly column: C
  /**
   * The document field this column's value is read from, or `null` when the
   * value does not come from the projected document at all — an identity field
   * the server returns whether or not it was asked for (read API rule 3), or a
   * value joined in from a separate envelope. A `null` source is never
   * requested: asking for the identity field would be redundant, and asking for
   * a field the document does not have would be the hard error above.
   */
  readonly source: string | null
}

/** The emitted column names, in order. The columnar header. */
export function columnsOf<C extends string>(columns: readonly ProjectedColumn<C>[]): C[] {
  return columns.map((column) => column.column)
}

/**
 * The `fields` selection to send for a projection: every distinct non-null
 * source, deduped (several columns can read one field — the artifact pointer,
 * `originalType` and `errorSummary` all come out of `payload`).
 *
 * Order is declaration order, deduped. It is not sorted: the read API accepts
 * any order, and preserving declaration order keeps a request diff readable
 * against the column table it came from.
 */
export function requestFieldsOf(columns: readonly ProjectedColumn<string>[]): string[] {
  const sources = new Set<string>()
  for (const column of columns) {
    if (column.source !== null) sources.add(column.source)
  }
  return [...sources]
}

// ---------------------------------------------------------------------------
// Byte-bounded prose
// ---------------------------------------------------------------------------

/**
 * Truncate to a byte budget with an EXPLICIT, IN-BAND marker.
 *
 * Silent truncation is the failure mode to avoid: an agent reading a cut-off
 * root cause as a complete one draws a confident conclusion from half a
 * sentence. The marker states how much is missing, and the raw-event tier
 * remains the way to get the underlying detail.
 *
 * The marker format is part of the contract, not an implementation detail —
 * see this file's header on why it is declared once rather than copied.
 */
export function truncateProse(text: string, byteCap: number): string {
  if (Buffer.byteLength(text, 'utf8') <= byteCap) return text
  // Slice by code points, then trim until the UTF-8 length fits, so a
  // multi-byte character is never cut in half.
  let cut = Array.from(text).slice(0, byteCap)
  while (Buffer.byteLength(cut.join(''), 'utf8') > byteCap) cut = cut.slice(0, -1)
  const kept = cut.join('')
  return `${kept}…[truncated, ${String(Array.from(text).length - cut.length)} more chars]`
}
