'use client'

import { useRef } from 'react'

import { cn } from '@/lib/utils'

export interface TabItem {
  id: string
  label: string
}

interface TabsProps {
  tabs: TabItem[]
  active: string
  onChange: (id: string) => void
  className?: string
}

/** DOM id for a tab button. Pair panels via <TabPanel tabId={...}>. */
function tabDomId(id: string): string {
  return `tab-${id}`
}

/** DOM id for a tab panel. */
function panelDomId(id: string): string {
  return `tabpanel-${id}`
}

/**
 * Client-side tab switcher implementing the full WAI-ARIA tabs pattern:
 * roving tabindex, ArrowLeft/ArrowRight/Home/End activation, and
 * aria-controls wiring to a matching <TabPanel>.
 *
 * For URL-driven section navigation (links that change the route), use a
 * plain <nav aria-label> with aria-current="page" instead — see the run
 * detail page. Tabs is only for in-place panel switching.
 */
export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null)

  function focusAndActivate(idx: number) {
    const tab = tabs[idx]
    if (!tab) return
    onChange(tab.id)
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[idx]?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const currentIdx = tabs.findIndex((t) => t.id === active)
    if (currentIdx === -1) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusAndActivate((currentIdx + 1) % tabs.length)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusAndActivate((currentIdx - 1 + tabs.length) % tabs.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusAndActivate(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusAndActivate(tabs.length - 1)
    }
  }

  return (
    <div className={cn('border-b border-neutral-800', className)}>
      <div ref={listRef} className="-mb-px flex gap-6" role="tablist" onKeyDown={handleKeyDown}>
        {tabs.map((tab) => {
          const isActive = tab.id === active
          return (
            <button
              key={tab.id}
              id={tabDomId(tab.id)}
              role="tab"
              aria-selected={isActive}
              aria-controls={panelDomId(tab.id)}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={cn(
                'pb-3 text-sm font-medium border-b-2 transition-colors duration-100 whitespace-nowrap',
                isActive
                  ? 'border-primary-500 text-neutral-100'
                  : 'border-transparent text-pewter hover:text-neutral-300 hover:border-neutral-600'
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface TabPanelProps {
  /** The TabItem id this panel belongs to. */
  tabId: string
  /** Whether this panel's tab is active. Inactive panels are not rendered. */
  active: boolean
  children: React.ReactNode
  className?: string
}

/** Panel counterpart to <Tabs> — completes the tablist/tab/tabpanel triad. */
export function TabPanel({ tabId, active, children, className }: TabPanelProps) {
  if (!active) return null
  return (
    <div id={panelDomId(tabId)} role="tabpanel" aria-labelledby={tabDomId(tabId)} className={className}>
      {children}
    </div>
  )
}
