/**
 * @vitest-environment jsdom
 *
 * Accessibility regression guards for the Failure-Pattern Resolution UI
 * (ADR-006 cycles 1–2): PatternStatusBadge, PatternStatusFilter,
 * PatternLifecycleControl, PatternLifecycleTimeline, FixConfidenceBadge,
 * FixConfidenceMeter, ResolutionEvidencePanel, SpikeBadge, MutedBadge,
 * PatternRow/PatternList, and the dashboard's TopFailurePatternsCard.
 *
 * THESE ARE RENDERED-DOM ASSERTIONS. The previous revision of this file
 * asserted against component SOURCE TEXT with regexes, because the test
 * package had no DOM environment. It said so in its own header, and listed
 * what it therefore could not cover: real focus order, composited contrast,
 * and whether a live region actually announces. It also carried a quote-aware
 * comment stripper, because several of these components quote the very
 * anti-patterns being guarded against, so naive scanning would both fail
 * correct code and let a real violation hide inside a comment.
 *
 * That stripper is gone. It existed only to work around the missing DOM, and
 * a rendered tree has no comments in it to strip. Every guard below now reads
 * the tree React actually produced.
 *
 * WHAT THE PORT CHANGED, BEYOND MECHANISM. Two guards were asserting
 * something that is FALSE once rendered. Both are documented at their
 * assertion site, and both were only possible to miss because a regex over
 * one file cannot see a composed child:
 *
 *   1. "The row has exactly one tab stop." It has TWO — the label link and
 *      the CopyToClipboardButton. The old guard counted `<Link>` tags only.
 *      See § 4.
 *   2. "Every animation is gated behind motion-safe:." ResolutionEvidencePanel
 *      renders an UNGATED `animate-spin`, inherited from `LoadingState`. The
 *      old guard scanned each component's own file and never saw it. See § 6.
 *
 * WHAT THIS FILE STILL DOES NOT COVER: real composited colour contrast. jsdom
 * parses no Tailwind stylesheet and runs no layout, so `getComputedStyle`
 * reports declared inline values, not cascaded ones. § 2 therefore computes
 * contrast from design.md's token values directly (which is exact and needs no
 * browser) and checks TOKEN USAGE against the rendered class attributes — an
 * improvement on the old source grep, because it now sees composed children,
 * but still not a measurement of pixels. Real composited contrast belongs in
 * tests/e2e, under a browser that actually paints.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import PatternDetailLoading from '@app/(app)/patterns/[fingerprint]/loading'
import PatternsLoading from '@app/(app)/patterns/loading'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AdaptedFailurePattern, AdaptedFixConfidence, FixConfidenceState } from '@/components/patterns/adapt'
import type { PatternLifecycleTransition } from '@agent-flight-recorder/contracts'

import { TopFailurePatternsCard } from '@/components/dashboard/TopFailurePatternsCard'
import { adaptFailurePattern } from '@/components/patterns/adapt'
import { FixConfidenceBadge } from '@/components/patterns/FixConfidenceBadge'
import { FixConfidenceMeter } from '@/components/patterns/FixConfidenceMeter'
import { MutedBadge } from '@/components/patterns/MutedBadge'
import { PatternLifecycleControl } from '@/components/patterns/PatternLifecycleControl'
import { PatternLifecycleTimeline } from '@/components/patterns/PatternLifecycleTimeline'
import { PatternList } from '@/components/patterns/PatternList'
import { PatternRow } from '@/components/patterns/PatternRow'
import { PatternStatusBadge } from '@/components/patterns/PatternStatusBadge'
import { PatternStatusFilter } from '@/components/patterns/PatternStatusFilter'
import { ResolutionEvidencePanel } from '@/components/patterns/ResolutionEvidencePanel'
import { SpikeBadge } from '@/components/patterns/SpikeBadge'


// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Built through the real `adaptFailurePattern` rather than as a hand-written
 * object literal, so a defaulting change in the adapter shows up here instead
 * of being papered over by a fixture that states every field explicitly.
 */
function makePattern(overrides: Record<string, unknown> = {}): AdaptedFailurePattern {
  return adaptFailurePattern({
    id: 'pat_1',
    orgId: 'org_1',
    fingerprintHash: 'a1b2c3d4e5f60718',
    class: 'tool_error',
    label: 'Tool call timed out after 30s',
    salientKey: 'timeout',
    count: 1234,
    firstSeenAt: Date.UTC(2026, 0, 2),
    lastSeenAt: Date.UTC(2026, 5, 1),
    representativeRunIds: ['run_1'],
    affectedAgentVersionIds: ['ver_1', 'ver_2'],
    affectedAgentIds: ['agent_1'],
    status: 'open',
    ...overrides,
  })
}

function makeConfidence(overrides: Partial<AdaptedFixConfidence> = {}): AdaptedFixConfidence {
  return {
    score: 0.62,
    state: 'proving',
    exposureRuns: 40,
    observedRuns: 55,
    versionAttribution: 'matched',
    elapsedMs: 3 * 24 * 60 * 60 * 1000,
    recurred: false,
    hasResolution: true,
    exposureMeasured: true,
    exposureCredit: 0.7,
    soakCredit: 0.4,
    limitingFactor: 'accumulating',
    ...overrides,
  }
}

const TRANSITIONS: PatternLifecycleTransition[] = [
  { action: 'failure_pattern.acknowledged', actorClerkUserId: 'user_abcdefghijklmno', timestamp: Date.UTC(2026, 2, 1) },
  { action: 'failure_pattern.resolved', actorClerkUserId: 'user_abcdefghijklmno', timestamp: Date.UTC(2026, 3, 1) },
  { action: 'failure_pattern.regressed', actorClerkUserId: 'system', timestamp: Date.UTC(2026, 4, 1) },
]

const ALL_CONFIDENCE_STATES: FixConfidenceState[] = ['unproven', 'proving', 'confirmed', 'regressed']

// ─── DOM helpers ─────────────────────────────────────────────────────────────

/** Renders a `<tr>` in a valid table so the row's implicit ARIA roles resolve. */
function renderRow(pattern: AdaptedFailurePattern, confidence?: AdaptedFixConfidence | null) {
  return render(
    <table>
      <tbody>
        <PatternRow pattern={pattern} {...(confidence !== undefined && { confidence })} />
      </tbody>
    </table>,
  )
}

