'use client'

import { useEffect } from 'react'

/**
 * True when the keydown originated in a text-entry context — shared guard so
 * no keyboard shortcut (global or scoped to a single inspector) ever hijacks
 * typing in an input, textarea, select, or contentEditable element.
 *
 * This is the single source of truth for that guard; Timeline, EventInspector,
 * ReplayViewer, ShortcutOverlay, and CommandPalette all defer to it instead of
 * each re-implementing the same check.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

interface UseGlobalKeydownOptions {
  enabled?: boolean
}

/**
 * Registers a document-wide keydown listener for shortcuts that must work no
 * matter what has focus on the page (the shortcut overlay, the command
 * palette). Automatically bails via `isEditableTarget` so it never steals a
 * keystroke from a form control the user is typing into.
 */
export function useGlobalKeydown(
  handler: (e: KeyboardEvent) => void,
  opts: UseGlobalKeydownOptions = {},
): void {
  const { enabled = true } = opts

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return
      handler(e)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, handler])
}

/**
 * Shared list-navigation key predicates. Every inspector (Timeline,
 * EventInspector, ReplayViewer) checks these instead of hardcoding key
 * literals, so the "down"/"up"/"first"/"last" vocabulary stays identical
 * across the app: arrows work everywhere, `j`/`k` are always available as
 * aliases, and `g`/`G` (or Home/End) always jump to the ends of the list.
 */
export function isNavDownKey(e: { key: string }): boolean {
  return e.key === 'ArrowDown' || e.key === 'j'
}

export function isNavUpKey(e: { key: string }): boolean {
  return e.key === 'ArrowUp' || e.key === 'k'
}

export function isNavFirstKey(e: { key: string }): boolean {
  return e.key === 'Home' || e.key === 'g'
}

export function isNavLastKey(e: { key: string }): boolean {
  return e.key === 'End' || e.key === 'G'
}

export function isPrimaryActionKey(e: { key: string }): boolean {
  return e.key === 'Enter'
}
