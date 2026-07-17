'use client'

import { Sidebar } from './Sidebar'

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen bg-neutral-950 overflow-hidden">
      {/* Skip link — visually hidden until focused; first focusable element (WCAG 2.4.1).
          Neon pill: Whiteout text on Graphite, hairline Graphite Light border. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:inline-flex focus:items-center focus:rounded-full focus:border focus:border-graphite-light focus:bg-graphite focus:px-[18px] focus:py-2 focus:text-sm focus:text-whiteout"
      >
        Skip to content
      </a>
      <Sidebar />
      <main id="main" tabIndex={-1} className="flex-1 overflow-y-auto outline-none">
        {children}
      </main>
    </div>
  )
}