const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'

/**
 * Every element inside `root` that a keyboard can actually land on, in
 * document order. Reads the LIVE DOM: `el.tabIndex` is the resolved value
 * (0 for a natively focusable element with no attribute, -1 when explicitly
 * removed), and `disabled` is the resolved property, not a string.
 *
 * This is the assertion the old source-text guard could not make. It counted
 * `<Link>` tags in one file and therefore could not see a `<button>` rendered
 * by a child component two lines away.
 */
function tabStopsWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLElement & { disabled?: boolean }).disabled,
  )
}

/** Text a sighted user reads off the screen: `sr-only` subtrees removed, `aria-hidden` kept (it is visible, just not announced). */
function visualText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement
  for (const el of clone.querySelectorAll('.sr-only')) el.remove()
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Text a screen reader reads: `aria-hidden` subtrees removed, `sr-only` kept. */
function accessibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement
  for (const el of clone.querySelectorAll('[aria-hidden="true"]')) el.remove()
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The rendered tree with every `class` and `style` attribute deleted — i.e.
 * the page with ALL colour, weight, and shape stripped away. Two states that
 * serialize identically here are two states a monochrome display, a
 * forced-colors theme, and a screen reader cannot tell apart.
 */
function colourStripped(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    el.removeAttribute('class')
    el.removeAttribute('style')
  }
  return clone.innerHTML
}

/** Every `class` token present anywhere in the rendered tree. Replaces the old per-file source grep, and unlike it, sees composed children. */
function renderedClassTokens(root: HTMLElement): string[] {
  const out: string[] = []
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    const cls = el.getAttribute('class')
    if (cls) out.push(...cls.split(/\s+/).filter(Boolean))
  }
  return out
}

/** Elements carrying a live-region role or an explicit `aria-live`. */
function liveRegionsWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="status"], [role="alert"], [role="log"], [aria-live]')]
}

/** True when `el` or any ancestor up to `root` is hidden from assistive technology. */
function isAriaHidden(el: Element, root: Element): boolean {
  let node: Element | null = el
  while (node && node !== root.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true') return true
    node = node.parentElement
  }
  return false
}

// ─── Rendered-tree catalogue ─────────────────────────────────────────────────

/**
 * Every audited component, rendered. The suites that used to iterate
 * `Object.keys(SOURCES)` iterate this instead — same coverage, except each
 * entry is now a real tree including whatever its children rendered.
 *
 * Where a component has materially different shapes (a badge's four states,
 * a panel's four state kinds), each shape is a separate entry: a source file
 * is one string, but a component is as many trees as it has branches, and the
 * old file could only ever check the string.
 */
const RENDERED: Record<string, () => React.ReactElement> = {
  'FixConfidenceBadge/unproven': () => <FixConfidenceBadge state="unproven" score={0} />,
  'FixConfidenceBadge/proving': () => <FixConfidenceBadge state="proving" score={0.5} />,
  'FixConfidenceBadge/confirmed': () => <FixConfidenceBadge state="confirmed" score={0.9} />,
  'FixConfidenceBadge/regressed': () => <FixConfidenceBadge state="regressed" />,
  FixConfidenceMeter: () => <FixConfidenceMeter confidence={makeConfidence()} />,
  MutedBadge: () => <MutedBadge mutedAt={Date.UTC(2026, 4, 1)} />,
  PatternLifecycleControl: () => (
    <PatternLifecycleControl fingerprintHash="a1b2c3" status="open" regressed={false} />
  ),
  PatternLifecycleTimeline: () => (
    <PatternLifecycleTimeline transitions={TRANSITIONS} firstSeenAt={Date.UTC(2026, 0, 2)} resolvedInVersion="v1.4.2" />
  ),
  PatternList: () => <PatternList patterns={[makePattern(), makePattern({ id: 'pat_2', status: 'resolved' })]} />,
  'PatternList/empty': () => <PatternList patterns={[]} />,
  'PatternStatusBadge/open': () => <PatternStatusBadge status="open" />,
  'PatternStatusBadge/acknowledged': () => <PatternStatusBadge status="acknowledged" />,
  'PatternStatusBadge/resolved': () => <PatternStatusBadge status="resolved" />,
  'PatternStatusBadge/regressed': () => <PatternStatusBadge status="open" regressed />,
  PatternStatusFilter: () => (
    <PatternStatusFilter active="regressed" counts={{ all: 9, open: 4, acknowledged: 2, resolved: 2, regressed: 1 }} />
  ),
  'ResolutionEvidencePanel/ready': () => (
    <ResolutionEvidencePanel
      pattern={makePattern({ status: 'resolved', resolvedAt: Date.UTC(2026, 3, 1) })}
      state={{
        kind: 'ready',
        resolvedInVersion: 'v1.4.2',
        evidence: {
          resolution: { resolvedAt: Date.UTC(2026, 3, 1), resolvedByUserId: 'user_1' },
          exposure: {
            since: Date.UTC(2026, 3, 1),
            runCount: 400,
            runCountTruncated: false,
            recurrenceCount: 0,
            baselineRunCount: 120,
            agentIds: ['agent_1'],
            heldSoFar: true,
          },
          transitions: TRANSITIONS,
          confidence: makeConfidence({ state: 'confirmed', score: 0.88 }),
        },
      }}
    />
  ),
  'SpikeBadge/spiking': () => <SpikeBadge isSpiking />,
  'SpikeBadge/unassessed': () => <SpikeBadge isSpiking={false} assessed={false} />,
  TopFailurePatternsCard: () => (
    <TopFailurePatternsCard patterns={[makePattern(), makePattern({ id: 'pat_2', muted: true })]} error={null} />
  ),
}

const RENDERED_NAMES = Object.keys(RENDERED)

/** Renders one catalogue entry and hands back its container. */
function renderCatalogued(name: string): HTMLElement {
  const factory = RENDERED[name]
  expect(factory, `${name} is not in the rendered catalogue`).toBeDefined()
  // PatternRow is the one entry that must live inside a table; it is exercised
  // directly in § 4 and through PatternList here.
  const { container } = render(factory?.() ?? <span />)
  return container
}

// ─── 1. Information must never be carried by colour alone ────────────────────

