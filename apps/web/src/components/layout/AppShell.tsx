'use client'

import { MobileNav } from './MobileNav'
import { Sidebar } from './Sidebar'

interface AppShellProps {
  children: React.ReactNode
}

// Below `lg` the shell stacks vertically (mobile header on top, content below)
// and the fixed rail is replaced by MobileNav's off-canvas drawer. At `lg` and
// up this reverts to exactly the previous fixed-sidebar-plus-content row, byte
// for byte the same layout engineers already know.
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex flex-col lg:flex-row min-h-screen lg:h-screen bg-neutral-950 lg:overflow-hidden">
      {/* Skip link — visually hidden until focused; first focusable element (WCAG 2.4.1).
          Neon pill: Whiteout text on Graphite, hairline Graphite Light border. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:items-center focus:rounded-full focus:border focus:border-graphite-light focus:bg-graphite focus:px-[18px] focus:py-2 focus:text-sm focus:text-whiteout"
      >
        Skip to content
      </a>

      {/* Desktop fixed sidebar — unchanged at `lg` and up. */}
      <div className="hidden lg:flex lg:shrink-0">
        <Sidebar />
      </div>

      {/* Mobile header bar + off-canvas drawer — 'use client' island so `main`
          below stays a plain server-renderable slot; only the mobile nav
          chrome itself carries interactive state. */}
      <MobileNav />

      <main
        id="main"
        tabIndex={-1}
        className="flex-1 min-w-0 overflow-y-auto outline-none"
      >
        {children}
      </main>
    </div>
  )
}
