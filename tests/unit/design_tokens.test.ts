/**
 * Guard-the-guard tests for scripts/check-design-tokens.ts.
 *
 * A checker that has never been observed catching anything is not a guard, so
 * every failure class it claims to detect is planted here against a synthetic
 * fixture and asserted to be reported. The fixtures carry their own design.md,
 * their own tailwind.config.ts and their own web tree, which is the point: the
 * checker must derive everything it sanctions from those files, so a fixture
 * that says something different from the real design.md must change the
 * verdict. If these tests passed against a hard-coded palette, the checker
 * would have a second source of truth and the whole exercise would be void.
 *
 * The final block runs the checker against the REAL repository and asserts that
 * design.md, tailwind.config.ts and the published WCAG matrix remain mutually
 * consistent. That is the standing regression test: apps/web has known token
 * debt that is being remediated, but the DOCUMENT must never contradict itself
 * or the config, because everything downstream is derived from it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  analyze,
  bannableStops,
  contrastRatio,
  evaluateRatchet,
  FALSE_POSITIVE_NOTICE,
  GROUND_RESOLUTION_NOTICE,
  loadBaseline,
  parseDesignSystem,
  parseTailwindConfig,
  relativeLuminance,
  tierOf,
  verdict,
  type Baseline,
  type TailwindMap,
  type Violation,
  type ViolationCode,
  type Waiver,
} from '../../scripts/check-design-tokens.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

// ─── Fixture construction ────────────────────────────────────────────────────

/**
 * A miniature design.md with the same structure as the real one. Values are the
 * real Neon token values so the contrast numbers below are checkable by hand.
 */
interface DocOverrides {
  readonly tokenRows?: string
  readonly matrixRows?: string
  readonly ramps?: string
  readonly aliases?: string
  readonly interSizes?: string
  readonly monoSizes?: string
  readonly radii?: string
}

const DEFAULT_TOKEN_ROWS = [
  '| Whiteout | `#ffffff` | `--color-whiteout` | Blackout, Depth, Graphite Deep, Graphite | none | Primary text, primary CTA button backgrounds. |',
  '| Cloud | `#c9cbcf` | `--color-cloud` | Blackout, Depth, Graphite Deep, Graphite | none | Hover states on dark elements. |',
  '| Pewter | `#94979e` | `--color-pewter` | Blackout, Depth, Graphite Deep, Graphite | none | The default secondary text color on elevated surfaces. |',
  '| Ash | `#797d86` | `--color-ash` | Blackout, Depth | Graphite Deep, Graphite | Secondary text on the page ground only. |',
  '| Neon Glow | `#34d59a` | `--color-neon-glow` | Blackout, Depth, Graphite Deep, Graphite | none | Key brand accent; barred from body copy by the Don\'ts. |',
  '| Scanline Fade | `linear-gradient(90deg, rgba(57, 165, 125, 0.6) 50%, rgba(0, 0, 0, 0) 50%)` | `--color-scanline-fade` | none | all | Decorative effect only. |',
  '| Graphite | `#242628` | `--color-graphite` | none | all | Surface, not text. Secondary surfaces. |',
  '| Graphite Deep | `#151617` | `--color-graphite-deep` | Whiteout | Blackout, Depth, Graphite | Primarily a surface — card backgrounds. |',
  '| Depth | `#0a0a0b` | `--color-depth` | none | all | Surface, not text. |',
  '| Blackout | `#000000` | `--color-blackout` | Whiteout | Depth, Graphite Deep, Graphite | Primarily the absolute page background. |',
].join('\n')

/** Rows are foreground tokens; the numbers are the true computed ratios. */
const DEFAULT_MATRIX_ROWS = [
  '| Whiteout `#ffffff` | 21.00 AAA | 19.79 AAA | 18.12 AAA | 15.19 AAA |',
  '| Cloud `#c9cbcf` | 12.93 AAA | 12.18 AAA | 11.15 AAA | 9.35 AAA |',
  '| Pewter `#94979e` | 7.18 AAA | 6.77 AA | 6.19 AA | 5.19 AA |',
  '| Ash `#797d86` | 5.09 AA | 4.80 AA | 4.39 AA-large | 3.68 AA-large |',
  '| Neon Glow `#34d59a` | 11.13 AAA | 10.49 AAA | 9.60 AAA | 8.05 AAA |',
  '| Scanline Fade `#39a57d` | 6.85 AA | 6.46 AA | 5.91 AA | 4.95 AA |',
].join('\n')

const DEFAULT_RAMPS = [
  '| `neutral-300` | `#a6a9af` | interpolated |',
  '| `primary-900` | `#123b2f` | Neon Glow shade — never text |',
].join('\n')

const DEFAULT_ALIASES = [
  '| `text-neutral-400` / `text-pewter` | Pewter `#94979e` | Pewter row |',
  '| `text-neutral-500` / `text-ash` | Ash `#797d86` | **Ash row** |',
].join('\n')