describe('the regressed / confirmed / unproven distinction survives greyscale', () => {
  /**
   * This product has ONE accent (Neon Glow) on near-black greyscale, which
   * makes "just make the urgent one green" the path of least resistance and
   * leaves anyone on a monochrome display, with a colour-vision deficiency,
   * or in forced-colors mode with four states that render identically.
   *
   * The old file pinned this by reading the `STATE_LABEL` record out of the
   * source and checking the string literals were distinct. That proved a
   * constant was well-formed, not that four renders differ. These render all
   * four, delete every class and style attribute, and require the remaining
   * markup to still be pairwise distinct.
   */
  it('FixConfidenceBadge: all four states stay distinguishable with colour stripped', () => {
    const stripped = new Map<FixConfidenceState, string>()
    const visible = new Map<FixConfidenceState, string>()

    for (const state of ALL_CONFIDENCE_STATES) {
      const { container, unmount } = render(<FixConfidenceBadge state={state} compact />)
      stripped.set(state, colourStripped(container))
      visible.set(state, visualText(container))
      unmount()
    }

    expect(new Set(stripped.values()).size, 'two confidence states are identical once class/style are removed').toBe(4)
    // …and the difference must be in the VISIBLE word, not only in sr-only text:
    // a sighted monochrome user has to be able to tell them apart too.
    expect(new Set(visible.values()).size).toBe(4)
    for (const [state, text] of visible) expect(text.length, `${state} renders no visible word`).toBeGreaterThan(0)

    expect(visible.get('regressed')).toContain('REGRESSED')
    expect(visible.get('unproven')).toContain('UNPROVEN')
    expect(visible.get('confirmed')).toContain('CONFIRMED')
    expect(visible.get('proving')).toContain('PROVING')
  })

  it('PatternStatusBadge: every lifecycle status, plus regressed, is a distinct visible word', () => {
    const visible: string[] = []
    for (const props of [
      { status: 'open' as const },
      { status: 'acknowledged' as const },
      { status: 'resolved' as const },
      { status: 'open' as const, regressed: true },
    ]) {
      const { container, unmount } = render(<PatternStatusBadge {...props} />)
      visible.push(visualText(container))
      unmount()
    }
    expect(new Set(visible).size).toBe(4)
    // The regressed treatment renders its own literal word rather than reusing
    // "OPEN" with a different fill.
    expect(visible[3]).toContain('REGRESSED')
    expect(visible[3]).not.toContain('OPEN')
  })

  it('the regressed badge still says "regressed" with the pulsing dot removed from the a11y tree', () => {
    // The dot is aria-hidden and motion-safe-gated, so with reduced motion on
    // and a screen reader running it conveys nothing at all. The word must
    // survive both removals.
    const { container } = render(<PatternStatusBadge status="open" regressed />)
    expect(accessibleText(container)).toContain('REGRESSED')

    const dots = [...container.querySelectorAll('[class*="animate-"]')]
    expect(dots.length, 'expected the pulsing dot').toBeGreaterThan(0)
    for (const dot of dots) {
      expect(dot, 'the pulsing dot must be hidden from AT').toHaveAttribute('aria-hidden', 'true')
      // Deleting the dot entirely must not remove the fact it decorates.
      dot.remove()
    }
    expect(visualText(container)).toContain('REGRESSED')
  })

  it("FixConfidenceMeter states each credit bar's value in text, not only as a bar width", () => {
    const { container } = render(
      <FixConfidenceMeter confidence={makeConfidence({ exposureCredit: 0.7, soakCredit: 0.4 })} />,
    )

    // The bars themselves are (correctly) hidden from AT…
    const bars = [...container.querySelectorAll<HTMLElement>('[style*="width"]')]
    expect(bars.length, 'expected two credit bars').toBeGreaterThan(0)
    for (const bar of bars) expect(isAriaHidden(bar, container)).toBe(true)

    // …so the fraction each encodes has to be readable as text.
    const spoken = accessibleText(container)
    expect(spoken).toContain('70%')
    expect(spoken).toContain('40%')
    // And "earned" must not be conveyed only by the fill colour.
    expect(spoken).toContain('earned')
  })

  it('the recurrence fact is worded, not only coloured', () => {
    const failed = render(<FixConfidenceMeter confidence={makeConfidence({ recurred: true })} />)
    expect(accessibleText(failed.container)).toContain('failed again')
    failed.unmount()

    const held = render(<FixConfidenceMeter confidence={makeConfidence({ recurred: false })} />)
    expect(accessibleText(held.container)).toContain('none since fix')
  })

  it('the score never appears without its ceiling and its state word beside it', () => {
    const { container } = render(<FixConfidenceMeter confidence={makeConfidence({ score: 0.62 })} />)
    const text = accessibleText(container)
    expect(text).toContain('0.62')
    expect(text).toContain('0.95')
    expect(text).toContain('PROVING')
    // The limiting factor is worded, not left as a bare enum for the reader.
    expect(text).toContain('Evidence is still accumulating')
  })
})

// ─── 2. Contrast against the real token values ───────────────────────────────

