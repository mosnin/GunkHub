'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useGlobalKeydown } from '@/lib/hooks/useKeyScope'

interface RunSearchBarProps {
  /** Initial query — set on /search from the `q` URL param, empty elsewhere. */
  initialQuery?: string
  /**
   * 'navigate' (default, used on /runs): debounced navigation to
   * /search?q=... as the user types. 'live': calls onQueryChange directly
   * instead of navigating — used on /search itself, which already owns the
   * `q` param and re-fetches server-side on navigation.
   */
  mode?: 'navigate' | 'live'
  onQueryChange?: (query: string) => void
  autoFocus?: boolean
}

const DEBOUNCE_MS = 300

/**
 * Org-scoped run search input — debounced, URL-param backed (`?q=`), and
 * keyboard-accessible: pressing `/` anywhere outside a text field focuses it
 * (guarded by useGlobalKeydown's isEditableTarget check, so it never steals a
 * keystroke from another input).
 */
export function RunSearchBar({ initialQuery = '', mode = 'navigate', onQueryChange, autoFocus }: RunSearchBarProps) {
  const router = useRouter()
  const [query, setQuery] = useState(initialQuery)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  useGlobalKeydown(
    useCallback((e: KeyboardEvent) => {
      if (e.key === '/') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }, []),
  )

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  function handleChange(value: string) {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (mode === 'live') {
        onQueryChange?.(value)
      } else if (value.trim().length > 0) {
        router.push(`/search?q=${encodeURIComponent(value.trim())}`)
      }
    }, DEBOUNCE_MS)
  }

  return (
    <div className="relative flex-1 max-w-sm">
      <span
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-pewter text-xs font-mono"
        aria-hidden="true"
      >
        /
      </span>
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Search runs by name, tag, or error…"
        aria-label="Search runs"
        autoFocus={autoFocus}
        className="w-full h-8 pl-6 pr-3 rounded-[4px] bg-graphite-deep border border-graphite-light text-sm text-whiteout placeholder-pewter font-mono outline-none focus:ring-1 focus:ring-neon-glow transition-colors duration-100"
      />
    </div>
  )
}