function designDoc(o: DocOverrides = {}): string {
  return `# Neon — Style Reference

## Tokens — Colors

| Name | Value | Token | Text On | Never Text On | Role |
|------|-------|-------|---------|---------------|------|
${o.tokenRows ?? DEFAULT_TOKEN_ROWS}

## Contrast — WCAG Matrix

### Matrix

| Foreground | Blackout \`#000000\` | Depth \`#0a0a0b\` | Graphite Deep \`#151617\` | Graphite \`#242628\` |
|------------|--------------------|-----------------|-------------------------|--------------------|
${o.matrixRows ?? DEFAULT_MATRIX_ROWS}

### Derived Tailwind ramps — NOT canonical palette tokens

| Tailwind stop | Value | Note |
|---------------|-------|------|
${o.ramps ?? DEFAULT_RAMPS}

### Tailwind alias trap

| Tailwind class | Token | Same rules as |
|----------------|-------|---------------|
${o.aliases ?? DEFAULT_ALIASES}

## Tokens — Typography

### Inter — Headlines and primary copy. · \`--font-inter\`
- **Sizes:** ${o.interSizes ?? '10px, 12px, 14px, 16px, 24px, 32px'}

### Geist Mono — Code snippets and data displays. · \`--font-geistmono\`
- **Sizes:** ${o.monoSizes ?? '12px, 14px, 16px'}

### Type Scale

| Role | Size | Line Height | Letter Spacing | Token |
|------|------|-------------|----------------|-------|
| body | 16px | 1.5 | -0.43px | \`--text-body\` |

## Tokens — Spacing & Shapes

### Border Radius

| Element | Value |
|---------|-------|
${o.radii ?? '| cards | 4px |\n| buttons | 9999px |'}

### Shadows

| Name | Value | Token |
|------|-------|-------|
| lg | \`rgba(0, 0, 0, 0.4) 0px 8px 20px 0px\` | \`--shadow-lg\` |

### Glow

| Name | Value | Token |
|------|-------|-------|
| glow | \`0 0 8px rgba(52, 213, 154, 0.7)\` | \`--shadow-glow\` |

## Quick Start

\`\`\`css
:root {
  --shadow-glow: 0 0 8px rgba(52, 213, 154, 0.7);
  --shadow-lg: rgba(0, 0, 0, 0.4) 0px 8px 20px 0px;
}
\`\`\`
`
}

const DEFAULT_CONFIG = `import type { Config } from 'tailwindcss'
const config: Config = {
  theme: {
    extend: {
      colors: {
        whiteout: '#ffffff',
        cloud: '#c9cbcf',
        pewter: '#94979e',
        ash: '#797d86',
        neon: { glow: '#34d59a', scanline: '#39a57d' },
        graphite: { DEFAULT: '#242628', deep: '#151617' },
        depth: '#0a0a0b',
        blackout: '#000000',
        neutral: { 300: '#a6a9af', 400: '#94979e', 500: '#797d86', 850: '#151617', 950: '#000000' },
        primary: { 900: '#123b2f' },
      },
      borderRadius: { DEFAULT: '4px', md: '4px', full: '9999px' },
      boxShadow: { lg: 'rgba(0, 0, 0, 0.4) 0px 8px 20px 0px' },
    },
  },
}
export default config
`

const DEFAULT_GLOBALS = `body { background-color: #000000; }\n`

interface Fixture {
  readonly doc?: DocOverrides
  readonly config?: string
  /** relative path under the fake apps/web -> file body */
  readonly web?: Record<string, string>
  readonly globals?: string | null
  readonly waivers?: readonly Waiver[]
}

function run(fixture: Fixture): {
  codes: ViolationCode[]
  messages: string[]
  docCodes: ViolationCode[]
  docMessages: string[]
  unusedWaivers: readonly Waiver[]
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tokens-'))
  tmpDirs.push(root)
  const webRoot = path.join(root, 'web')
  fs.mkdirSync(webRoot, { recursive: true })

  const designMd = path.join(root, 'design.md')
  fs.writeFileSync(designMd, designDoc(fixture.doc))
  const tailwindConfig = path.join(webRoot, 'tailwind.config.ts')
  fs.writeFileSync(tailwindConfig, fixture.config ?? DEFAULT_CONFIG)
  if (fixture.globals !== null) {
    fs.writeFileSync(path.join(webRoot, 'globals.css'), fixture.globals ?? DEFAULT_GLOBALS)
  }
  for (const [name, body] of Object.entries(fixture.web ?? {})) {
    const p = path.join(webRoot, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }

  const result = analyze({
    designMd,
    tailwindConfig,
    webRoot,
    ...(fixture.waivers === undefined ? {} : { waivers: fixture.waivers }),
  })
  return {
    codes: result.violations.map((v) => v.code),
    messages: result.violations.map((v) => `${v.code} ${v.className} :: ${v.detail} :: ${v.fix}`),
    docCodes: result.docViolations.map((v) => v.code),
    docMessages: result.docViolations.map((v) => `${v.code} ${v.className} :: ${v.detail}`),
    unusedWaivers: result.unusedWaivers,
  }
}

/** Like `run`, but hands back the full Violation objects. */
function runFull(fixture: Fixture): { violations: readonly Violation[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tokens-full-'))
  tmpDirs.push(root)
  const webRoot = path.join(root, 'web')
  fs.mkdirSync(webRoot, { recursive: true })
  fs.writeFileSync(path.join(root, 'design.md'), designDoc(fixture.doc))
  fs.writeFileSync(path.join(webRoot, 'tailwind.config.ts'), fixture.config ?? DEFAULT_CONFIG)
  fs.writeFileSync(path.join(webRoot, 'globals.css'), fixture.globals ?? DEFAULT_GLOBALS)
  for (const [name, body] of Object.entries(fixture.web ?? {})) {
    const fp = path.join(webRoot, name)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, body)
  }
  return analyze({
    designMd: path.join(root, 'design.md'),
    tailwindConfig: path.join(webRoot, 'tailwind.config.ts'),
    webRoot,
    // Spread rather than `waivers: fixture.waivers` — under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent key, and the option is genuinely optional.
    ...(fixture.waivers === undefined ? {} : { waivers: fixture.waivers }),
  })
}

/** A component whose text sits on whatever `wrapper` paints. */
const component = (className: string, wrapper = ''): string =>
  `export function C() {\n  return (\n    <div className="${wrapper}">\n      <span className="${className}">x</span>\n    </div>\n  )\n}\n`

// ─── 0. The colour maths itself ──────────────────────────────────────────────

describe('WCAG arithmetic', () => {
  it('reproduces the ratios design.md publishes for the load-bearing pairs', () => {
    // These four numbers are the reason this check exists; if the formula here
    // were wrong, every verdict below would be confidently wrong too.
    expect(contrastRatio('#797d86', '#151617')).toBeCloseTo(4.39, 2) // Ash on Graphite Deep
    expect(contrastRatio('#797d86', '#242628')).toBeCloseTo(3.68, 2) // Ash on Graphite
    expect(contrastRatio('#797d86', '#000000')).toBeCloseTo(5.09, 2) // Ash on Blackout — passes
    expect(contrastRatio('#94979e', '#151617')).toBeCloseTo(6.19, 2) // Pewter on Graphite Deep
  })

  it('is symmetric and bounded, and white-on-black is 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#34d59a', '#151617')).toBeCloseTo(contrastRatio('#151617', '#34d59a'), 10)
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10)
  })
})

