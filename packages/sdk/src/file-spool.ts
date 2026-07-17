import type { EventSpool, StoredEvent } from './types.js'

/**
 * Minimal typing of the `node:fs/promises` surface FileSpool uses. Declared
 * locally (and loaded via a dynamic, non-literal import) so the SDK does not
 * depend on `@types/node` and the main entry stays free of any static
 * `node:fs` import — safe to load in browser/edge bundles. The import is only
 * executed when a FileSpool method actually runs.
 */
interface FsPromisesLike {
  appendFile(path: string, data: string, options: { encoding: 'utf8' }): Promise<void>
  readFile(path: string, options: { encoding: 'utf8' }): Promise<string>
  writeFile(path: string, data: string, options: { encoding: 'utf8' }): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
}

let fsModule: Promise<FsPromisesLike> | null = null

/** Lazily load node:fs/promises. Rejects outside Node — surfaced as a spool error. */
function loadFs(): Promise<FsPromisesLike> {
  if (!fsModule) {
    // Non-literal specifier: bundlers cannot statically resolve it, so no
    // browser bundle ever tries to include or polyfill node:fs.
    const specifier = 'node:fs/promises'
    fsModule = import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as Promise<FsPromisesLike>
  }
  return fsModule
}

/** Directory part of a path, handling both / and \ separators. '' if none. */
function dirnameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx > 0 ? filePath.slice(0, idx) : ''
}

/**
 * Node-only {@link EventSpool} backed by a JSONL (one JSON object per line)
 * append-only file.
 *
 * Durability model:
 * - `append` appends one line per entry; `drain` reads every line, parses it,
 *   and truncates the file; `clear` truncates the file.
 * - Lines that fail to parse (e.g. a partial line from a crash mid-append) are
 *   skipped silently on drain — a torn tail line loses at most that one entry.
 *
 * SINGLE-PROCESS ASSUMPTION: the file is used WITHOUT any file locking
 * (deliberately `flock`-free — there is no portable lock primitive in
 * `node:fs`). Exactly one recorder in one process may use a given spool path
 * at a time; two processes appending/draining the same path can interleave
 * writes and lose or duplicate entries. Use one spool path per recorder
 * instance (e.g. include the worker ID in the path).
 *
 * The parent directory is created on first append if missing. All methods
 * reject on I/O failure; the `Recorder` routes those rejections to
 * `RecorderOptions.onSpoolError` and never lets them crash the host.
 *
 * @example
 * ```typescript
 * import { Recorder, FileSpool } from '@agent-flight-recorder/sdk'
 *
 * const recorder = new Recorder({
 *   endpoint, apiKey, agentId,
 *   options: { spool: new FileSpool('/var/tmp/afr-spool/worker-1.jsonl') },
 * })
 * await recorder.recover() // re-send anything a previous process left behind
 * ```
 */
export class FileSpool implements EventSpool {
  private readonly path: string
  /** Serializes this spool's own file operations (append vs drain races). */
  private chain: Promise<unknown> = Promise.resolve()
  private dirEnsured = false

  /**
   * @param path - Absolute path of the JSONL spool file. The parent directory
   *   is created (recursively) on first write if it does not exist.
   */
  constructor(path: string) {
    this.path = path
  }

  /** Run `op` after all previously enqueued file operations complete. */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    // The stored chain never rejects (failures are caught below), so a plain
    // .then keeps FIFO ordering even after a failed operation.
    const run = this.chain.then(() => op())
    this.chain = run.catch(() => {})
    return run
  }

  /** Append entries as JSONL lines. Durable (fs-flushed by Node) on resolve. */
  append(entries: StoredEvent[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve()
    return this.serialize(async () => {
      const fs = await loadFs()
      if (!this.dirEnsured) {
        const dir = dirnameOf(this.path)
        if (dir !== '') await fs.mkdir(dir, { recursive: true })
        this.dirEnsured = true
      }
      const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      await fs.appendFile(this.path, lines, { encoding: 'utf8' })
    })
  }

  /**
   * Read all entries (append order), truncate the file, and return them.
   * Unparseable lines (torn writes from a crash) are skipped. A missing file
   * is an empty spool, not an error.
   */
  drain(): Promise<StoredEvent[]> {
    return this.serialize(async () => {
      const fs = await loadFs()
      let raw: string
      try {
        raw = await fs.readFile(this.path, { encoding: 'utf8' })
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return []
        throw err
      }
      const entries: StoredEvent[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed) as StoredEvent
          if (parsed && (parsed.kind === 'event' || parsed.kind === 'status')) {
            entries.push(parsed)
          }
        } catch {
          // Torn/corrupt line (e.g. crash mid-append) — skip it.
        }
      }
      await fs.writeFile(this.path, '', { encoding: 'utf8' })
      return entries
    })
  }

  /** Truncate the spool file. A missing file is already clear. */
  clear(): Promise<void> {
    return this.serialize(async () => {
      const fs = await loadFs()
      try {
        await fs.writeFile(this.path, '', { encoding: 'utf8' })
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return
        throw err
      }
    })
  }
}
