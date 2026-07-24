/**
 * Accessibility regression guards for the Failure-Pattern Resolution UI
 * (Team E, ADR-006 cycles 1–2): PatternStatusBadge, PatternStatusFilter,
 * PatternLifecycleControl, PatternLifecycleTimeline, FixConfidenceBadge,
 * FixConfidenceMeter, ResolutionEvidencePanel, SpikeBadge, MutedBadge,
 * PatternRow/PatternList, and the dashboard's TopFailurePatternsCard.
 *
 * WHY THESE ARE SOURCE-TEXT ASSERTIONS RATHER THAN RENDERED-DOM ASSERTIONS:
 * tests/vitest.config.ts runs `environment: 'node'` with no jsdom and no
 * @testing-library/react in the workspace. Adding a DOM harness is a change
 * to root test config, which is Team A's boundary — so these follow the
 * precedent already set by tests/unit/fix_confidence_vocab.test.ts and assert
 * against what the components ACTUALLY DECLARE.
 *
 * That constraint is less of a compromise than it sounds for this particular
 * job. Every defect these guards exist to catch is a property of the source:
 * a `role="status"` typed onto a badge that renders once per table row, an
 * `aria-hidden` that swallows a whole column, a `text-neutral-500` on a card
 * surface, an `animate-*` without its `motion-safe:` gate. Each is a single
 * token in a className or a props list, and each was introduced by someone
 * writing exactly that token in exactly these files.
 *
 * WHAT THIS FILE DOES NOT COVER: anything that only exists once the browser
 * has computed it — real focus order, actual rendered contrast after
 * compositing, whether a live region truly announces. Those need the DOM
 * harness above. Treat these as a fence around known regressions, not as
 * proof of accessibility.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const WEB_SRC = new URL('../../apps/web/src/', import.meta.url)
const WEB_APP = new URL('../../apps/web/app/', import.meta.url)

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, WEB_SRC)), 'utf8')
}

/** Component files audited by this suite, by short name. */
const PATTERN_COMPONENTS = [
  'FixConfidenceBadge',
  'FixConfidenceMeter',
  'MutedBadge',
  'PatternDetail',
  'PatternLifecycleControl',
  'PatternLifecycleTimeline',
  'PatternList',
  'PatternRow',
  'PatternStatusBadge',
  'PatternStatusFilter',
  'ResolutionEvidencePanel',
  'SpikeBadge',
] as const

const RAW_SOURCES: Record<string, string> = {
  ...Object.fromEntries(PATTERN_COMPONENTS.map((n) => [n, read(`components/patterns/${n}.tsx`)])),
  TopFailurePatternsCard: read('components/dashboard/TopFailurePatternsCard.tsx'),
}

/**
 * Strips `//`, block, and `{/* … *\/}` comments, quote-aware so a `https://`
 * inside a string literal is not mistaken for a line comment.
 *
 * This matters more than it looks. These components are heavily commented,
 * and several comments QUOTE the very anti-patterns being guarded against
 * ("`role=\"status\"` here made every list render fire one announcement per
 * row"). Scanning raw text would make a correct fix fail its own test, and —
 * worse — would let a real `role="status"` hide behind a comment that
 * mentions one. Every structural assertion below runs against code only.
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const c = source[i] ?? ''
    const next = source[i + 1] ?? ''
    if (quote) {
      out += c
      if (c === '\\') {
        out += next
        i += 2
        continue
      }
      if (c === quote) quote = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i += 1
      continue
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** Comment-free source — what every structural assertion below reads. */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW_SOURCES).map(([k, v]) => [k, stripComments(v)]),
)

// ─── WCAG contrast, computed from design.md's actual token values ────────────

/**
 * Every colour below is transcribed from design.md's token table, NOT from
 * tailwind.config.ts. The point is to catch a token whose real value fails
 * contrast, not to check that Tailwind copied a hex correctly — so the
 * assertions have to be anchored to the design document itself.
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

// ─── Small JSX scanner ───────────────────────────────────────────────────────

/**
 * Returns the text of every opening tag whose name matches `tagNames`,
 * brace- and quote-aware so a `className={cn(..., '>')}` inside the tag does
 * not end it early. Deliberately dumb: it never parses JSX properly, it just
 * needs to reach the `>` that closes the opening tag.
 */
