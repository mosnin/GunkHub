'use client'

import { useEffect, useRef } from 'react'

/**
 * Accessible modal focus management. When `active` becomes true this:
 *  - records the element that had focus (the trigger) so it can be restored,
 *  - moves focus into the container (its first focusable element, else itself),
 *  - traps Tab / Shift+Tab within the container while active,
 *  - restores focus to the trigger when the modal closes/unmounts.
 *
 * Returns a ref to attach to the dialog container element.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const containerRef = useRef<T | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return

    previouslyFocused.current = document.activeElement as HTMLElement | null
    const container = containerRef.current
    if (!container) return

    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

    function focusables(): HTMLElement[] {
      if (!container) return []
      return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
    }

    // Move focus into the dialog.
    const initial = focusables()[0] ?? container
    initial.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        container?.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      // items.length > 0 is guaranteed by the early return above, so both are
      // defined; the guard satisfies noUncheckedIndexedAccess without an assertion.
      if (!first || !last) return
      const activeEl = document.activeElement

      if (e.shiftKey) {
        if (activeEl === first || activeEl === container) {
          e.preventDefault()
          last.focus()
        }
      } else if (activeEl === last) {
        e.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => {
      container.removeEventListener('keydown', handleKeyDown)
      // Restore focus to the trigger on close.
      previouslyFocused.current?.focus?.()
    }
  }, [active])

  return containerRef
}