// ─── 1. design.md is genuinely the source of truth ───────────────────────────

describe('everything sanctioned is parsed from design.md, never hard-coded', () => {
  it('parses the token table, matrix, ramps and alias table out of a synthetic doc', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-parse-'))
    tmpDirs.push(root)
    const p = path.join(root, 'design.md')
    fs.writeFileSync(p, designDoc())
    const d = parseDesignSystem(p)

    expect(d.colors.map((c) => c.name)).toContain('Ash')
    expect(d.byHex.get('#797d86')?.name).toBe('Ash')
    // The `Text On` / `Never Text On` columns are read as data, self-joined by Name.
    expect(d.byName.get('Ash')?.textOn).toEqual(['Blackout', 'Depth'])
    expect(d.byName.get('Ash')?.neverTextOn).toEqual(['Graphite Deep', 'Graphite'])
    // `all` expands to every sanctioned surface, `none` to the empty list.
    expect(d.byName.get('Graphite')?.neverTextOn).toEqual(d.surfaces)
    expect(d.byName.get('Whiteout')?.neverTextOn).toEqual([])
    expect(d.ramps.get('#a6a9af')?.stops).toBe('neutral-300')
    expect(d.aliases.some((a) => a.classes.includes('text-neutral-500'))).toBe(true)
    expect(d.radii).toContain('4px')
    expect(d.radii).toContain('9999px')
    expect([...d.shadowTokens.keys()].sort()).toEqual(['glow', 'lg'])
  })

  it('does not choke on the one token row whose Value is a gradient, and takes its flat hex from the matrix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-gradient-'))
    tmpDirs.push(root)
    const p = path.join(root, 'design.md')
    fs.writeFileSync(p, designDoc())
    const d = parseDesignSystem(p)
    const scanline = d.byName.get('Scanline Fade')
    expect(scanline).toBeDefined()
    // Not silently coerced to a bogus colour, and not dropped either.
    expect(scanline?.hex).toBe('#39a57d')
  })

  it('a different palette in the fixture produces a different verdict — proving nothing is hard-coded', () => {
    // Same class, same code: sanctioned when the doc lists the hex, off-palette
    // when it does not. If the palette were baked into the script, both runs
    // would agree.
    const withToken = run({ web: { 'a.tsx': component('text-pewter') } })
    expect(withToken.codes).not.toContain('OFF_PALETTE')

    const tokenRows = DEFAULT_TOKEN_ROWS.split('\n').filter((r) => !r.startsWith('| Pewter ')).join('\n')
    const matrixRows = DEFAULT_MATRIX_ROWS.split('\n').filter((r) => !r.startsWith('| Pewter ')).join('\n')
    const withoutToken = run({
      doc: { tokenRows, matrixRows },
      web: { 'a.tsx': component('text-pewter') },
    })
    expect(withoutToken.codes).toContain('OFF_PALETTE')
  })

  it('fails loudly rather than silently sanctioning nothing when the doc structure changes', () => {
    // The dangerous failure is the quiet one: a parser that finds no tokens
    // would either flag the entire repo or, worse, find no violations and read
    // as a clean tree. Neither is acceptable; it must throw.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-broken-'))
    tmpDirs.push(root)
    const p = path.join(root, 'design.md')
    fs.writeFileSync(p, '# Neon\n\nno tables here at all\n')
    expect(() => parseDesignSystem(p)).toThrow(/structure changed|Matrix|token-table header/i)
  })
})

// ─── 2. design.md internal consistency ───────────────────────────────────────