function openingTags(source: string, tagNames: string[]): string[] {
  const out: string[] = []
  for (const name of tagNames) {
    const pattern = new RegExp(`<${name}(?=[\\s/>])`, 'g')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      let i = match.index + match[0].length
      let depth = 0
      let quote: string | null = null
      for (; i < source.length; i += 1) {
        const c = source[i]
        if (quote) {
          if (c === quote) quote = null
          continue
        }
        if (c === '"' || c === "'" || c === '`') {
          quote = c
          continue
        }
        if (c === '{') depth += 1
        else if (c === '}') depth -= 1
        else if (c === '>' && depth === 0) break
      }
      out.push(source.slice(match.index, i + 1))
    }
  }
  return out
}

// ─── 1. Information must never be carried by colour alone ────────────────────

describe('the regressed / confirmed / unproven distinction survives greyscale', () => {
  /**
   * This product has ONE accent (Neon Glow) on near-black greyscale, which
   * makes "just make the urgent one green" the path of least resistance and
   * leaves anyone on a monochrome display, with a colour-vision deficiency,
   * or in forced-colors mode with four states that render identically.
   *
   * The defence is that each state's WORD differs. These tests pin the words.
   */
  function literalsOf(source: string, recordName: string): string[] {
    const start = source.indexOf(`const ${recordName}`)
    expect(start, `${recordName} should exist`).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    return [...body.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1] ?? '')
  }

  it('FixConfidenceBadge gives all four states a distinct, non-empty visible word', () => {
    const labels = literalsOf(SOURCES['FixConfidenceBadge'] ?? '', 'STATE_LABEL')
    expect(labels).toHaveLength(4)
    expect(new Set(labels).size).toBe(4)
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0)
    // Specifically: `regressed` must not be a styled variant of another word.
    expect(labels).toContain('REGRESSED')
    expect(labels).toContain('UNPROVEN')
    expect(labels).toContain('CONFIRMED')
  })

  it('PatternStatusBadge gives every lifecycle status a distinct visible word', () => {
    const labels = literalsOf(SOURCES['PatternStatusBadge'] ?? '', 'STATUS_LABEL')
    expect(labels).toHaveLength(3)
    expect(new Set(labels).size).toBe(3)
    // …and the regressed treatment renders its own literal word rather than
    // reusing "Open" with a different fill.
    expect(SOURCES['PatternStatusBadge']).toContain('REGRESSED')
  })

  it('the regressed badge does not rely on its pulsing dot to say "regressed"', () => {
    // The dot is aria-hidden and motion-safe-gated, so with reduced motion on
    // and a screen reader running it conveys nothing at all. The word must be
    // adjacent to it in the same element.
    const source = SOURCES['PatternStatusBadge'] ?? ''
    const dotIndex = source.indexOf('animate-neon-pulse')
    const wordIndex = source.indexOf('REGRESSED')
    expect(dotIndex).toBeGreaterThan(-1)
    expect(wordIndex).toBeGreaterThan(dotIndex)
  })

  it("FixConfidenceMeter states each credit bar's value in text, not only as a bar width", () => {
    const source = SOURCES['FixConfidenceMeter'] ?? ''
    // The bar itself is (correctly) aria-hidden — which means the fraction it
    // encodes has to appear in the text beside it.
    expect(source).toMatch(/aria-hidden="true"/)
    expect(source).toContain('{pct}%')
    // And "earned" must not be conveyed only by the fill colour.
    expect(source).toMatch(/earned \? 'earned' : 'not yet earned'|'earned' : 'not yet earned'/)
  })

  it('the recurrence fact is worded, not only coloured', () => {
    const source = SOURCES['FixConfidenceMeter'] ?? ''
    expect(source).toContain("'failed again'")
    expect(source).toContain("'none since fix'")
  })
})

// ─── 2. Contrast against the real token values ───────────────────────────────

describe('text contrast against design.md token values', () => {
  it('Ash fails AA on every layered surface above Blackout', () => {
    // This is the finding that drove the fix below: design.md nominates Ash as
    // "secondary text", but it only clears AA against the pure Blackout ground.
    // Every card in this feature sits on Graphite Deep.
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
  })

  it('no pattern or dashboard component uses the sub-AA Ash token for text', () => {
    // `text-neutral-500` is Ash in tailwind.config.ts's remapped scale, so both
    // spellings are the same defect.
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(source, `${name} must not use text-neutral-500 (Ash, ${contrastRatio(TOKENS.ash, TOKENS.graphiteDeep).toFixed(2)}:1 on a card)`).not.toMatch(
        /\btext-neutral-500\b/,
      )
      expect(source, `${name} must not use text-ash on a layered surface`).not.toMatch(/\btext-ash\b/)
    }
  })
})

