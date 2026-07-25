/**
 * WindowPicker — window selection as links, never as client state.
 *
 * Every control here is a `<Link>` to a `/fleet?...` URL. That is not a
 * stylistic preference: an incident responder pastes this page's link into a
 * channel, and if the window lived in component state the colleague who opens
 * it would see a different page — possibly one with no findings — at the worst
 * possible moment. The URL is the single source of truth for what is on
 * screen, so it is always shareable and always reproduces.
 *
 * `Pin this moment` freezes the window's END into `?at=`. A live-trailing link
 * is what you want while working; a pinned one is what you want to paste,
 * because "it's the second row" stays true tomorrow. The distinction is
 * offered explicitly rather than guessed at.
 *
 * No `'use client'`: no state, no handlers, no JavaScript. It works with the
 * keyboard because links do.
 */

import Link from 'next/link'

import type { ResolvedFleetWindow } from '@/lib/fleet/window'

import { FLEET_WINDOWS, fleetHref, formatDateTimeUtc } from '@/lib/fleet/window'

const PILL =
  'px-3 py-1 rounded-full font-mono text-xs border transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-glow'
const ACTIVE = 'bg-whiteout text-graphite-deep border-whiteout'
const IDLE = 'bg-transparent text-cloud border-graphite-light hover:bg-graphite'

export function WindowPicker({ window }: { window: ResolvedFleetWindow }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs uppercase text-ash tracking-tight">Window</span>
      {FLEET_WINDOWS.map((w) => {
        const active = w.id === window.option.id
        return (
          <Link
            key={w.id}
            href={fleetHref({ window: w.id, at: window.pinned ? window.endedAt : null })}
            aria-current={active ? 'true' : undefined}
            className={`${PILL} ${active ? ACTIVE : IDLE}`}
          >
            {w.id}
          </Link>
        )
      })}

      <span className="w-px h-4 bg-graphite-light" aria-hidden="true" />

      {window.pinned ? (
        <>
          <span className="font-mono text-xs text-neon-glow tabular-nums">
            PINNED {formatDateTimeUtc(window.endedAt)}
          </span>
          <Link href={fleetHref({ window: window.option.id })} className={`${PILL} ${IDLE}`}>
            Unpin — follow live
          </Link>
        </>
      ) : (
        <Link
          href={fleetHref({ window: window.option.id, at: window.endedAt })}
          className={`${PILL} ${IDLE}`}
          // Spelled out because the difference between a live link and a frozen
          // one is invisible once pasted, and only one of them is quotable.
          title="Freeze this window into the URL so the link shows the same thing later"
        >
          Pin this moment for sharing
        </Link>
      )}
    </div>
  )
}
