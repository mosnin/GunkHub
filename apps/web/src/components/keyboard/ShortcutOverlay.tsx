'use client'

import { useEffect } from 'react'

import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

interface ShortcutOverlayProps {
  isOpen: boolean
  onClose: () => void
}

interface ShortcutRow {
  keys: string
  description: string
}

interface ShortcutGroup {
  title: string
  rows: ShortcutRow[]
}

// The single source of truth for "what shortcuts exist" — CommandPalette's
// "Show shortcuts" entry and the on-screen hints in Timeline/EventInspector/
// ReplayViewer should all describe the same map as this list.
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Global',
    rows: [
      { keys: '?', description: 'Show this help' },
      { keys: '⌘K / Ctrl+K', description: 'Open command palette' },
      { keys: 'Esc', description: 'Close dialog / palette' },
    ],
  },
  {
    title: 'Lists — Timeline & Event Inspector',
    rows: [
      { keys: '↓ / j', description: 'Move to next row' },
      { keys: '↑ / k', description: 'Move to previous row' },
      { keys: 'g / Home', description: 'Jump to first row' },
      { keys: 'G / End', description: 'Jump to last row' },
      { keys: 'Enter', description: 'Expand row (Timeline) / select event (Event Inspector)' },
    ],
  },
  {
    title: 'Replay',
    rows: [
      { keys: '→ / j', description: 'Step to next frame' },
      { keys: '← / k', description: 'Step to previous frame' },
      { keys: 'g / Home', description: 'Jump to first frame' },
      { keys: 'G / End', description: 'Jump to last frame' },
    ],
  },
]

/**
 * The `?` shortcut overlay — a discoverability surface for every keyboard
 * shortcut in the app. Mounted once from app/(app)/layout.tsx so it is
 * available on every authed page, regardless of which inspector is on screen.
 */
export function ShortcutOverlay({ isOpen, onClose }: ShortcutOverlayProps) {
  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen)

  useEffect(() => {
    if (!isOpen) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm motion-reduce:backdrop-blur-none"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-overlay-title"
        tabIndex={-1}
        className="w-full max-w-lg mx-4 max-h-[80vh] flex flex-col rounded-[4px] border border-graphite-light bg-graphite-deep shadow-lg outline-none animate-fade-up motion-reduce:animate-none"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between shrink-0">
          <h2 id="shortcut-overlay-title" className="text-sm font-semibold text-neutral-100">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="w-6 h-6 rounded-full flex items-center justify-center text-pewter hover:text-neutral-200 hover:bg-neutral-800 transition-colors duration-100"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Groups */}
        <div className="px-5 py-4 flex flex-col gap-5 overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-2">
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                {group.title}
              </p>
              <dl className="flex flex-col gap-1.5">
                {group.rows.map((row) => (
                  <div key={row.keys} className="flex items-center justify-between gap-4">
                    <dt className="text-xs text-neutral-400">{row.description}</dt>
                    <dd className="shrink-0 px-2 py-0.5 rounded-[4px] bg-neutral-950 border border-neutral-700 text-xs font-mono text-neon-glow">
                      {row.keys}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>

        {/* Footer note */}
        <div className="px-5 py-3 border-t border-neutral-800 shrink-0">
          <p className="text-xs text-pewter">
            Shortcuts never fire while typing in a text field. Press{' '}
            <span className="font-mono text-neutral-400">?</span> any time to reopen this panel.
          </p>
        </div>
      </div>
    </div>
  )
}