// ─── 3. Live regions must not be attached to per-row content ─────────────────

describe('ARIA live regions are used only where something actually changes', () => {
  /**
   * `role="status"` and `role="alert"` are live regions. A badge carrying one
   * is fine in isolation and catastrophic in a list: the patterns table renders
   * one status badge, one fix-confidence badge and one spike badge PER ROW, so
   * a hundred-row page previously queued hundreds of simultaneous
   * announcements on every render — which in practice means a screen reader
   * user hears noise and misses the one thing that did change.
   */
  const BADGES = ['PatternStatusBadge', 'FixConfidenceBadge', 'SpikeBadge', 'MutedBadge']

  it.each(BADGES)('%s is not a live region', (name) => {
    const source = SOURCES[name] ?? ''
    expect(source).not.toMatch(/role="(status|alert|log)"/)
    expect(source).not.toMatch(/aria-live=/)
  })

  it.each(['PatternRow', 'PatternList', 'TopFailurePatternsCard', 'PatternLifecycleTimeline'])(
    '%s renders no live region (it is list content, not a notification)',
    (name) => {
      const source = SOURCES[name] ?? ''
      expect(source).not.toMatch(/role="(status|alert|log)"/)
      expect(source).not.toMatch(/aria-live=/)
    },
  )

  it('PatternLifecycleControl DOES announce, because it is what mutates the status', () => {
    const source = SOURCES['PatternLifecycleControl'] ?? ''
    expect(source).toMatch(/aria-live="polite"/)
    // Errors get the assertive channel via role="alert".
    expect(source).toMatch(/role="alert"/)
    // The announcement must be driven by a successful transition, not by
    // first render — an empty initial value is what makes that true.
    expect(source).toMatch(/useState\(''\)/)
    expect(source).toContain('setAnnouncement(')
  })

  it("PatternDetail's regression banner is a single-instance alert, not a per-row one", () => {
    const source = SOURCES['PatternDetail'] ?? ''
    expect((source.match(/role="alert"/g) ?? []).length).toBe(1)
  })
})

// ─── 4. Screen readers must receive the table's data ─────────────────────────

