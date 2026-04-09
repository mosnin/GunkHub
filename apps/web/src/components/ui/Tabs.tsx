'use client'

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

export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div className={cn('border-b border-neutral-800', className)}>
      <nav className="-mb-px flex gap-6" role="tablist">
        {tabs.map((tab) => {
          const isActive = tab.id === active
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              className={cn(
                'pb-3 text-sm font-medium border-b-2 transition-colors duration-100 whitespace-nowrap',
                isActive
                  ? 'border-primary-500 text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
