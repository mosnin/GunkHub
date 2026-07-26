/**
 * fleet/window.ts — the incident window, and why it lives in the URL.
 *
 * An incident responder pastes a link into a channel. If the window is
 * component state, the colleague who opens that link sees a different page —
 * possibly one with no findings at all — and the thread desynchronises at the
 * worst possible moment. So the window is a query parameter, parsed here, and
 * every control that changes it is a `<Link>` to a new URL rather than a
 * client-side handler.
 *
 * `at` pins the window's END. Without it, two people opening the same link ten
 * minutes apart see two different windows, and "it's in the second row" stops
 * being true. With it, the link is a permanent record of what was on screen.
 * A link WITHOUT `at` is live-trailing, which is what you want while the
 * incident is running; the UI offers to pin it once you want to share.
 */

/** UTC clock formatting, so a pasted link reads identically for every reader. */
export function formatClockUtc(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function formatDateTimeUtc(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${formatClockUtc(ms)}Z`
}

export interface FleetWindowOption {
  /** URL value. */
  id: string
  /** Human copy: "last 2 hours". */
  label: string
  ms: number
}

/**
 * The offered windows. Deliberately short at the top: during an incident the
 * useful question is "what changed in the last half hour", and a 7-day window
 * buries a fresh burst under months of background noise.
 */
/**
 * Named rather than reached for by index, so `DEFAULT_FLEET_WINDOW` is
 * PROVABLY a member of the offered list. `FLEET_WINDOWS[1]!` asserted that a
 * literal array had a second element — true today, and silently wrong the first
 * time someone reorders the list, with the assertion suppressing the one signal
 * that would have said so.
 */
const TWO_HOURS: FleetWindowOption = { id: '2h', label: 'last 2 hours', ms: 2 * 60 * 60_000 }

export const FLEET_WINDOWS: readonly FleetWindowOption[] = [
  { id: '30m', label: 'last 30 minutes', ms: 30 * 60_000 },
  TWO_HOURS,
  { id: '6h', label: 'last 6 hours', ms: 6 * 60 * 60_000 },
  { id: '24h', label: 'last 24 hours', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'last 7 days', ms: 7 * 24 * 60 * 60_000 },
]

export const DEFAULT_FLEET_WINDOW: FleetWindowOption = TWO_HOURS

/**
 * The next window out (`+1`) or in (`-1`), for the "widen"/"narrow" affordances
 * the non-answer panels offer.
 *
 * At either end it returns the CURRENT window rather than asserting an
 * out-of-range element. That is also the honest behaviour: there is nothing
 * wider than the widest, and an affordance that silently becomes a no-op is
 * better than one that throws on the screen someone opened during an outage.
 */
export function neighbourWindow(
  current: FleetWindowOption,
  direction: 1 | -1,
): FleetWindowOption {
  const i = FLEET_WINDOWS.findIndex((w) => w.id === current.id)
  if (i < 0) return DEFAULT_FLEET_WINDOW
  return FLEET_WINDOWS[i + direction] ?? current
}

export interface ResolvedFleetWindow {
  option: FleetWindowOption
  startedAt: number
  endedAt: number
  /** True when `endedAt` came from `?at=`, so the link is reproducible. */
  pinned: boolean
}

/**
 * Resolve `?window=` and `?at=` into a concrete interval.
 *
 * Unrecognised input falls back to the default rather than erroring: a
 * mistyped link during an incident should still show the fleet, and the
 * resolved window is always displayed, so the fallback is never silent.
 */
export function resolveFleetWindow(
  params: { window?: string | undefined; at?: string | undefined },
  now: number,
): ResolvedFleetWindow {
  const option = FLEET_WINDOWS.find((w) => w.id === params.window) ?? DEFAULT_FLEET_WINDOW
  const parsedAt = params.at !== undefined ? Number(params.at) : Number.NaN
  const pinned = Number.isFinite(parsedAt) && parsedAt > 0
  const endedAt = pinned ? parsedAt : now
  return { option, startedAt: endedAt - option.ms, endedAt, pinned }
}

/** Build a `/fleet` URL. The single place link hrefs are assembled. */
export function fleetHref(next: {
  window?: string
  at?: number | null
  cursor?: string | null
}): string {
  const q = new URLSearchParams()
  if (next.window !== undefined) q.set('window', next.window)
  if (next.at !== undefined && next.at !== null) q.set('at', String(next.at))
  if (next.cursor !== undefined && next.cursor !== null) q.set('cursor', next.cursor)
  const s = q.toString()
  return s.length > 0 ? `/fleet?${s}` : '/fleet'
}
