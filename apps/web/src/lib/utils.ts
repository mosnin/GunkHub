import { clsx, type ClassValue } from 'clsx'

/** Merge Tailwind class names safely. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: 45ms | 1.2s | 2m 3s
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/**
 * Format a Unix timestamp (ms) as a relative time string.
 * Examples: "just now" | "2 minutes ago" | "3 hours ago"
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffSec = Math.floor(diffMs / 1000)

  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec} seconds ago`

  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return diffMin === 1 ? '1 minute ago' : `${diffMin} minutes ago`

  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return diffHr === 1 ? '1 hour ago' : `${diffHr} hours ago`

  const diffDays = Math.floor(diffHr / 24)
  if (diffDays < 30) return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`

  const diffMonths = Math.floor(diffDays / 30)
  return diffMonths === 1 ? '1 month ago' : `${diffMonths} months ago`
}

/**
 * Truncate an ID to a short prefix for display.
 * Defaults to first 8 characters.
 */
export function truncateId(id: string, length = 8): string {
  if (id.length <= length) return id
  return id.slice(0, length)
}

/**
 * Parses `value` as a URL ONLY if it is `http:`/`https:` — used to decide
 * whether a free-form, human-entered reference string (e.g.
 * `FailurePattern.resolutionRef`, see docs/adr/006-failure-resolution.md) may
 * be rendered as an external `<a>` link. Anything else (a bare agentVersionId,
 * a `javascript:`/`data:`/`file:` URI, plain prose) returns `null` and must be
 * rendered as plain text — this is the ONLY gate between untrusted free text
 * and an anchor's `href`, so it fails closed on anything that doesn't parse
 * cleanly as http(s).
 */
export function parseSafeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * Format a byte count as a human-readable size string.
 * Examples: 512B | 3.4KB | 12.1MB | 2.0GB
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)}${units[unitIndex]}`
}