describe('PatternRow does not hide its own data from assistive technology', () => {
  /**
   * The regression this pins: every cell except the pattern label wrapped its
   * content in `<Link tabIndex={-1} aria-hidden>`. `tabIndex={-1}` is what
   * keeps the row to one tab stop; `aria-hidden` was doing nothing for focus
   * order and everything to delete failure class, occurrence count, first/last
   * seen, affected versions, status, fix confidence and spike state from the
   * accessibility tree. The table's entire payload was invisible.
   */
  it('no element in PatternRow carries aria-hidden on a data-bearing link', () => {
    const source = SOURCES['PatternRow'] ?? ''
    for (const tag of openingTags(source, ['Link'])) {
      expect(tag, `aria-hidden on a PatternRow Link deletes that cell from the a11y tree: ${tag}`).not.toMatch(
        /aria-hidden/,
      )
    }
  })

  it('the row still has exactly one tab stop — the label link', () => {
    const source = SOURCES['PatternRow'] ?? ''
    const links = openingTags(source, ['Link'])
    const focusable = links.filter((t) => !/tabIndex=\{-1\}/.test(t))
    expect(focusable).toHaveLength(1)
    expect(focusable[0]).toMatch(/focus-visible:ring/)
  })

  it('badges expose a text equivalent beyond their compact all-caps word', () => {
    for (const name of ['PatternStatusBadge', 'FixConfidenceBadge', 'SpikeBadge', 'MutedBadge']) {
      expect(SOURCES[name], `${name} should carry sr-only expansion text`).toContain('sr-only')
    }
  })

  it('the lifecycle timeline is a real ordered list with machine-readable timestamps', () => {
    const source = SOURCES['PatternLifecycleTimeline'] ?? ''
    expect(source).toMatch(/<ol[\s>]/)
    expect(source).toMatch(/<li[\s>]/)
    // A bare "3 days ago" with the exact instant only in `title` is not
    // reliably reachable; <time dateTime> is.
    expect(source).toMatch(/<time[\s\n]/)
    expect(source).toMatch(/dateTime=/)
    expect(source).toMatch(/aria-label="Lifecycle history/)
  })

  it('the confidence meter is not a bare number', () => {
    const source = SOURCES['FixConfidenceMeter'] ?? ''
    // The ceiling must always be stated next to the score.
    expect(source).toContain('FIX_CONFIDENCE_MAX')
    // And the limiting factor must be worded.
    expect(source).toContain('LIMIT_COPY')
  })
})

// ─── 5. Keyboard reachability and visible focus ──────────────────────────────

describe('every interactive control is keyboard reachable with a visible focus ring', () => {
  /**
   * CLAUDE.md's design rules demand keyboard navigation explicitly. On a pure
   * black ground a missing focus ring is not a degraded experience, it is a
   * lost cursor — there is no ambient contrast to fall back on.
   */
  const INTERACTIVE = ['Link', 'a', 'button', 'input', 'textarea', 'select']

  it.each(Object.keys(SOURCES))('%s: no focusable element lacks focus-visible styling', (name) => {
    const source = SOURCES[name] ?? ''
    for (const tag of openingTags(source, INTERACTIVE)) {
      // Elements explicitly removed from the tab order don't need a ring —
      // they are never focused by keyboard.
      if (/tabIndex=\{-1\}/.test(tag)) continue
      // Elements rendered by a shared primitive (Button) inherit the ring from
      // that primitive, which is outside this feature's files.
      expect(tag, `missing focus-visible ring in ${name}: ${tag.slice(0, 160)}`).toMatch(
        /focus-visible:ring|focus:ring/,
      )
    }
  })

  it('the lifecycle control uses real <button>s, not click-handling divs', () => {
    const source = SOURCES['PatternLifecycleControl'] ?? ''
    // Every action goes through the Button primitive, which renders <button>.
    expect(source).toContain("from '@/components/ui/Button'")
    // No div/span is given an onClick, which would be unreachable by keyboard.
    for (const tag of openingTags(source, ['div', 'span'])) {
      expect(tag, `click handler on a non-interactive element: ${tag.slice(0, 120)}`).not.toMatch(/onClick=/)
    }
    // Buttons are typed so they don't accidentally submit the resolve form.
    expect((source.match(/type="button"/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('the status filter is a set of real links driving a shareable ?status= URL', () => {
    const source = SOURCES['PatternStatusFilter'] ?? ''
    // Not a div with onClick, and not client-only state: the URL is the state.
    expect(source).not.toContain("'use client'")
    expect(source).not.toMatch(/onClick=/)
    expect(source).toContain('/patterns?status=')
    // The active pill must be conveyed by more than its Whiteout fill.
    expect(source).toMatch(/aria-current=\{isActive \? 'page' : undefined\}/)
    expect(source).toMatch(/role="group"/)
    expect(source).toMatch(/aria-label="Filter patterns by status"/)
    // Counts must not announce as bare numbers.
    expect(source).toContain('sr-only')
  })

  it('the resolve form labels both of its fields', () => {
    const source = SOURCES['PatternLifecycleControl'] ?? ''
    const labels = source.match(/<label htmlFor=\{/g) ?? []
    expect(labels.length).toBe(2)
    expect(source).toMatch(/id=\{noteId\}/)
    expect(source).toMatch(/id=\{refId\}/)
    // Opening the form moves focus into it rather than stranding the caret.
    expect(source).toContain('noteFieldRef.current?.focus()')
  })
})

// ─── 6. prefers-reduced-motion ───────────────────────────────────────────────

describe('motion respects prefers-reduced-motion', () => {
  it.each(Object.keys(SOURCES))('%s gates every animation behind motion-safe:', (name) => {
    const source = SOURCES[name] ?? ''
    for (const match of source.matchAll(/(\S*)animate-[a-z-]+/g)) {
      expect(match[0], `ungated animation in ${name}: ${match[0]}`).toMatch(/motion-safe:animate-/)
    }
  })

  it('the pulsing regressed indicator is decorative, so reduced motion loses nothing', () => {
    // Each pulsing dot is aria-hidden and sits beside a word that carries the
    // same fact — so switching the animation off degrades gracefully.
    for (const name of ['PatternStatusBadge', 'FixConfidenceBadge', 'SpikeBadge', 'PatternDetail']) {
      const source = SOURCES[name] ?? ''
      for (const tag of openingTags(source, ['span'])) {
        if (!/motion-safe:animate-/.test(tag)) continue
        expect(tag, `pulsing dot in ${name} must be aria-hidden`).toMatch(/aria-hidden="true"/)
        // Forced-colors mode flattens the accent fill; the dot keeps a
        // system-mapped colour so it doesn't vanish entirely.
        expect(tag, `pulsing dot in ${name} must survive forced-colors`).toMatch(/forced-colors:/)
      }
    }
  })
})

// ─── 7. design.md shape and palette conformance ──────────────────────────────

describe('design.md conformance', () => {
  it('only buttons are pills; every other container is 4px', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      // rounded-full is the 9999px pill. It is legitimate on the status-filter
      // pills (links styled as buttons) and on the small status dots.
      for (const tag of openingTags(source, ['div', 'span', 'section', 'table', 'ol', 'ul', 'li', 'p'])) {
        if (!/rounded-full/.test(tag)) continue
        expect(tag, `non-dot container using a pill radius in ${name}: ${tag.slice(0, 120)}`).toMatch(
          /\bw-(1\.5|2|2\.5)\b/,
        )
      }
      // No radius may be declared other than 4px or the pill.
      for (const match of source.matchAll(/rounded-\[(\d+)px\]/g)) {
        expect(match[1], `off-system radius in ${name}`).toBe('4')
      }
    }
  })

  it('depth is layered near-black surfaces, never a box-shadow', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      for (const match of source.matchAll(/shadow-\[[^\]]+\]|\bshadow-(lg|md|sm|xl|2xl)\b/g)) {
        // The one sanctioned shadow is the accent/warn glow token on a status
        // dot — design.md §Glow. Anything else is elevation-by-shadow.
        expect(match[0], `box-shadow used for elevation in ${name}: ${match[0]}`).toMatch(
          /shadow-\[var\(--shadow-glow(-warn)?\)\]/,
        )
      }
    }
  })

  it('type sizes stay on the scale (no arbitrary px font sizes)', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      const arbitrary = source.match(/\btext-\[\d+px\]/g) ?? []
      expect(arbitrary, `off-scale font size in ${name}`).toEqual([])
    }
  })

  it('no off-palette hue is introduced (only greyscale, Neon Glow, and System Warning)', () => {
    const OFF_PALETTE = /\b(?:bg|text|border|ring|divide)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|zinc|gray|stone)-\d{2,3}\b/
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(source, `off-palette Tailwind colour in ${name}`).not.toMatch(OFF_PALETTE)
    }
  })
})

