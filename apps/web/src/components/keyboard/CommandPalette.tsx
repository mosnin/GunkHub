'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  onShowShortcuts: () => void
}

interface CommandContext {
  router: ReturnType<typeof useRouter>
  onShowShortcuts: () => void
  onClose: () => void
}

interface Command {
  id: string
  label: string
  hint?: string
  run: (ctx: CommandContext) => void
}

// Static command list — no new dependency, no async source. Extend here as
// new destinations are added; every command must be a plain synchronous
// action (navigation, clipboard, opening another dialog).
const COMMANDS: Command[] = [
  { id: 'nav-dashboard', label: 'Go to Dashboard', run: ({ router }) => router.push('/dashboard') },
  { id: 'nav-projects', label: 'Go to Projects', run: ({ router }) => router.push('/projects') },
  { id: 'nav-agents', label: 'Go to Agents', run: ({ router }) => router.push('/agents') },
  { id: 'nav-runs', label: 'Go to Runs', run: ({ router }) => router.push('/runs') },
  { id: 'nav-search', label: 'Go to Search', run: ({ router }) => router.push('/search') },
  { id: 'nav-compare', label: 'Go to Compare', run: ({ router }) => router.push('/diff') },
  { id: 'nav-audit', label: 'Go to Audit log', run: ({ router }) => router.push('/audit') },
  { id: 'nav-settings', label: 'Go to Settings', run: ({ router }) => router.push('/settings') },
  { id: 'nav-members', label: 'Go to Members', run: ({ router }) => router.push('/settings/members') },
  { id: 'nav-usage', label: 'Go to Usage', run: ({ router }) => router.push('/settings/usage') },
  { id: 'nav-alerts', label: 'Go to Alerts', run: ({ router }) => router.push('/settings/alerts') },
  { id: 'nav-webhooks', label: 'Go to Webhooks', run: ({ router }) => router.push('/settings/webhooks') },
  {
    id: 'copy-url',
    label: 'Copy current URL',
    run: () => {
      if (typeof window !== 'undefined') {
        void navigator.clipboard.writeText(window.location.href)
      }
    },
  },
  {
    id: 'show-shortcuts',
    label: 'Show shortcuts',
    hint: '?',
    run: ({ onShowShortcuts }) => onShowShortcuts(),
  },
]

/** Subsequence match, case-insensitive — every character of `query` must
    appear in `target` in order, though not necessarily contiguous. A plain
    substring match is a special case of this, so this alone covers both
    "type the whole word" and "type a fuzzy fragment". */
function fuzzyMatch(query: string, target: string): boolean {
  if (query.length === 0) return true
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

/**
 * Command palette (⌘K / Ctrl+K) — a lightweight, dependency-free way to jump
 * anywhere or run a global action without leaving the keyboard. Mounted once
 * from app/(app)/layout.tsx.
 */
export function CommandPalette({ isOpen, onClose, onShowShortcuts }: CommandPaletteProps) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(
    () => COMMANDS.filter((cmd) => fuzzyMatch(query, cmd.label)),
    [query],
  )

  // Reset transient state whenever the palette opens, and put focus in the
  // search input (useFocusTrap already moves focus to the first focusable
  // element in the dialog, which is this input).
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [isOpen])

  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)))
  }, [results.length])

  useEffect(() => {
    if (!isOpen) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  function runCommand(cmd: Command | undefined) {
    if (!cmd) return
    onClose()
    cmd.run({ router, onShowShortcuts, onClose })
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runCommand(results[activeIndex])
    }
  }

  const listboxId = 'command-palette-listbox'
  const activeOption = results[activeIndex]

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/70 backdrop-blur-sm motion-reduce:backdrop-blur-none"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className="w-full max-w-lg mx-4 rounded-[4px] border border-graphite-light bg-graphite-deep shadow-lg outline-none animate-fade-up motion-reduce:animate-none overflow-hidden"
      >
        {/* Search input — combobox pattern, listbox below */}
        <div className="border-b border-neutral-800 flex items-center gap-2 px-4">
          <span className="text-pewter text-sm font-mono shrink-0" aria-hidden="true">›</span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeOption ? `cmdopt-${activeOption.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="Type a command… (⌘K / Ctrl+K to reopen, ? for shortcuts)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            className="flex-1 bg-transparent py-3 text-sm text-neutral-100 placeholder-neutral-500 outline-none font-mono"
          />
        </div>

        {/* Results */}
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="max-h-72 overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            <li className="px-4 py-3 text-xs text-pewter">No matching commands</li>
          ) : (
            results.map((cmd, idx) => (
              <li
                key={cmd.id}
                id={`cmdopt-${cmd.id}`}
                role="option"
                aria-selected={idx === activeIndex}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => runCommand(cmd)}
                className={[
                  'flex items-center justify-between gap-3 px-4 py-2 text-sm cursor-pointer transition-colors duration-75',
                  idx === activeIndex
                    ? 'bg-neutral-900 text-neon-glow'
                    : 'text-neutral-300 hover:bg-neutral-900/60',
                ].join(' ')}
              >
                <span>{cmd.label}</span>
                {cmd.hint && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded-[4px] bg-neutral-950 border border-neutral-700 text-xs font-mono text-pewter">
                    {cmd.hint}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
