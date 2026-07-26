'use client'

import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { Sidebar } from './Sidebar'

import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Mobile app header + off-canvas navigation drawer. Visible only below `lg`
 * (the desktop fixed sidebar in AppShell takes over at `lg` and up).
 *
 * Dialog pattern (WAI-ARIA): role="dialog" + aria-modal, focus is trapped
 * inside the drawer via useFocusTrap (shared with other AFR dialogs), Escape
 * and backdrop click close it, and focus restores to the trigger button on
 * close (handled by useFocusTrap's own cleanup, since it records
 * document.activeElement — the trigger — when the drawer opens).
 */
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useFocusTrap<HTMLDivElement>(open)

  // Close the drawer whenever the route changes (e.g. a nav link was followed).
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Escape closes the drawer. Tab-trapping is already handled by useFocusTrap.
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  return (
    <>
      {/* Mobile header bar — Blackout ground, hairline bottom border (design.md). */}
      <header className="lg:hidden flex items-center justify-between h-14 px-4 shrink-0 bg-blackout border-b border-graphite-light">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-[4px] bg-neon-glow flex items-center justify-center shrink-0">
            <span className="text-[10px] font-semibold font-mono text-blackout">AFR</span>
          </div>
          <span className="text-xs text-ash leading-tight">Agent Flight Recorder</span>
        </div>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center justify-center w-9 h-9 rounded-[4px] text-ash hover:text-whiteout hover:bg-graphite-deep transition-colors duration-150"
        >
          <MenuIcon />
        </button>
      </header>

      {/* MotionConfig(reducedMotion="user") makes framer-motion honor OS-level
          prefers-reduced-motion automatically — matching the pattern already
          used by src/components/ui/Motion.tsx — so the slide/fade collapse to
          an instant show/hide for users who request reduced motion. */}
      <MotionConfig reducedMotion="user">
        <AnimatePresence>
          {open && (
            <>
              <motion.button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setOpen(false)}
                className="fixed inset-0 z-40 bg-black/70 lg:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
              <motion.div
                id="mobile-nav-drawer"
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Navigation"
                tabIndex={-1}
                className="fixed inset-y-0 left-0 z-50 lg:hidden outline-none"
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              >
                <Sidebar variant="drawer" />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </MotionConfig>
    </>
  )
}
