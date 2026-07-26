'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

interface SettingsNavItem {
  label: string
  href: string
}

const NAV_ITEMS: SettingsNavItem[] = [
  { label: 'General', href: '/settings' },
  { label: 'Members', href: '/settings/members' },
  { label: 'Usage', href: '/settings/usage' },
  { label: 'Alerts', href: '/settings/alerts' },
  { label: 'Budgets', href: '/settings/budgets' },
  { label: 'Webhooks', href: '/settings/webhooks' },
]

/**
 * Settings sub-navigation. URL-driven route links (not in-place panel
 * switching), so this follows the run-detail pattern: a plain <nav
 * aria-label> with aria-current="page" rather than the <Tabs> component,
 * which is reserved for client-side panel switching — see Tabs.tsx doc
 * comment.
 */
export function SettingsNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Settings sections" className="border-b border-graphite px-6">
      <div className="flex gap-6">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === '/settings' ? pathname === '/settings' : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative pb-3 pt-3 text-sm font-medium border-b-2 transition-colors duration-100 whitespace-nowrap',
                isActive
                  ? 'border-neon-glow text-whiteout'
                  : 'border-transparent text-ash hover:text-whiteout hover:border-graphite-light'
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