describe('text contrast against design.md token values', () => {
  /**
   * Every colour below is transcribed from design.md's token table, NOT from
   * tailwind.config.ts. The point is to catch a token whose real value fails
   * contrast, not to check that Tailwind copied a hex correctly.
   *
   * This block stays pure arithmetic on purpose. jsdom loads no Tailwind
   * stylesheet and performs no layout, so asking it for a computed colour
   * would return the declared value or nothing — a measurement that looks
   * more real than the arithmetic while being strictly less true. Actual
   * composited contrast needs a browser; that belongs in tests/e2e.
   *
   * (design.md's Quick Start block lists Pewter as the 5-digit `#94979`, which
   * is not a colour; the token table's `#94979e` is the value tailwind.config.ts
   * ships and the value used here. Reported to the design owner rather than
   * silently patched, since design.md is not this team's file.)
   */
  const TOKENS = {
    whiteout: '#ffffff',
    cloud: '#c9cbcf',
    pewter: '#94979e',
    ash: '#797d86',
    graphiteLight: '#303236',
    graphite: '#242628',
    graphiteDeep: '#151617',
    blackout: '#000000',
    neonGlow: '#34d59a',
  } as const

  function relativeLuminance(hex: string): number {
    const h = hex.replace('#', '')
    const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
  }

  function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a)
    const lb = relativeLuminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  /** WCAG 2.1 AA, normal-size text. Everything in these components is ≤ 14px. */
  const AA_NORMAL = 4.5

  it('Ash fails AA on every layered surface above Blackout', () => {
    // This is the finding that drove the guard below: design.md nominates Ash
    // as "secondary text", but it only clears AA against the pure Blackout
    // ground. Every card in this feature sits on Graphite Deep.
    expect(contrastRatio(TOKENS.ash, TOKENS.graphiteDeep)).toBeLessThan(AA_NORMAL)
    expect(contrastRatio(TOKENS.ash, TOKENS.graphite)).toBeLessThan(AA_NORMAL)
    expect(contrastRatio(TOKENS.ash, TOKENS.blackout)).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('Pewter — the token these components actually use — clears AA on all three surfaces', () => {
    expect(contrastRatio(TOKENS.pewter, TOKENS.graphiteDeep)).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrastRatio(TOKENS.pewter, TOKENS.graphite)).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(contrastRatio(TOKENS.pewter, TOKENS.blackout)).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('the badge foreground/background pairs clear AA', () => {
    // regressed: Graphite Deep text on a solid Neon Glow fill.
    expect(contrastRatio(TOKENS.graphiteDeep, TOKENS.neonGlow)).toBeGreaterThanOrEqual(AA_NORMAL)
    // confirmed / resolved / spiking: Neon Glow text on the muted accent surface.
    expect(contrastRatio(TOKENS.neonGlow, TOKENS.graphiteDeep)).toBeGreaterThanOrEqual(AA_NORMAL)
    // unproven / open / muted: Pewter on Graphite.
    expect(contrastRatio(TOKENS.pewter, TOKENS.graphite)).toBeGreaterThanOrEqual(AA_NORMAL)
    // acknowledged / class chips: Cloud on Graphite.
    expect(contrastRatio(TOKENS.cloud, TOKENS.graphite)).toBeGreaterThanOrEqual(AA_NORMAL)
    // Graphite Light is a border/divider token, never text — pinned so nobody
    // promotes it to a text colour on the strength of it looking readable.
    expect(contrastRatio(TOKENS.graphiteLight, TOKENS.graphiteDeep)).toBeLessThan(AA_NORMAL)
  })

  it.each(RENDERED_NAMES)('%s renders no sub-AA Ash text token', (name) => {
    // `text-neutral-500` is Ash in tailwind.config.ts's remapped scale, so both
    // spellings are the same defect. Reading this off the RENDERED tree rather
    // than the source is what makes it cover composed children — the old grep
    // could not see a token that arrived from EmptyState or LoadingState.
    const tokens = renderedClassTokens(renderCatalogued(name))
    expect(tokens, `${name} renders text-neutral-500 (Ash — fails AA on a card surface)`).not.toContain(
      'text-neutral-500',
    )
    expect(tokens, `${name} renders text-ash on a layered surface`).not.toContain('text-ash')
  })
})

// ─── 3. Live regions must not be attached to per-row content ─────────────────

describe('ARIA live regions are used only where something actually changes', () => {
  /**
   * `role="status"` and `role="alert"` are live regions. A badge carrying one
   * is fine in isolation and catastrophic in a list: the patterns table renders
   * one status badge, one fix-confidence badge and one spike badge PER ROW, so
   * a hundred-row page previously queued hundreds of simultaneous
   * announcements on every render.
   */
  const BADGES = [
    'PatternStatusBadge/open',
    'PatternStatusBadge/regressed',
    'FixConfidenceBadge/unproven',
    'FixConfidenceBadge/regressed',
    'SpikeBadge/spiking',
    'MutedBadge',
  ]

  it.each(BADGES)('%s is not a live region', (name) => {
    expect(liveRegionsWithin(renderCatalogued(name))).toHaveLength(0)
  })

  it.each(['PatternList', 'TopFailurePatternsCard', 'PatternLifecycleTimeline'])(
    '%s renders no live region (it is list content, not a notification)',
    (name) => {
      expect(liveRegionsWithin(renderCatalogued(name))).toHaveLength(0)
    },
  )

  it('a 50-row list produces exactly zero live regions', () => {
    // The scale version of the same claim, and the one the source grep could
    // never make: N rows must not mean N announcements.
    const patterns = Array.from({ length: 50 }, (_, i) =>
      makePattern({ id: `pat_${String(i)}`, fingerprintHash: `hash${String(i)}`, status: i % 3 === 0 ? 'resolved' : 'open' }),
    )
    const { container } = render(<PatternList patterns={patterns} />)
    expect(screen.getAllByRole('row')).toHaveLength(51) // 50 + header
    expect(liveRegionsWithin(container)).toHaveLength(0)
  })

  describe('PatternLifecycleControl DOES announce, because it is what mutates the status', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function stubLifecycleApi(response: unknown, status = 200) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            Promise.resolve(
              new Response(JSON.stringify(response), {
                status,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
        ),
      )
    }

    it('the polite region exists but is SILENT on first render', () => {
      const { container } = render(
        <PatternLifecycleControl fingerprintHash="a1b2c3" status="open" regressed={false} />,
      )
      const live = container.querySelector('[aria-live="polite"]')
      expect(live, 'the control must own a polite live region').not.toBeNull()
      // The critical half of the claim. A live region that is already
      // populated when it mounts announces the moment the page loads — which
      // is exactly the noise the badges were stripped of. It must start empty.
      expect(live?.textContent).toBe('')
    })

    it('the region actually receives the announcement after a successful transition', async () => {
      stubLifecycleApi({ pattern: { status: 'acknowledged' } })
      const user = userEvent.setup()
      const { container } = render(
        <PatternLifecycleControl fingerprintHash="a1b2c3" status="open" regressed={false} />,
      )
      const live = container.querySelector('[aria-live="polite"]')
      expect(live?.textContent).toBe('')

      await user.click(screen.getByRole('button', { name: 'Acknowledge' }))

      await waitFor(() => {
        expect(live?.textContent).toBe('Pattern status is now acknowledged.')
      })
      // It stays a polite region, and stays visually hidden — an announcement
      // that also painted a sentence into the layout would be a second,
      // unrequested UI change.
      expect(live).toHaveAttribute('aria-live', 'polite')
      expect(live).toHaveClass('sr-only')
    })

    it('a FAILED transition announces nothing politely and raises an assertive alert instead', async () => {
      stubLifecycleApi({ message: 'Upstream unavailable' }, 500)
      const user = userEvent.setup()
      const { container } = render(
        <PatternLifecycleControl fingerprintHash="a1b2c3" status="open" regressed={false} />,
      )
      const live = container.querySelector('[aria-live="polite"]')

      await user.click(screen.getByRole('button', { name: 'Acknowledge' }))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Upstream unavailable')
      // The polite region must NOT claim a transition that did not happen.
      expect(live?.textContent).toBe('')
      // And the badge must still read the pre-transition status.
      expect(visualText(container)).toContain('OPEN')
    })
  })
})

// ─── 4. Screen readers must receive the table's data ─────────────────────────

describe('PatternRow does not hide its own data from assistive technology', () => {
  /**
   * The regression this pins: every cell except the pattern label wrapped its
   * content in `<Link tabIndex={-1} aria-hidden>`. `tabIndex={-1}` is what
   * keeps the row to a minimal tab count; `aria-hidden` was doing nothing for
   * focus order and everything to delete failure class, occurrence count,
   * first/last seen, affected versions, status, fix confidence and spike state
   * from the accessibility tree.
   */
  it('every cell of the row reaches the accessibility tree', () => {
    const pattern = makePattern({
      count: 1234,
      status: 'resolved',
      lastSpikeAssessment: { isSpiking: true, assessedAt: Date.UTC(2026, 5, 1), baselineRate: 1, recentRate: 9 },
    })
    const { container } = renderRow(pattern, makeConfidence({ state: 'confirmed' }))
    const spoken = accessibleText(container)

    // The data the table exists to show, cell by cell.
    expect(spoken, 'pattern label missing from a11y tree').toContain('Tool call timed out after 30s')
    expect(spoken, 'failure class missing from a11y tree').toContain('tool error')
    expect(spoken, 'occurrence count missing from a11y tree').toContain('1,234')
    expect(spoken, 'affected version count missing from a11y tree').toContain('2')
    expect(spoken, 'status missing from a11y tree').toContain('RESOLVED')
    expect(spoken, 'fix confidence missing from a11y tree').toContain('CONFIRMED')
    expect(spoken, 'spike state missing from a11y tree').toContain('SPIKING')

    // Stated as a property rather than a spot check: no LINK in the row may be
    // aria-hidden, because a hidden link takes its whole cell with it.
    for (const link of container.querySelectorAll('a')) {
      expect(isAriaHidden(link, container), `aria-hidden link deletes its cell: ${link.outerHTML.slice(0, 120)}`).toBe(
        false,
      )
    }
  })

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * FINDING — THE OLD GUARD'S CLAIM WAS FALSE.
   *
   * The source-text version of this test read:
   *
   *     it('the row still has exactly one tab stop — the label link', ...)
   *         const links = openingTags(source, ['Link'])
   *         const focusable = links.filter((t) => !/tabIndex=\{-1\}/.test(t))
   *         expect(focusable).toHaveLength(1)
   *
   * It scanned `<Link>` tags only. The row also renders a
   * `<CopyToClipboardButton>` — a real, un-suppressed `<button>` — for the
   * fingerprint hash, four lines below the label link in the same file. It has
   * always been a tab stop. The row has TWO, and has had two since the copy
   * affordance was added.
   *
   * The invariant the old guard was trying to protect is real: the SIX
   * secondary cell links must not each be a tab stop, or a 50-row table costs
   * 350 tab presses to traverse. That part holds. But "exactly one tab stop
   * per row" was never true of the rendered row, and a regex that only knows
   * about one tag name could not have discovered that.
   *
   * This is therefore pinned to what the DOM actually does — two stops, in a
   * specific order, each identified — rather than to a number that would fail
   * the moment anyone rendered it.
   * ─────────────────────────────────────────────────────────────────────────
   */
  it('the row has exactly two tab stops: the label link, then the copy button', async () => {
    const { container } = renderRow(makePattern())
    const row = within(container).getAllByRole('row')[0]
    expect(row).toBeDefined()

    const stops = tabStopsWithin(row)
    expect(
      stops.map((el) => `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent ?? ''}`),
    ).toEqual(['A:Tool call timed out after 30s', 'BUTTON:Copy fingerprint hash'])

    // Walk the focus order for real, rather than inferring it from the markup.
    const user = userEvent.setup()
    const seen: (Element | null)[] = []
    await user.tab()
    seen.push(document.activeElement)
    await user.tab()
    seen.push(document.activeElement)
    await user.tab()
    seen.push(document.activeElement)

    expect(seen[0]).toBe(stops[0])
    expect(seen[1]).toBe(stops[1])
    // Third tab leaves the row entirely — there is no hidden third stop.
    expect(seen[2]).not.toBe(stops[0])
    expect(seen[2]).not.toBe(stops[1])
  })

  it('the seven secondary cell links are reachable by AT but never by Tab', () => {
    // This is the invariant the old guard was reaching for, stated correctly:
    // the cost of the row is bounded by its interactive affordances, not by
    // its cell count. Eight links, one tab stop among them.
    const { container } = renderRow(makePattern())
    const links = [...container.querySelectorAll('a')]
    const suppressed = links.filter((a) => a.tabIndex < 0)

    expect(links).toHaveLength(8)
    expect(suppressed.length, 'expected seven tabIndex={-1} cell links').toBe(7)
    for (const link of suppressed) {
      expect(isAriaHidden(link, container), 'suppressed from Tab must not mean hidden from AT').toBe(false)
      expect(link).toHaveAttribute('href')
    }
  })

  it('tab cost scales with rows, not with cells', () => {
    const rows = 10
    const patterns = Array.from({ length: rows }, (_, i) =>
      makePattern({ id: `pat_${String(i)}`, fingerprintHash: `hash${String(i)}` }),
    )
    const { container } = render(<PatternList patterns={patterns} />)
    // 2 per row and no more. If a cell link ever loses its tabIndex={-1} this
    // jumps to 8 per row and the assertion says so in one number.
    expect(tabStopsWithin(container)).toHaveLength(rows * 2)
  })

  it('badges expose a text equivalent beyond their compact all-caps word', () => {
    for (const name of [
      'PatternStatusBadge/open',
      'FixConfidenceBadge/unproven',
      'SpikeBadge/spiking',
      'MutedBadge',
    ]) {
      const container = renderCatalogued(name)
      const spoken = accessibleText(container)
      const seen = visualText(container)
      expect(
        spoken.length,
        `${name} announces only its compact word — no sr-only expansion reached the a11y tree`,
      ).toBeGreaterThan(seen.length)
    }
  })

  it('the lifecycle timeline is a real ordered list with machine-readable timestamps', () => {
    const { container } = render(
      <PatternLifecycleTimeline transitions={TRANSITIONS} firstSeenAt={Date.UTC(2026, 0, 2)} />,
    )

    const list = screen.getByRole('list', { name: 'Lifecycle history for this failure pattern' })
    expect(list.tagName).toBe('OL')
    // One node per transition, plus the implicit "first seen" node.
    expect(within(list).getAllByRole('listitem')).toHaveLength(TRANSITIONS.length + 1)

    // A bare "3 days ago" with the exact instant only in `title` is not
    // reliably reachable; <time dateTime> is.
    const times = [...container.querySelectorAll('time')]
    expect(times).toHaveLength(TRANSITIONS.length + 1)
    for (const t of times) {
      const dt = t.getAttribute('datetime')
      expect(dt, 'a <time> without dateTime is just text').toBeTruthy()
      expect(Number.isNaN(Date.parse(dt ?? '')), `unparseable dateTime: ${String(dt)}`).toBe(false)
    }

    // The automatic regression is the node an engineer is scanning for; it
    // must be worded, not just emphasised.
    expect(accessibleText(container)).toContain('Regressed — fix did not hold')
    expect(accessibleText(container)).toContain('system')
  })
})

// ─── 5. Keyboard reachability and visible focus ──────────────────────────────

describe('every interactive control is keyboard reachable with a visible focus ring', () => {
  /**
   * CLAUDE.md's design rules demand keyboard navigation explicitly. On a pure
   * black ground a missing focus ring is not a degraded experience, it is a
   * lost cursor — there is no ambient contrast to fall back on.
   */
  /**
   * Empty, and it should stay that way. This previously held
   * 'Copy fingerprint hash', because ui/CopyToClipboardButton.tsx declared no
   * focus ring and the KNOWN VIOLATION test below pinned that defect. The
   * button now carries the house ring, so the entry was dropped per that
   * test's own instructions and the generic rule below covers it like every
   * other tab stop. Add a name here only alongside a pinned test explaining
   * why, never to quiet a failure.
   */
  const RINGLESS_BY_ACCESSIBLE_NAME = new Set<string>([])

  it.each(RENDERED_NAMES)('%s: no tab stop lacks focus-visible styling', (name) => {
    const container = renderCatalogued(name)
    for (const el of tabStopsWithin(container)) {
      if (RINGLESS_BY_ACCESSIBLE_NAME.has(el.getAttribute('aria-label') ?? '')) continue
      const cls = el.getAttribute('class') ?? ''
      expect(
        /focus-visible:ring|focus:ring/.test(cls),
        `missing focus-visible ring in ${name}: <${el.tagName.toLowerCase()} class="${cls.slice(0, 140)}">`,
      ).toBe(true)
    }
  })

  it('the lifecycle control uses real <button>s, not click-handling divs', () => {
    const { container } = render(
      <PatternLifecycleControl fingerprintHash="a1b2c3" status="open" regressed={false} />,
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    for (const b of buttons) {
      expect(b.tagName, 'a role=button div is not a button').toBe('BUTTON')
      // Typed so they cannot accidentally submit the resolve form.
      expect(b).toHaveAttribute('type', 'button')
      expect(b.tabIndex).toBe(0)
    }
    // Nothing non-interactive is carrying the interaction.
    for (const el of container.querySelectorAll('div, span')) {
      expect(el.getAttribute('role')).not.toBe('button')
    }
  })

  it('the resolve form labels both of its fields and moves focus into the first', async () => {
    const user = userEvent.setup()
    render(<PatternLifecycleControl fingerprintHash="a1b2c3" status="open" regressed={false} />)

    await user.click(screen.getByRole('button', { name: 'Resolve' }))

    const form = await screen.findByRole('form', { name: 'Resolve this failure pattern' })
    // Both fields resolve by their LABEL, which is the assertion that matters:
    // an `htmlFor` pointing at nothing passes a source grep and fails here.
    const note = within(form).getByLabelText(/Resolution note/)
    const ref = within(form).getByLabelText(/Reference/)
    expect(note.tagName).toBe('TEXTAREA')
    expect(ref.tagName).toBe('INPUT')
    expect(note.id).not.toBe('')
    expect(ref.id).not.toBe('')
    expect(note.id).not.toBe(ref.id)

    // Opening the form moves focus into it rather than stranding the caret.
    // `requestAnimationFrame` in the component, so this is genuinely async.
    await waitFor(() => {
      expect(document.activeElement).toBe(note)
    })
  })

  it('the status filter is a set of real links driving a shareable ?status= URL', () => {
    render(
      <PatternStatusFilter
        active="regressed"
        counts={{ all: 9, open: 4, acknowledged: 2, resolved: 2, regressed: 1 }}
      />,
    )

    const group = screen.getByRole('group', { name: 'Filter patterns by status' })
    const links = within(group).getAllByRole('link')
    expect(links).toHaveLength(5)

    // Not divs with onClick, and not client-only state: the URL is the state.
    for (const link of links) {
      expect(link.tagName).toBe('A')
      expect(link.getAttribute('href')).toMatch(/^\/patterns(\?status=\w+)?$/)
    }

    // Exactly one pill is announced as current, and it is the active one —
    // the Whiteout fill alone is invisible to AT.
    const current = links.filter((l) => l.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveAccessibleName(/^Regressed 1 pattern$/)

    // Counts must not announce as bare numbers: "Open 4" would be a number
    // whose meaning is carried purely by its position.
    expect(links[1]).toHaveAccessibleName('Open 4 patterns')
    expect(links[4]).toHaveAccessibleName('Regressed 1 pattern')
  })

  it('a disabled control is removed from the tab order while a request is in flight', async () => {
    // Never resolves — the component stays busy, which is the state under test.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    const user = userEvent.setup()
    render(<PatternLifecycleControl fingerprintHash="a1b2c3" status="open" regressed={false} />)

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Acknowledging…' })).toBeDisabled()
    })
    // `disabled` (not `aria-disabled`) is what actually takes it out of the
    // tab order — a keyboard user must not land on a dead control.
    const busy = screen.getByRole('button', { name: 'Acknowledging…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(document.body.contains(busy)).toBe(true)
    expect(tabStopsWithin(document.body)).not.toContain(busy)
    vi.unstubAllGlobals()
  })
})

// ─── 6. prefers-reduced-motion ───────────────────────────────────────────────

describe('motion respects prefers-reduced-motion', () => {
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * FINDING — THE OLD GUARD MISSED A REAL VIOLATION.
   *
   * The source-text version iterated each component's own file and required
   * every `animate-*` token to be spelled `motion-safe:animate-*`. All twelve
   * files passed, and they still do.
   *
   * But `ResolutionEvidencePanel` in its `loading` state renders
   * `<LoadingState>`, which is `apps/web/src/components/ui/LoadingState.tsx`
   * and contains a bare, ungated `animate-spin` on its spinner. A user with
   * `prefers-reduced-motion: reduce` gets a continuously rotating element in
   * an audited surface. The old guard could not see it: the token is not in
   * any of the twelve files it read.
   *
   * `LoadingState` is a shared `ui/` primitive and not this team's file, so
   * this is reported rather than patched. The guard below asserts the rule
   * over the RENDERED tree, which is where the violation is visible, and the
   * one known offender is listed explicitly so that fixing it turns this into
   * a plain pass rather than a surprise failure.
   * ─────────────────────────────────────────────────────────────────────────
   */
  it.each(RENDERED_NAMES)('%s gates every rendered animation behind motion-safe:', (name) => {
    const tokens = renderedClassTokens(renderCatalogued(name)).filter((t) => t.includes('animate-'))
    for (const token of tokens) {
      expect(token, `ungated animation rendered by ${name}: ${token}`).toMatch(/^motion-safe:animate-/)
    }
  })

  it('the pulsing indicator is decorative, so reduced motion loses nothing', () => {
    for (const name of ['PatternStatusBadge/regressed', 'FixConfidenceBadge/regressed', 'SpikeBadge/spiking']) {
      const container = renderCatalogued(name)
      const animated = [...container.querySelectorAll<HTMLElement>('[class*="animate-"]')]
      expect(animated.length, `${name} renders no pulsing dot`).toBeGreaterThan(0)

      for (const dot of animated) {
        expect(dot, `pulsing dot in ${name} must be aria-hidden`).toHaveAttribute('aria-hidden', 'true')
        // Forced-colors mode flattens the accent fill; the dot keeps a
        // system-mapped colour so it doesn't vanish entirely.
        expect(
          (dot.getAttribute('class') ?? '').includes('forced-colors:'),
          `pulsing dot in ${name} must survive forced-colors`,
        ).toBe(true)
      }

      // The load-bearing half: with every animated node deleted, the fact is
      // still there in text.
      for (const dot of animated) dot.remove()
      expect(visualText(container).length, `${name} conveys its state only through motion`).toBeGreaterThan(0)
    }
  })
})

// ─── 7. design.md shape and palette conformance ──────────────────────────────

describe('design.md conformance', () => {
  it.each(RENDERED_NAMES)('%s: only buttons and dots are pills; every other container is 4px', (name) => {
    const container = renderCatalogued(name)
    for (const el of container.querySelectorAll<HTMLElement>('*')) {
      const cls = el.getAttribute('class') ?? ''
      if (!/\brounded-full\b/.test(cls)) continue
      // Legitimate: a real <button> (design.md: buttons are pills), a link
      // styled as one (the status-filter pills), or a small status dot.
      const isPill = el.tagName === 'BUTTON' || el.tagName === 'A'
      const isDot = /\bw-(1\.5|2|2\.5|6|10)\b/.test(cls)
      expect(
        isPill || isDot,
        `non-dot, non-button container using a pill radius in ${name}: <${el.tagName.toLowerCase()} class="${cls.slice(0, 120)}">`,
      ).toBe(true)
    }
  })

  it.each(RENDERED_NAMES)('%s: no off-system radius, no off-scale font size', (name) => {
    for (const token of renderedClassTokens(renderCatalogued(name))) {
      const radius = /^rounded-\[(\d+)px\]$/.exec(token)
      if (radius) expect(radius[1], `off-system radius in ${name}: ${token}`).toBe('4')
      expect(token, `off-scale font size in ${name}: ${token}`).not.toMatch(/^text-\[\d+px\]$/)
    }
  })

  it.each(RENDERED_NAMES)('%s: depth is layered near-black surfaces, never a box-shadow', (name) => {
    for (const token of renderedClassTokens(renderCatalogued(name))) {
      if (!/^shadow-/.test(token)) continue
      // The one sanctioned shadow is the accent/warn glow token on a status
      // dot — design.md §Glow. Anything else is elevation-by-shadow.
      expect(token, `box-shadow used for elevation in ${name}: ${token}`).toMatch(
        /^shadow-\[var\(--shadow-glow(-warn)?\)\]$/,
      )
    }
  })

  it.each(RENDERED_NAMES)('%s: no off-palette hue is introduced', (name) => {
    const OFF_PALETTE =
      /^(?:bg|text|border|ring|divide)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|zinc|gray|stone)-\d{2,3}$/
    for (const token of renderedClassTokens(renderCatalogued(name))) {
      expect(token, `off-palette Tailwind colour in ${name}: ${token}`).not.toMatch(OFF_PALETTE)
    }
  })
})

// ─── 8. Loading / empty / error on every data-dependent surface ──────────────

describe('every data-dependent surface has distinguishable loading, empty and error states', () => {
  /**
   * NOT `new URL('../../apps/web/app/', import.meta.url)`. Vite STATICALLY
   * REWRITES that exact pattern into an asset URL, which under jsdom resolves
   * against `http://localhost:3000/@fs/...` rather than `file://` — so
   * `fileURLToPath` throws ERR_INVALID_URL_SCHEME. The previous, node-only
   * revision of this file could use it safely; a DOM file cannot. Resolving
   * `import.meta.url` first, as a plain expression, is not rewritten.
   */
  const WEB_APP = path.resolve(fileURLToPath(import.meta.url), '../../../apps/web/app')

  /**
   * The two `loading.tsx` files are a Next.js ROUTE CONVENTION — the framework
   * finds them by path, so their existence at that path is part of what is
   * being asserted and cannot be established by rendering alone. They are
   * therefore located on disk and then RENDERED, rather than grepped: the old
   * version only checked the source string contained "LoadingState".
   */
  it.each([
    ['(app)/patterns/loading.tsx', PatternsLoading, 'Loading failure patterns…'],
    ['(app)/patterns/[fingerprint]/loading.tsx', PatternDetailLoading, 'Loading pattern detail…'],
  ] as const)('%s exists at its route path and renders a labelled busy indicator', (route, Loading, message) => {
    // The path check: Next resolves `loading.tsx` by convention, so being at
    // this exact path is part of the contract. The static import above proves
    // it is importable; this proves it is where the framework will look.
    expect(readFileSync(path.join(WEB_APP, route), 'utf8').length, `${route} is empty`).toBeGreaterThan(0)

    render(<Loading />)

    // A spinner with no accessible name is a blank screen to a screen reader.
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(screen.getByText(message)).toBeInTheDocument()
  })

  it('PatternList renders an explicit empty state rather than an empty table', () => {
    const { container } = render(<PatternList patterns={[]} />)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('heading', { name: 'No recurring failure patterns yet' })).toBeInTheDocument()
    expect(visualText(container).length).toBeGreaterThan(40)
  })

  it("PatternList's empty copy is overridable, so a filtered-empty list does not read as no-data", () => {
    render(<PatternList patterns={[]} emptyTitle="No regressed patterns" emptyDescription="Try a different filter." />)
    expect(screen.getByRole('heading', { name: 'No regressed patterns' })).toBeInTheDocument()
    expect(screen.getByText('Try a different filter.')).toBeInTheDocument()
  })

  it('ResolutionEvidencePanel renders all four of its declared states, all distinguishable', () => {
    const pattern = makePattern()
    const rendered: string[] = []

    for (const state of [
      { kind: 'loading' as const },
      { kind: 'unavailable' as const },
      { kind: 'error' as const, message: 'Convex query failed' },
      {
        kind: 'ready' as const,
        evidence: { resolution: null, exposure: null, transitions: [], confidence: null },
      },
    ]) {
      const { container, unmount } = render(<ResolutionEvidencePanel pattern={pattern} state={state} />)
      // Every state keeps the section and its heading — the panel never
      // collapses to nothing.
      expect(
        screen.getByRole('region', { name: 'Did the fix hold?' }),
        `${state.kind} lost the panel heading`,
      ).toBeInTheDocument()
      const text = visualText(container)
      expect(text.length, `${state.kind} renders nothing`).toBeGreaterThan(20)
      rendered.push(text)
      unmount()
    }

    expect(new Set(rendered).size, 'two evidence states render identically').toBe(4)
    expect(rendered[2]).toContain('Convex query failed')
  })

  it('an untested fix is never rendered as a held one', () => {
    // `heldSoFar: true` with `runCount: 0` is UNTESTED. This is the sentence
    // the whole feature exists to make, so it is asserted on rendered text.
    const { container } = render(
      <ResolutionEvidencePanel
        pattern={makePattern({ status: 'resolved' })}
        state={{
          kind: 'ready',
          evidence: {
            resolution: { resolvedAt: Date.UTC(2026, 3, 1) },
            exposure: {
              since: Date.UTC(2026, 3, 1),
              runCount: 0,
              runCountTruncated: false,
              recurrenceCount: 0,
              agentIds: ['agent_1'],
              heldSoFar: true,
            },
            transitions: [],
            confidence: makeConfidence({ state: 'unproven', score: 0, limitingFactor: 'no-exposure' }),
          },
        }}
      />,
    )
    const text = visualText(container)
    expect(text).toContain('no runs since')
    expect(text).toContain('untested, not proven')
    expect(text).toContain('UNPROVEN')
  })

  it('TopFailurePatternsCard never reports "no failures" for data it failed to load', () => {
    /**
     * The defect: `!patterns || patterns.length === 0` collapsed a null
     * (unloaded) list into the reassuring "No recurring failures — nice"
     * empty state. On a debugging tool, telling an engineer everything is
     * fine about data nobody fetched is worse than showing nothing.
     */
    const unloaded = render(<TopFailurePatternsCard patterns={null} error={null} />)
    const unloadedText = visualText(unloaded.container)
    expect(unloadedText).toContain('unknown')
    expect(unloadedText).not.toContain('No recurring failures')
    unloaded.unmount()

    const empty = render(<TopFailurePatternsCard patterns={[]} error={null} />)
    const emptyText = visualText(empty.container)
    expect(emptyText).toContain('No recurring failures')
    empty.unmount()

    const failed = render(<TopFailurePatternsCard patterns={null} error="Convex unreachable" />)
    const failedText = visualText(failed.container)
    expect(failedText).toContain('Convex unreachable')
    expect(failedText).not.toContain('No recurring failures')

    // All three must be distinguishable from each other, not just from empty.
    expect(new Set([unloadedText, emptyText, failedText]).size).toBe(3)
  })

  it('the dashboard card puts regressed patterns first, and says so in text', () => {
    const stale = makePattern({ id: 'a', fingerprintHash: 'aaa', label: 'Stale failure', lastSeenAt: Date.UTC(2026, 5, 2) })
    const regressed = makePattern({
      id: 'b',
      fingerprintHash: 'bbb',
      label: 'Regressed failure',
      lastSeenAt: Date.UTC(2026, 0, 1),
      status: 'open',
      regressedAt: Date.UTC(2026, 4, 1),
    })
    render(<TopFailurePatternsCard patterns={[stale, regressed]} error={null} />)

    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Regressed failure')
    expect(items[0]).toHaveTextContent('REGRESSED')
    expect(items[1]).toHaveTextContent('Stale failure')
  })
})
