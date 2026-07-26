'use client'

import { useCallback, useState } from 'react'

import { CommandPalette } from './CommandPalette'
import { ShortcutOverlay } from './ShortcutOverlay'

import { useGlobalKeydown } from '@/lib/hooks/useKeyScope'

/**
 * App-wide keyboard layer: the `?` shortcut-help overlay and the ⌘K/Ctrl+K
 * command palette. Mounted once from app/(app)/layout.tsx so both are
 * available from any authed page, on top of whatever inspector is focused.
 *
 * Both listeners route through `useGlobalKeydown`, which bails whenever focus
 * is inside an input/textarea/select/contentEditable — typing `?` into a
 * comment box or a form field never pops this layer open.
 */
export function KeyboardLayer() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const handleGlobalKeydown = useCallback((e: KeyboardEvent) => {
    const isPaletteChord = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
    if (isPaletteChord) {
      e.preventDefault()
      setShortcutsOpen(false)
      setPaletteOpen((open) => !open)
      return
    }
    if (e.key === '?' && !paletteOpen) {
      e.preventDefault()
      setShortcutsOpen((open) => !open)
    }
  }, [paletteOpen])

  useGlobalKeydown(handleGlobalKeydown)

  return (
    <>
      <ShortcutOverlay isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onShowShortcuts={() => {
          setPaletteOpen(false)
          setShortcutsOpen(true)
        }}
      />
    </>
  )
}