describe("design.md's own numbers are recomputed, not believed", () => {
  it('catches a published matrix ratio that disagrees with the formula', () => {
    const matrixRows = DEFAULT_MATRIX_ROWS.replace('| Ash `#797d86` | 5.09 AA', '| Ash `#797d86` | 6.90 AA')
    const r = run({ doc: { matrixRows } })
    expect(r.docCodes).toContain('MATRIX_DRIFT')
    // Both numbers must appear, or nobody can tell which one to fix.
    expect(r.docMessages.join('\n')).toMatch(/6\.90/)
    expect(r.docMessages.join('\n')).toMatch(/5\.09/)
  })

  it('catches a published AA label that disagrees with the ratio', () => {
    const matrixRows = DEFAULT_MATRIX_ROWS.replace('4.39 AA-large', '4.39 AA')
    const r = run({ doc: { matrixRows } })
    expect(r.docCodes).toContain('MATRIX_DRIFT')
  })

  it('catches a `Text On` column that sanctions a pair below the AA floor', () => {
    // The exact defect the brief names: the doc nominating Ash as text on a
    // surface where it measures 4.39:1.
    const tokenRows = DEFAULT_TOKEN_ROWS.replace(
      '| Ash | `#797d86` | `--color-ash` | Blackout, Depth | Graphite Deep, Graphite |',
      '| Ash | `#797d86` | `--color-ash` | Blackout, Depth, Graphite Deep | Graphite |',
    )
    const r = run({ doc: { tokenRows } })
    expect(r.docCodes).toContain('TEXT_ON_DRIFT')
    expect(r.docMessages.join('\n')).toMatch(/Ash.*Graphite Deep.*4\.39/s)
  })

  it('catches an alias table that disagrees with tailwind.config.ts', () => {
    const aliases = DEFAULT_ALIASES.replace(
      '| `text-neutral-500` / `text-ash` | Ash `#797d86` |',
      '| `text-neutral-500` / `text-ash` | Pewter `#94979e` |',
    )
    const r = run({ doc: { aliases } })
    expect(r.docCodes).toContain('ALIAS_DRIFT')
  })

  it('catches a colour the config can generate that no design.md table accounts for', () => {
    const config = DEFAULT_CONFIG.replace("blackout: '#000000',", "blackout: '#000000',\n        mystery: '#c0ffee',")
    const r = run({ config })
    expect(r.docCodes).toContain('RAMP_DRIFT')
    expect(r.docMessages.join('\n')).toMatch(/#c0ffee/)
  })

  it('is silent when doc, matrix, alias table and config all agree', () => {
    expect(run({}).docCodes).toEqual([])
  })
})

// ─── 3. Contrast: the ground is resolved, not presumed ───────────────────────

describe('sub-AA text is caught wherever the ground can be established', () => {
  it('catches a barred token against a background on the SAME element', () => {
    const r = run({ web: { 'a.tsx': component('text-ash bg-graphite-deep') } })
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/Ash.*Graphite Deep.*4\.39:1/)
  })

  it('catches a ground the element MANUFACTURES on hover', () => {
    // The class that no rest-state analysis can see: the label passes on the
    // transparent rest background and fails the moment the hover fill lands.
    const r = run({ web: { 'a.tsx': component('text-ash bg-transparent hover:bg-graphite') } })
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/hover:bg-graphite/)
    expect(r.messages.join('\n')).toMatch(/3\.68:1/)
  })

  it('catches a ground painted by an enclosing element', () => {
    const r = run({ web: { 'a.tsx': component('text-ash', 'p-4 bg-graphite-deep') } })
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/enclosing <div>/)
  })

  it('catches a ground painted one hop away, by an enclosing component’s root element', () => {
    const web = {
      'Card.tsx': `export function Card({ children }: { children: React.ReactNode }) {\n  return <section className="rounded bg-graphite-deep p-6">{children}</section>\n}\n`,
      'Panel.tsx':
        `import { Card } from './Card'\n` +
        `export function Panel() {\n  return (\n    <Card>\n      <span className="text-ash">meta</span>\n    </Card>\n  )\n}\n`,
    }
    const r = run({ web })
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/Card\.tsx/)
  })

  it('falls back to the ambient page ground that globals.css actually paints', () => {
    // On the real ground (Blackout) Ash is 5.09:1 and must NOT be flagged…
    expect(run({ web: { 'a.tsx': component('text-ash') } }).codes).not.toContain('SUB_AA_TEXT')
    // …but if the page ground itself were Graphite, the same class would fail.
    const r = run({
      globals: 'body { background-color: #242628; }\n',
      web: { 'a.tsx': component('text-ash') },
    })
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/ambient page ground/)
  })

  // ── Branch and state correlation ───────────────────────────────────────────
  //
  // These pin the bug that made 20 of this check's first 25 contrast findings
  // impossible pairings. A checker that cries wolf gets disabled, and then it
  // catches nothing at all — so each case below asserts BOTH that the phantom
  // pairing is not reported AND that a real defect in the same shape still is.

  it('never pairs a background and a text colour from opposite ternary branches', () => {
    // `bg-primary-900` (active) can never render with `text-ash` (inactive).
    const r = run({
      web: {
        'a.tsx':
          `export function C({ on }: { on: boolean }) {\n` +
          `  return <span className={on ? 'bg-graphite-deep text-whiteout' : 'bg-transparent text-ash'}>x</span>\n` +
          `}\n`,
      },
    })
    expect(r.codes).not.toContain('SUB_AA_TEXT')
  })

  it('still flags a sub-AA pair when both classes are on the SAME branch', () => {
    const r = run({
      web: {
        'a.tsx':
          `export function C({ on }: { on: boolean }) {\n` +
          `  return <span className={on ? 'bg-graphite-deep text-ash' : 'bg-transparent text-whiteout'}>x</span>\n` +
          `}\n`,
      },
    })
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/4\.39:1/)
  })

  it('correlates a CHILD’s branch with its ANCESTOR’s when the same condition gates both', () => {
    // The nav-pill shape: the Link's fill and the count's colour are both gated
    // on `isActive`, so Pewter can never land on the Whiteout fill.
    const r = run({
      web: {
        'a.tsx':
          `export function C({ isActive }: { isActive: boolean }) {\n` +
          `  return (\n` +
          `    <a className={isActive ? 'bg-whiteout text-graphite-deep' : 'bg-transparent text-cloud'}>\n` +
          `      <span className={isActive ? 'text-graphite-deep' : 'text-pewter'}>3</span>\n` +
          `    </a>\n` +
          `  )\n` +
          `}\n`,
      },
    })
    expect(r.codes).not.toContain('SUB_AA_TEXT')
  })

  it('does NOT pair a resting text colour with a hover fill when the hover also sets the text', () => {
    // `text-ash hover:text-whiteout hover:bg-graphite-deep` never renders Ash on
    // Graphite Deep: the variant that changes the fill changes the text with it.
    const r = run({
      web: { 'a.tsx': component('text-ash hover:text-whiteout hover:bg-graphite-deep') },
    })
    expect(r.codes).not.toContain('SUB_AA_TEXT')
  })

  it('DOES pair a resting text colour with a hover fill when the hover leaves the text alone', () => {
    const r = run({ web: { 'a.tsx': component('text-ash hover:bg-graphite-deep') } })
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/hover:bg-graphite-deep/)
  })

  it('records the resolved ground PER SITE, so grouped output cannot share one diagnosis', () => {
    // Two sites, same class, different grounds. If the reporter attached one
    // site's ground to both, the second would be undiagnosable — which is what
    // made the false positives so hard to spot.
    const r = runFull({
      web: {
        'a.tsx': component('text-ash bg-graphite-deep'),
        'b.tsx': component('text-ash bg-graphite'),
      },
    })
    const sub = r.violations.filter((v) => v.code === 'SUB_AA_TEXT')
    expect(sub).toHaveLength(2)
    for (const v of sub) expect(v.site, `${v.file} must carry its own ground`).toBeDefined()
    expect(new Set(sub.map((v) => v.site)).size).toBe(2)
    // …and the shared `detail` must differ too, or one heading would cover both.
    expect(new Set(sub.map((v) => v.detail)).size).toBe(2)
  })

  it('does NOT flag a barred token on a ground design.md sanctions for it', () => {
    // This is the false-positive guard. Ash on the page ground is correct per
    // design.md, and a check that flagged it would be arguing with the document
    // instead of enforcing it — and would be switched off.
    const r = run({ web: { 'a.tsx': component('text-ash bg-blackout') } })
    expect(r.codes).not.toContain('SUB_AA_TEXT')
  })

  it('does NOT hold borders, rings, fills or strokes to the 4.5:1 TEXT floor', () => {
    // design.md puts non-text UI boundaries on the 3:1 AA-large threshold.
    // Flagging a red border or a status dot as sub-AA text is a false positive
    // that teaches people to ignore the check.
    const r = run({ web: { 'a.tsx': component('border-ash ring-ash fill-ash stroke-ash bg-graphite-deep') } })
    expect(r.codes).not.toContain('SUB_AA_TEXT')
  })

  it('composites a translucent background over what is behind it', () => {
    const r = run({ web: { 'a.tsx': component('text-ash bg-whiteout/10', 'bg-blackout') } })
    // 10% white over black is ~#1a1a1a — an elevated surface, so Ash now fails.
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/composited over/)
  })

  it('names a replacement design.md actually sanctions, never one its Don’ts bar', () => {
    const r = run({ web: { 'a.tsx': component('text-ash bg-graphite-deep') } })
    const msg = r.messages.find((m) => m.startsWith('SUB_AA_TEXT')) ?? ''
    // Pewter is the documented secondary-on-surfaces token…
    expect(msg).toMatch(/text-pewter/)
    // …and Neon Glow, which clears AA but is barred from body copy, must not be
    // proposed as a way out of a contrast problem.
    expect(msg).not.toMatch(/use text-neon-glow/)
  })
})

