'use client'

import { UserButton } from '@clerk/nextjs'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2H12.5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function CpuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 4V2M8 4V2M10 4V2M6 14v-2M8 14v-2M10 14v-2M4 6H2M4 8H2M4 10H2M14 6h-2M14 8h-2M14 10h-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4 3.5l9 4.5-9 4.5V3.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function ColumnsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="2" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M8 1.5l5 2v3.7c0 3.2-2.1 5.7-5 6.8-2.9-1.1-5-3.6-5-6.8V3.5l5-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.5 8l1.7 1.7L10.5 6.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2 12.5L6 7l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="14" cy="4" r="1.25" fill="currentColor" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Several nodes, one of them alight — the cross-agent view. */
function FleetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="3.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="3.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.5" cy="12.5" r="1.75" fill="currentColor" />
      <path d="M5.25 3.5h5.5M3.5 5.25v5.5M12.5 5.25v5.5M5.25 12.5h5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

const navItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: <GridIcon /> },
  { label: 'Projects', href: '/projects', icon: <FolderIcon /> },
  { label: 'Agents', href: '/agents', icon: <CpuIcon /> },
  { label: 'Runs', href: '/runs', icon: <PlayIcon /> },
  // Placed directly above Patterns: Patterns is the per-fingerprint memory,
  // Fleet is the cross-agent view of the same failures during an incident.
  { label: 'Fleet', href: '/fleet', icon: <FleetIcon /> },
  { label: 'Patterns', href: '/patterns', icon: <TrendIcon /> },
  { label: 'Search', href: '/search', icon: <SearchIcon /> },
  { label: 'Compare', href: '/diff', icon: <ColumnsIcon /> },
  { label: 'Audit', href: '/audit', icon: <ShieldIcon /> },
  { label: 'Settings', href: '/settings', icon: <GearIcon /> },
]

interface SidebarProps {
  /**
   * 'rail' — the fixed desktop sidebar (`lg:` and up), unchanged from before.
   * 'drawer' — rendered inside the mobile off-canvas dialog (MobileNav). Same
   * content and behavior, slightly narrower and without the rail's border/shrink
   * constraints since the drawer panel itself defines the edge.
   */
  variant?: 'rail' | 'drawer'
}

export function Sidebar({ variant = 'rail' }: SidebarProps) {
  const pathname = usePathname()

  return (
    <aside
      className={cn(
        'flex flex-col py-4 px-3 bg-blackout h-full',
        variant === 'rail'
          ? 'w-[220px] border-r border-graphite-light shrink-0'
          : 'w-[260px] max-w-[85vw] border-r border-graphite-light'
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-2 mb-6">
        <div className="w-7 h-7 rounded-[4px] bg-neon-glow flex items-center justify-center shrink-0">
          <span className="text-[10px] font-semibold font-mono text-blackout">AFR</span>
        </div>
        <span className="text-xs text-ash leading-tight">Agent Flight Recorder</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 flex flex-col gap-0.5">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-2.5 px-2.5 py-2 rounded-[4px] text-sm transition-colors duration-150',
                isActive
                  ? 'bg-graphite text-whiteout'
                  : 'text-ash hover:text-whiteout hover:bg-graphite-deep'
              )}
            >
              {isActive && (
                /* Active-nav tick with the sanctioned accent glow token —
                   see design.md "Glow" (status/live indicators only). */
                <span
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-neon-glow shadow-[var(--shadow-glow)]"
                  aria-hidden="true"
                />
              )}
              <span className={cn('shrink-0', isActive && 'text-neon-glow')}>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      {/* User */}
      <div className="mt-4 px-2 flex items-center gap-2.5">
        <UserButton afterSignOutUrl="/sign-in" />
      </div>
    </aside>
  )
}
