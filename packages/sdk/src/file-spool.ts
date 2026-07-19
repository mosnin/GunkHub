import type { EventSpool, StoredEvent } from './types.js'

/**
 * Minimal typing of the `node:fs/promises` surface FileSpool uses. Declared
 * locally (and loaded via a dynamic, non-literal import) so the SDK does not
 * depend on `@types/node` and the main entry stays free of any static
 * `node:fs` import — safe to load in browser/edge bundles. The import is only
 * executed when a FileSpool method actually runs.
 */
interface FileHandleLike {
  sync(): Promise<void>
  close(): Promise<void>
}

interface FsPromisesLike {
  appendFile(path: string, data: string, options: { encoding: 'utf8' }): Promise<void>
  readFile(path: string, options: { encoding: 'utf8' }): Promise<string>
  writeFile(path: string, data: string, options: { encoding: 'utf8' }): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  open(path: string, flags: string): Promise<FileHandleLike>
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

/** Options for {@link FileSpool}. */
export interface FileSpoolOptions {
  /**
   * When true, `fsync` the spool file after every append so entries survive a
   * whole-machine crash or power loss (at a per-append latency cost). When
   * false (the default), appends land in the OS page cache — durable across a
   * process crash, but not across a kernel panic or power loss. Default: false.
   */
  fsync?: boolean
}

/**
 * Node-only {@link EventSpool} backed by a JSONL (one JSON object per line)
 * append-only file.
 *
 * Durability model:
 * - `append` appends one line per entry. On resolve the data has been handed
 *   to the OS (page cache): it survives a crash of THIS PROCESS, but a kernel
 *   panic or power loss before the OS writes it out can still lose the tail.
 *   Pass `{ fsync: true }` to flush to stable storage on every append.
 * - `peek` reads every line and parses it WITHOUT modifying the file; `clear`
 *   truncates the file. `Recorder.recover()` uses peek → send → clear+rewrite,
 *   so a crash mid-recovery re-sends duplicates rather than losing entries.
 * - Lines that fail to parse (e.g. a partial line from a crash mid-append) are
 *   skipped silently on peek — a torn tail line loses at most that one entry.
 *
 * SINGLE-PROCESS ASSUMPTION: the file is used WITHOUT any file locking
 * (deliberately `flock`-free — there is no portable lock primitive in
 * `node:fs`). Exactly one recorder in one process may use a given spool path
 * at a time; two processes appending/rewriting the same path can interleave
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
/**
 * Process-level registry of spool paths currently claimed by a `FileSpool`
 * instance (module-scoped, so it survives across `Recorder`s and is shared by
 * every `FileSpool` in this process). Two `FileSpool`s writing the same path
 * race their appends/truncates against each other (no `flock`, by design —
 * see the SINGLE-PROCESS ASSUMPTION note below) and can silently corrupt or
 * duplicate entries. This registry can't prevent that (there is no portable
 * way to lock a path), so it only warns — once per path, not once per
 * instance, so constructing many short-lived spools at the same path doesn't
 * spam the console.
 */
const openSpoolPaths = new Set<string>()
const warnedDuplicateSpoolPaths = new Set<string>()

export class FileSpool implements EventSpool {
  private readonly path: string
  private readonly fsync: boolean
  /** Serializes this spool's own file operations (append vs peek/clear races). */
  private chain: Promise<unknown> = Promise.resolve()
  private dirEnsured = false

  /**
   * @param path - Absolute path of the JSONL spool file. The parent directory
   *   is created (recursively) on first write if it does not exist.
   * @param options - Optional durability tuning (see {@link FileSpoolOptions}).
   */
  constructor(path: string, options?: FileSpoolOptions) {
    this.path = path
    this.fsync = options?.fsync ?? false

    if (openSpoolPaths.has(path)) {
      if (!warnedDuplicateSpoolPaths.has(path)) {
        warnedDuplicateSpoolPaths.add(path)
        console.warn(
          `[afr-sdk] FileSpool: another FileSpool instance in this process already targets path "${path}". ` +
            'Two FileSpool instances writing the same path race their appends/truncates and can silently ' +
            'corrupt or duplicate entries (see the SINGLE-PROCESS ASSUMPTION in file-spool.ts). Use a distinct ' +
            'path per instance (e.g. include a worker ID in the path).'
        )
      }
    } else {
      openSpoolPaths.add(path)
    }
  }

  /** Run `op` after all previously enqueued file operations complete. */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    // The stored chain never rejects (failures are caught below), so a plain
    // .then keeps FIFO ordering even after a failed operation.
    const run = this.chain.then(() => op())
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * Append entries as JSONL lines. On resolve the data is in the OS page
   * cache (survives a process crash); with `fsync: true` it is flushed to
   * stable storage (survives power loss) before resolve.
   */
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
      if (this.fsync) {
        const handle = await fs.open(this.path, 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    })
  }

  /**
   * Read all entries (append order) WITHOUT modifying the file. Unparseable
   * lines (torn writes from a crash) are skipped. A missing file is an empty
   * spool, not an error.
   */
  peek(): Promise<StoredEvent[]> {
    return this.serialize(() => this.readEntries())
  }

  /**
   * Read all entries (append order), truncate the file, and return them.
   *
   * @deprecated The `Recorder` no longer calls this — it truncates BEFORE the
   * caller has delivered the entries, so a crash mid-recovery loses data. Use
   * `peek()` then `clear()` (after successful delivery) instead. Kept for
   * backwards compatibility with code written against SDK <= 0.3.0.
   */
  drain(): Promise<StoredEvent[]> {
    return this.serialize(async () => {
      const entries = await this.readEntries()
      await this.truncate()
      return entries
    })
  }

  /** Truncate the spool file. A missing file is already clear. */
  clear(): Promise<void> {
    return this.serialize(() => this.truncate())
  }

  /** Read + parse all entries. NOT serialized — callers hold the chain. */
  private async readEntries(): Promise<StoredEvent[]> {
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
    return entries
  }

  /** Truncate the file. NOT serialized — callers hold the chain. */
  private async truncate(): Promise<void> {
    const fs = await loadFs()
    try {
      await fs.writeFile(this.path, '', { encoding: 'utf8' })
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return
      throw err
    }
  }
}