// ─── 4. The alias trap — the single most important resolution requirement ────

describe('classes are resolved by VALUE, so alias spellings cannot hide', () => {
  it('treats text-neutral-500 exactly as text-ash, because it IS Ash', () => {
    // A check that pattern-matched `text-ash` would report a clean tree while
    // the aliased spelling shipped. Both must produce the same finding.
    const named = run({ web: { 'a.tsx': component('text-ash bg-graphite-deep') } })
    // The line below must CONTAIN a banned alias spelling in order to prove the
    // checker resolves it back to its token. `.eslintrc.js` bans `neutral-850`
    // at authoring time, and a test that could not write the banned string
    // could not test the ban. This is a synthetic class string written into a
    // temp directory, never a class this app renders.
    // eslint-disable-next-line no-restricted-syntax
    const aliased = run({ web: { 'a.tsx': component('text-neutral-500 bg-neutral-850') } })
    expect(aliased.codes).toContain('SUB_AA_TEXT')
    expect(named.messages.join()).toMatch(/Ash \(#797d86\)/)
    expect(aliased.messages.join()).toMatch(/Ash \(#797d86\)/)
    expect(aliased.messages.join()).toMatch(/4\.39:1/)
  })

  it('reports the alias spelling itself even when the pairing is legible', () => {
    const r = run({ web: { 'a.tsx': component('text-neutral-400') } })
    expect(r.codes).toContain('ALIAS_SPELLING')
    expect(r.messages.join('\n')).toMatch(/Pewter/)
    expect(r.messages.join('\n')).toMatch(/text-pewter/)
  })

  it('resolves an arbitrary hex to the same token as the class that generates it', () => {
    const r = run({ web: { 'a.tsx': component('text-[#797d86] bg-graphite-deep') } })
    expect(r.codes).toContain('SUB_AA_TEXT')
    expect(r.messages.join('\n')).toMatch(/Ash/)
  })

  it('sees through variant prefixes and opacity modifiers', () => {
    const r = run({ web: { 'a.tsx': component('md:hover:text-neutral-500 bg-graphite-deep') } })
    expect(r.codes).toContain('SUB_AA_TEXT')
  })
})

// ─── 5. Palette, ramps, arbitrary values ─────────────────────────────────────

describe('palette conformance', () => {
  it('flags a stock Tailwind colour family', () => {
    const r = run({ web: { 'a.tsx': component('text-sky-500') } })
    expect(r.codes).toContain('OFF_PALETTE')
    expect(r.messages.join('\n')).toMatch(/sky/)
  })

  it('flags a documented derived ramp stop, quoting the appendix', () => {
    const r = run({ web: { 'a.tsx': component('text-neutral-300') } })
    expect(r.codes).toContain('DERIVED_RAMP')
    expect(r.messages.join('\n')).toMatch(/must not be reached for in new work/)
    expect(r.messages.join('\n')).toMatch(/text-pewter/) // nearest canonical
  })

  it('flags an arbitrary hex that is not a token, and names the nearest that is', () => {
    const r = run({ web: { 'a.tsx': component('bg-[#123456]') } })
    expect(r.codes).toContain('ARBITRARY_COLOR')
    expect(r.messages.join('\n')).toMatch(/not a canonical design\.md token/)
  })

  it('flags an arbitrary hex that IS a token, because the literal stops tracking the doc', () => {
    const r = run({ web: { 'a.tsx': component('bg-[#151617]') } })
    expect(r.codes).toContain('ARBITRARY_COLOR')
    expect(r.messages.join('\n')).toMatch(/bg-graphite-deep/)
  })

  it('does NOT flag CSS system colours used for forced-colors support', () => {
    // `bg-[Highlight]` is the correct thing to write in a forced-colors branch;
    // the user agent substitutes the user's palette. Flagging it would punish
    // correct accessibility work.
    const r = run({ web: { 'a.tsx': component('forced-colors:bg-[Highlight] forced-colors:text-[CanvasText]') } })
    expect(r.codes).not.toContain('OFF_PALETTE')
    expect(r.codes).not.toContain('ARBITRARY_COLOR')
  })

  it('does not treat transparent/current/inherit as colours', () => {
    expect(run({ web: { 'a.tsx': component('bg-transparent text-current border-inherit') } }).codes).toEqual([])
  })

  it('flags a raw off-palette hex in a stylesheet but not the token declarations themselves', () => {
    const r = run({
      globals: ':root { --color-ash: #797d86; }\nbody { background-color: #000000; }\n.x { color: #bada55; }\n',
      web: {},
    })
    expect(r.codes).toContain('CSS_OFF_PALETTE')
    expect(r.messages.filter((m) => m.startsWith('CSS_OFF_PALETTE'))).toHaveLength(1)
    expect(r.messages.join('\n')).toMatch(/#bada55/)
  })
})

// ─── 6. Shapes, shadows, type scale ──────────────────────────────────────────

describe('shape, elevation and type conformance', () => {
  it('flags a radius outside the pill/4px dichotomy', () => {
    const r = run({ web: { 'a.tsx': component('rounded-[10px]') } })
    expect(r.codes).toContain('OFF_SYSTEM_RADIUS')
    expect(r.messages.join('\n')).toMatch(/10px/)
  })

  it('accepts the sanctioned radii, including corner-scoped and pill forms', () => {
    const r = run({ web: { 'a.tsx': component('rounded rounded-md rounded-t-md rounded-full rounded-[4px]') } })
    expect(r.codes).not.toContain('OFF_SYSTEM_RADIUS')
    expect(r.codes).not.toContain('DEAD_CLASS')
  })

  it('flags a hard-coded box-shadow, quoting the rule it breaks', () => {
    const r = run({ web: { 'a.tsx': component('shadow-[0_2px_8px_rgba(0,0,0,0.5)]') } })
    expect(r.codes).toContain('ELEVATION_SHADOW')
    expect(r.messages.join('\n')).toMatch(/layering near-black surfaces/)
  })

  it('accepts a shadow that references a design.md glow token', () => {
    const r = run({ web: { 'a.tsx': component('shadow-[var(--shadow-glow)]') } })
    expect(r.codes).toEqual([])
  })

  it('flags a shadow utility the config never defines, because it renders nothing at all', () => {
    // `shadow-glow` looks like it applies the glow token and emits no CSS
    // whatsoever — a silent no-op is worse than a wrong value.
    const r = run({ web: { 'a.tsx': component('shadow-glow') } })
    expect(r.codes).toContain('DEAD_CLASS')
    expect(r.messages.join('\n')).toMatch(/generates NO CSS/)
  })

  it('flags an off-scale arbitrary font size', () => {
    const r = run({ web: { 'a.tsx': component('text-[11px]') } })
    expect(r.codes).toContain('OFF_SCALE_TYPE')
    expect(r.messages.join('\n')).toMatch(/12px/) // nearest on-scale size
  })

  it('applies the monospaced scale when the element is monospaced', () => {
    // 10px is on Inter's scale and off Geist Mono's, so the same size is a
    // violation only in the mono context. A family-blind check gets this wrong
    // in both directions.
    expect(run({ web: { 'a.tsx': component('text-[10px]') } }).codes).not.toContain('OFF_SCALE_TYPE')
    const mono = run({ web: { 'a.tsx': component('font-mono text-[10px]') } })
    expect(mono.codes).toContain('OFF_SCALE_TYPE')
    expect(mono.messages.join('\n')).toMatch(/geist mono/i)
  })

  it('checks named font sizes against the scale too', () => {
    const r = run({ web: { 'a.tsx': component('font-mono text-2xl') } })
    expect(r.codes).toContain('OFF_SCALE_TYPE')
    expect(r.messages.join('\n')).toMatch(/24px/)
  })
})

// ─── 7. Scanning discipline ──────────────────────────────────────────────────

describe('what the scanner does and does not read', () => {
  it('ignores class names quoted inside comments', () => {
    // Several files in this repo document the anti-patterns they avoid. A raw
    // text scan reports the warning as the violation, and lets a real
    // `text-sky-500` hide behind a comment that mentions one.
    const body =
      `// never use text-sky-500 here, and rounded-[10px] is off-system\n` +
      `/* bg-[#bada55] would be wrong */\n` +
      `export function C() {\n  return <span className="text-pewter">x</span>\n}\n`
    expect(run({ web: { 'a.tsx': body } }).codes).toEqual([])
  })

  it('reads class strings out of shared style tables, not only JSX attributes', () => {
    // A bad token in a shared lookup map does the most damage, so a scanner
    // that only looked at className attributes would miss the worst cases.
    const body = `export const STYLE = { open: 'text-sky-500 px-2' } as const\n`
    expect(run({ web: { 'a.tsx': body } }).codes).toContain('OFF_PALETTE')
  })

  it('does not mistake prose for utilities', () => {
    const body = `export const COPY = 'Copy to clipboard, then scroll top-to-bottom for the text-entry field'\n`
    expect(run({ web: { 'a.tsx': body } }).codes).toEqual([])
  })

  it('reports the exact line of each occurrence, including inside multi-line templates', () => {
    const body = 'export const c = `\n  p-2\n  text-sky-500\n`\n'
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lines-'))
    tmpDirs.push(root)
    const webRoot = path.join(root, 'web')
    fs.mkdirSync(webRoot, { recursive: true })
    fs.writeFileSync(path.join(root, 'design.md'), designDoc())
    fs.writeFileSync(path.join(webRoot, 'tailwind.config.ts'), DEFAULT_CONFIG)
    fs.writeFileSync(path.join(webRoot, 'globals.css'), DEFAULT_GLOBALS)
    fs.writeFileSync(path.join(webRoot, 'a.tsx'), body)
    const res = analyze({
      designMd: path.join(root, 'design.md'),
      tailwindConfig: path.join(webRoot, 'tailwind.config.ts'),
      webRoot,
    })
    const v = res.violations.find((x) => x.className === 'text-sky-500')
    expect(v).toBeDefined()
    expect(v?.line).toBe(3)
  })
})

// ─── 8. Waivers cannot rot into a blanket mute ───────────────────────────────

describe('waiver hygiene', () => {
  const waiver = (over: Partial<Waiver> = {}): Waiver => ({
    code: 'OFF_PALETTE',
    className: 'text-sky-500',
    reason: 'Test fixture — a waiver without a reason is unrepresentable by construction.',
    ...over,
  })

  it('suppresses exactly the violation it names', () => {
    const r = run({ web: { 'a.tsx': component('text-sky-500') }, waivers: [waiver()] })
    expect(r.codes).not.toContain('OFF_PALETTE')
    expect(r.unusedWaivers).toHaveLength(0)
  })

  it('does not suppress a different class or a different code', () => {
    const r = run({
      web: { 'a.tsx': component('text-rose-500') },
      waivers: [waiver()],
    })
    expect(r.codes).toContain('OFF_PALETTE')
  })

  it('reports a waiver that suppresses nothing, so the list cannot rot into a blanket mute', () => {
    const r = run({ web: { 'a.tsx': component('text-pewter') }, waivers: [waiver()] })
    expect(r.unusedWaivers).toHaveLength(1)
    expect(r.unusedWaivers[0]?.reason).toMatch(/Test fixture/)
  })

  it('honours a file-scoped waiver only in that file', () => {
    const r = run({
      web: { 'a.tsx': component('text-sky-500'), 'b.tsx': component('text-sky-500') },
      waivers: [waiver({ file: 'a.tsx' })],
    })
    expect(r.codes.filter((c) => c === 'OFF_PALETTE')).toHaveLength(1)
  })
})

// ─── 9. Standing regression test against the real repository ─────────────────

describe('the real design.md, tailwind.config.ts and matrix stay mutually consistent', () => {
  const result = analyze()

  it('publishes no contrast ratio that disagrees with the formula', () => {
    const drift = result.docViolations.filter((v) => v.code === 'MATRIX_DRIFT')
    expect(drift.map((v) => `${v.className}: ${v.detail}`)).toEqual([])
  })

  it('sanctions no text/ground pair that is below the AA floor', () => {
    const drift = result.docViolations.filter((v) => v.code === 'TEXT_ON_DRIFT')
    expect(drift.map((v) => `${v.className}: ${v.detail}`)).toEqual([])
  })

  it('keeps the Tailwind alias table in step with tailwind.config.ts', () => {
    const drift = result.docViolations.filter((v) => v.code === 'ALIAS_DRIFT')
    expect(drift.map((v) => `${v.className}: ${v.detail}`)).toEqual([])
  })

  it('accounts for every colour tailwind.config.ts can generate', () => {
    const drift = result.docViolations.filter((v) => v.code === 'RAMP_DRIFT')
    expect(drift.map((v) => `${v.className}: ${v.detail}`)).toEqual([])
  })

  it('carries no unused waivers', () => {
    expect(result.unusedWaivers).toEqual([])
  })

  it('reads a non-trivial amount of the real tree, so a silent no-op cannot pass', () => {
    // Guards the whole suite: if the scanner or the parsers regressed to
    // finding nothing, every "no violations" assertion above would pass
    // vacuously.
    expect(result.filesScanned).toBeGreaterThan(50)
    expect(result.classesInspected).toBeGreaterThan(500)
    expect(parseDesignSystem().colors.length).toBeGreaterThan(1)
    expect(parseTailwindConfig().colors.size).toBeGreaterThan(20)
  })
})

// ─── 10. Enforcement tiers and the frozen-count ratchet ──────────────────────

describe('enforcement tiers', () => {
  const v = (code: ViolationCode, className: string, file = 'a.tsx'): Violation => ({
    code, className, file, line: 1, detail: 'd', fix: 'f',
  })

  it('defaults an unlisted code to BLOCKING, so a new check cannot slip in unenforced', () => {
    // The safe default matters more than it looks: codes sitting at zero today
    // must stay at zero without anyone remembering to promote them.
    expect(tierOf('OFF_PALETTE')).toBe('block')
    expect(tierOf('DEAD_CLASS')).toBe('block')
    expect(tierOf('CSS_OFF_PALETTE')).toBe('block')
    expect(tierOf('SUB_AA_TEXT')).toBe('block')
    expect(tierOf('OFF_SCALE_TYPE')).toBe('block')
    expect(tierOf('ALIAS_SPELLING')).toBe('frozen')
    expect(tierOf('DERIVED_RAMP')).toBe('frozen')
    expect(tierOf('MONO_RANGE_REVIEW')).toBe('report')
  })

  it('fails the build on a single Tier 1 violation', () => {
    const r = verdict({
      violations: [v('SUB_AA_TEXT', 'text-ash')],
      docViolations: [], unusedWaivers: [], ratchet: [],
    })
    expect(r.failed).toBe(true)
    expect(r.reasons.join()).toMatch(/Tier 1/)
  })

  it('never fails on a Tier 3 finding, however many there are', () => {
    const r = verdict({
      violations: Array.from({ length: 50 }, () => v('MONO_RANGE_REVIEW', 'text-[10px]')),
      docViolations: [], unusedWaivers: [], ratchet: [],
    })
    expect(r.failed).toBe(false)
  })

  it('fails on any document-level inconsistency', () => {
    expect(
      verdict({ violations: [], docViolations: [v('MATRIX_DRIFT', 'x')], unusedWaivers: [], ratchet: [] }).failed,
    ).toBe(true)
  })

  it('fails on a waiver that suppresses nothing', () => {
    const r = verdict({
      violations: [], docViolations: [], ratchet: [],
      unusedWaivers: [{ code: 'OFF_PALETTE', className: 'x', reason: 'r' }],
    })
    expect(r.failed).toBe(true)
  })
})

describe('the frozen-count ratchet', () => {
  const v = (className: string, file: string): Violation => ({
    code: 'ALIAS_SPELLING', className, file, line: 1, detail: 'd', fix: 'f',
  })
  const base = (classes: Record<string, number>): Baseline => ({
    frozen: { ALIAS_SPELLING: { total: Object.values(classes).reduce((a, b) => a + b, 0), classes } },
  })

  it('passes when the count is unchanged', () => {
    const r = evaluateRatchet([v('text-neutral-500', 'a.tsx')], base({ 'text-neutral-500': 1 }))
    expect(r[0]?.grown).toEqual([])
    expect(verdict({ violations: [], docViolations: [], unusedWaivers: [], ratchet: r }).failed).toBe(false)
  })

  it('FAILS when a class count rises, naming the class and the amount', () => {
    const r = evaluateRatchet(
      [v('text-neutral-500', 'a.tsx'), v('text-neutral-500', 'b.tsx'), v('text-neutral-500', 'c.tsx')],
      base({ 'text-neutral-500': 1 }),
    )
    expect(r[0]?.grown).toEqual([{ className: 'text-neutral-500', baseline: 1, actual: 3 }])
    expect(verdict({ violations: [], docViolations: [], unusedWaivers: [], ratchet: r }).failed).toBe(true)
  })

  it('FAILS on a brand-new class, which has an implicit baseline of zero', () => {
    const r = evaluateRatchet([v('text-neutral-200', 'a.tsx')], base({ 'text-neutral-500': 1 }))
    expect(r[0]?.grown).toEqual([{ className: 'text-neutral-200', baseline: 0, actual: 1 }])
  })

  it('does NOT fail when a count falls — it reports the delta instead', () => {
    // Failing on an improvement would break CI for the very commit that fixes
    // things, which is how ratchets get deleted rather than maintained.
    const r = evaluateRatchet([], base({ 'text-neutral-500': 5 }))
    expect(r[0]?.grown).toEqual([])
    expect(r[0]?.shrunk).toEqual([{ className: 'text-neutral-500', baseline: 5, actual: 0 }])
    expect(verdict({ violations: [], docViolations: [], unusedWaivers: [], ratchet: r }).failed).toBe(false)
  })

  it('treats a DELETED baseline entry as zero, so removing one to reset it fails immediately', () => {
    const r = evaluateRatchet([v('text-neutral-500', 'a.tsx')], { frozen: {} })
    expect(r[0]?.grown).toHaveLength(1)
  })

  it('the committed baseline is real, parseable, and covers exactly the frozen codes', () => {
    const b = loadBaseline()
    expect(Object.keys(b.frozen).sort()).toEqual(['ALIAS_SPELLING', 'DERIVED_RAMP'])
    for (const [code, entry] of Object.entries(b.frozen)) {
      expect(tierOf(code as ViolationCode), `${code} is in the baseline so it must be frozen`).toBe('frozen')
      const summed = Object.values(entry.classes).reduce((a, n) => a + n, 0)
      expect(summed, `${code}: per-class counts must sum to the total`).toBe(entry.total)
    }
  })
})

describe('the tool drives its own remediation', () => {
  const tw = (colors: Record<string, string>): TailwindMap => ({
    colors: new Map(Object.entries(colors)), radii: new Map(), shadows: new Map(), fontSizes: new Map(),
  })

  it('names a ramp stop that has reached zero usage so it can be banned in ESLint', () => {
    const stops = bannableStops(new Map([['neutral-500', 12]]), tw({ 'neutral-500': '#797d86', 'neutral-300': '#a6a9af' }))
    expect(stops).toContain('neutral-300') // unused -> ready to ban
    expect(stops).not.toContain('neutral-500') // still in use
  })

  it('stops naming a stop once .eslintrc.js actually bans it', () => {
    // Read from the REAL config using its own regex, so this can never drift
    // from what ESLint enforces. `neutral-850` is in the shipped ban list, and
    // naming it here is the only way to assert that the ban is seen — a test
    // that cannot write the banned string cannot test the ban.
    // eslint-disable-next-line no-restricted-syntax
    expect(bannableStops(new Map(), tw({ 'neutral-850': '#151617' }))).toEqual([])
  })
})

describe('the honesty notices are pinned so they cannot be trimmed as noise', () => {
  it('states what a clean result does NOT prove', () => {
    expect(GROUND_RESOLUTION_NOTICE).toContain(
      '"No SUB_AA_TEXT" means no defect\n            was provable, not that the contrast is correct.',
    )
    expect(GROUND_RESOLUTION_NOTICE).toContain('UNDER-REPORTS')
  })

  it('states, symmetrically, what the analysis can wrongly ASSERT — and names the branch limit', () => {
    // The more dangerous direction: a checker that cries wolf gets disabled,
    // and then it catches nothing at all.
    expect(FALSE_POSITIVE_NOTICE).toMatch(/can be\n\s+wrong/)
    expect(FALSE_POSITIVE_NOTICE).toMatch(/ternary/)
    expect(FALSE_POSITIVE_NOTICE).toMatch(/hover/)
    expect(FALSE_POSITIVE_NOTICE).toMatch(/report it/)
  })
})