// ─── 8. Loading / empty / error on every data-dependent surface ──────────────

describe('every data-dependent surface has distinguishable loading, empty and error states', () => {
  it('both patterns routes ship a loading.tsx', () => {
    for (const route of ['(app)/patterns/loading.tsx', '(app)/patterns/[fingerprint]/loading.tsx']) {
      const source = readFileSync(fileURLToPath(new URL(route, WEB_APP)), 'utf8')
      expect(source, `${route} must render something while loading`).toContain('LoadingState')
    }
  })

  it('the patterns list page renders an explicit error state and never a blank screen', () => {
    const source = readFileSync(fileURLToPath(new URL('(app)/patterns/page.tsx', WEB_APP)), 'utf8')
    expect(source).toContain('ErrorState')
    // The empty state lives in PatternList, and the page overrides its copy
    // when a filter (rather than the absence of data) is the cause.
    expect(source).toContain('emptyTitle')
  })

  it('PatternList always renders an empty state rather than an empty table', () => {
    const source = SOURCES['PatternList'] ?? ''
    expect(source).toContain('patterns.length === 0')
    expect(source).toContain('EmptyState')
  })

  it('ResolutionEvidencePanel handles all four of its declared states', () => {
    const source = SOURCES['ResolutionEvidencePanel'] ?? ''
    for (const kind of ['loading', 'error', 'unavailable', 'ready']) {
      expect(source, `missing '${kind}' branch`).toContain(`'${kind}'`)
    }
    expect(source).toContain('LoadingState')
    expect(source).toContain('ErrorState')
  })

  it('TopFailurePatternsCard never reports "no failures" for data it failed to load', () => {
    /**
     * The defect: `!patterns || patterns.length === 0` collapsed a null
     * (unloaded) list into the reassuring "No recurring failures — nice"
     * empty state. On a debugging tool, telling an engineer everything is
     * fine about data nobody fetched is worse than showing nothing.
     */
    const source = SOURCES['TopFailurePatternsCard'] ?? ''
    expect(source).not.toMatch(/!patterns \|\| patterns\.length === 0/)
    expect(source).toContain('patterns === null')
    expect(source).toContain('patterns.length === 0')
    // The null branch must not reuse the calm empty-state copy.
    const nullBranch = source.slice(source.indexOf('patterns === null'), source.indexOf('patterns.length === 0'))
    expect(nullBranch).toContain('ErrorState')
    expect(nullBranch).not.toContain('EmptyState')
  })
})
