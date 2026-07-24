#!/usr/bin/env tsx
/**
 * check-design-tokens.ts
 *
 * Repo-wide design-token conformance gate for apps/web.
 *
 * WHY THIS EXISTS
 * ---------------
 * CLAUDE.md declares `design.md` ("Neon — Server Room After Dark") the single
 * authoritative source for the product's visual identity, and requires any UI
 * change needing something outside that system to update design.md FIRST. Until
 * this script landed, NOTHING enforced that. No grep, no lint rule, no CI job.
 * The only enforcement anywhere in the tree was tests/unit/patterns_a11y.test.ts,
 * which hard-codes 13 component files from one feature — so token drift in any
 * other component was invisible. `text-neutral-500` (the remapped Ash token,
 * which fails WCAG AA on every elevated surface) had spread across the codebase
 * with nothing objecting.
 *
 * THE ONE-SOURCE-OF-TRUTH CONSTRAINT
 * ----------------------------------
 * This script contains NO palette. Not a hex, not a token name, not a size list,
 * not a contrast ratio. Everything sanctioned is PARSED at run time from:
 *
 *   design.md                    — the canonical token table (with its `Text On`
 *                                  / `Never Text On` columns), the WCAG matrix,
 *                                  the type/radius/shadow tables, the Tailwind
 *                                  alias table, and the appendix of derived ramp
 *                                  stops.
 *   apps/web/tailwind.config.ts  — the MAPPING from those token values to the
 *                                  Tailwind class names that actually generate
 *                                  them.
 *
 * If this script and design.md could disagree, the script would BE a second
 * source of truth — the exact failure it exists to prevent, relocated one layer
 * up. So design.md is read, never transcribed. Edit design.md and this check's
 * verdict moves with it; that is the intended and only way to change what is
 * sanctioned.
 *
 * Ratios are the one place the doc is not taken on faith. design.md publishes a
 * matrix; this script RECOMPUTES every cell from the sRGB relative-luminance
 * formula and fails on any disagreement, reporting both numbers. A doc and a
 * checker that can quietly diverge on the load-bearing numbers is the same
 * second-source-of-truth problem in miniature.
 *
 * The three hard-coded tables below are deliberate exceptions, and none encodes
 * what is *allowed*:
 *   - TAILWIND_DEFAULT_FONT_SIZES / TAILWIND_DEFAULT_COLOR_FAMILIES: facts about
 *     Tailwind itself (what `text-3xl` or `text-sky-500` mean), needed to
 *     recognise a class as off-system. They widen the net; they bless nothing.
 *   - CSS_SYSTEM_COLORS: CSS-wide system color keywords (`Highlight`,
 *     `CanvasText`, …). These are not colors, they are user-agent slots that
 *     forced-colors mode substitutes. Treating them as palette entries would
 *     punish correct forced-colors handling.
 *
 * WHAT IT CHECKS
 * --------------
 * design.md's own internal consistency (failures here are fixed in design.md):
 *   MATRIX_DRIFT      every published matrix cell recomputed; ratio and AA label
 *                     must match.
 *   TEXT_ON_DRIFT     every ground in a token's `Text On` list must actually
 *                     compute ≥ 4.5:1.
 *   ALIAS_DRIFT       every row of the Tailwind alias table must resolve, through
 *                     tailwind.config.ts, to the token hex it claims.
 *   RAMP_DRIFT        every color in tailwind.config.ts must be either a canonical
 *                     token or a documented derived ramp stop. An undocumented
 *                     hex in the config is a palette the doc has never seen.
 *
 * apps/web conformance (failures here are fixed in the components):
 *   SUB_AA_TEXT       a token used as text on a ground its `Never Text On` column
 *                     bars it from. Proven when a background class sits in the
 *                     same class string; presumed otherwise, because no static
 *                     check can know which surface an element lands on.
 *   OFF_PALETTE       a color that is not a canonical token at all.
 *   DERIVED_RAMP      a derived ramp stop — design.md: "not an expansion of the
 *                     palette and must not be reached for in new work".
 *   ALIAS_SPELLING    a canonical token reached by its legacy `neutral-*` alias.
 *                     This is the mechanism by which the sub-AA Ash token spread:
 *                     the class name gives no hint which token you picked.
 *   ARBITRARY_COLOR   `text-[#hex]`, `bg-[rgb(...)]` — bypasses the token layer.
 *   OFF_SCALE_TYPE    font sizes off design.md's per-family size lists.
 *   ELEVATION_SHADOW  box-shadow where design.md forbids it.
 *   OFF_SYSTEM_RADIUS radii outside the 4px / 9999px dichotomy.
 *   DEAD_CLASS        a class tailwind.config.ts does not define — renders NOTHING.
 *   CSS_OFF_PALETTE   raw off-palette hex in a stylesheet.
 *
 * CLASS-NAME RESOLUTION IS BY VALUE, NOT BY SPELLING
 * --------------------------------------------------
 * Every color class is resolved through tailwind.config.ts to a hex, and the hex
 * is matched against design.md. `text-neutral-500`, `text-ash` and
 * `text-[#797d86]` are therefore the same finding under three spellings. A check
 * that pattern-matched `text-ash` would have reported a clean tree while 173
 * usages of the alias shipped.
 *
 * HOW THE GROUND IS ESTABLISHED  (and where that stops working)
 * -----------------------------
 * Contrast is a property of a PAIR, so `text-ash` on its own is not a defect:
 * design.md clears Ash on Blackout (5.09) and bars it on Graphite Deep (4.39).
 * The ground is therefore RESOLVED, not presumed:
 *   1. a background on the SAME element, INCLUDING variant states — `hover:bg-*`
 *      manufactures its own ground on interaction, and a label that passes at
 *      rest can fail the moment the fill lands under it;
 *   2. a background on an enclosing JSX element in the same file;
 *   3. one hop into an enclosing local component's root element;
 *   4. the ambient page ground, read from what `body` actually paints in
 *      globals.css.
 * An opaque layer occludes everything outside it; translucent layers are
 * composited over whatever resolves behind them.
 *
 * This is why the check is quiet about the many `text-ash` usages that sit on
 * the page ground and loud about the few that sit on a card or a hover fill.
 * A check that flagged every occurrence of a token would be arguing with
 * design.md rather than enforcing it, and would be switched off within a week.
 *
 * KNOWN LIMITS (stated so nobody mistakes a pass for proof)
 * ------------
 *   - GROUND RESOLUTION IS NOT COMPLETE, AND ITS FAILURE MODE IS SILENCE. Step 3
 *     goes exactly one hop and takes the first background it finds in the
 *     component file. A surface painted two components up, by a styled wrapper
 *     passed as a prop, by a `className` assembled at runtime, or by plain CSS
 *     inheritance, resolves to the ambient page ground instead — and the page
 *     ground is the most forgiving surface in the system, so the check will
 *     report PASS on a pairing it could not actually see. Treat a clean
 *     SUB_AA_TEXT result as "no contrast defect was provable", never as "the
 *     contrast is correct".
 *   - `rounded-full` on a non-button cannot be judged statically; whether an
 *     element is a button is not a property of its class list. The pill/4px
 *     dichotomy is enforced on VALUES here; the "is it a button" half stays with
 *     tests/unit/patterns_a11y.test.ts.
 *   - A translucent TEXT color (`text-graphite/60`) is measured at full opacity.
 *     The reported ratio is therefore optimistic, never pessimistic.
 *   - design.md's `AA-large` (3:1) threshold legitimately applies to icons,
 *     dots, borders and focus rings. Only text-bearing prefixes are contrast-
 *     checked here; `border-*`, `fill-*`, `stroke-*` and `ring-*` are checked for
 *     palette membership only, never against the 4.5:1 text floor.
 *   - Only string literals in .ts/.tsx are scanned, plus hex literals in .css. A
 *     class assembled from runtime fragments is invisible to any static check.
 *   - Animation is NOT checked. apps/web/app/globals.css carries a global
 *     `@media (prefers-reduced-motion: reduce)` block that neutralises the
 *     animations centrally, which is stronger than per-call-site `motion-safe:`
 *     prefixes because it cannot be forgotten. A rule demanding the prefix would
 *     flag correct code.
 *
 * Run: pnpm tsx scripts/check-design-tokens.ts
 *      pnpm tsx scripts/check-design-tokens.ts --all      # no per-class capping
 *      pnpm tsx scripts/check-design-tokens.ts --matrix   # print recomputed matrix
 *      pnpm tsx scripts/check-design-tokens.ts --tokens   # dump what was parsed
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const __filename_ = fileURLToPath(import.meta.url)
const REPO_ROOT = path.join(path.dirname(__filename_), '..')

const DESIGN_MD = path.join(REPO_ROOT, 'design.md')
const TAILWIND_CONFIG = path.join(REPO_ROOT, 'apps/web/tailwind.config.ts')
const WEB_ROOT = path.join(REPO_ROOT, 'apps/web')

// ─── Waivers ──────────────────────────────────────────────────────────────────
//
// A waiver suppresses ONE violation code for ONE class, optionally narrowed to
// one file. The `reason` is required by the type, so an undocumented waiver
// cannot be written. Waivers are themselves checked: one that suppresses nothing
// is a FAILURE, so this list cannot rot into a blanket mute that swallows the
// next real drift.
//
// A waiver is the wrong tool for "design.md should allow this". In that case
// change design.md — which is the entire point of it being authoritative.
export interface Waiver {
  /** Violation code to suppress, e.g. 'OFF_PALETTE'. */
  readonly code: ViolationCode
  /** Exact offending class, variants stripped, e.g. 'text-sky-500'. */
  readonly className: string
  /** Optional repo-relative file to narrow the waiver to. */
  readonly file?: string
  /** Why this is sanctioned despite design.md. Required. */
  readonly reason: string
}

const WAIVERS: readonly Waiver[] = []

// ─── Facts about Tailwind (not about our palette) ─────────────────────────────

/** Tailwind's stock fontSize scale in px. tailwind.config.ts does not override it. */
const TAILWIND_DEFAULT_FONT_SIZES: Readonly<Record<string, number>> = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20,
  '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48,
  '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128,
}

/**
 * Tailwind's stock color family names, used ONLY to recognise `text-sky-500` as
 * a color utility (and therefore reportable) rather than as an unrelated string.
 * Families the config overrides resolve through the config first, so `neutral-*`
 * never reaches this list.
 */
const TAILWIND_DEFAULT_COLOR_FAMILIES: readonly string[] = [
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
  'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
  'purple', 'fuchsia', 'pink', 'rose',
]

/** Tailwind color keywords that carry no color value of their own. */
const COLORLESS_KEYWORDS = new Set(['transparent', 'current', 'inherit', 'none', 'auto', 'initial', 'unset'])

/**
 * CSS-wide system color keywords. Inside a `forced-colors:` variant these are
 * the CORRECT thing to use — the user agent substitutes the user's own palette,
 * and pinning a brand hex there is the actual accessibility defect. Not a
 * palette exemption: they never render a color we chose.
 */
const CSS_SYSTEM_COLORS = new Set(
  ['Canvas', 'CanvasText', 'LinkText', 'VisitedText', 'ActiveText', 'ButtonFace',
   'ButtonText', 'ButtonBorder', 'Field', 'FieldText', 'Highlight', 'HighlightText',
   'SelectedItem', 'SelectedItemText', 'Mark', 'MarkText', 'GrayText', 'AccentColor',
   'AccentColorText'].map((s) => s.toLowerCase()),
)

/** WCAG 2.1 AA for normal-size text — design.md's stated floor for this product. */
const AA_NORMAL = 4.5

// ─── Types ────────────────────────────────────────────────────────────────────

export type ViolationCode =
  // design.md internal consistency
  | 'MATRIX_DRIFT'
  | 'TEXT_ON_DRIFT'
  | 'ALIAS_DRIFT'
  | 'RAMP_DRIFT'
  // apps/web conformance
  | 'SUB_AA_TEXT'
  | 'OFF_PALETTE'
  | 'DERIVED_RAMP'
  | 'ALIAS_SPELLING'
  | 'ARBITRARY_COLOR'
  | 'OFF_SCALE_TYPE'
  | 'MONO_RANGE_REVIEW'
  | 'MONO_STEP_REQUIREMENT'
  | 'ELEVATION_SHADOW'
  | 'OFF_SYSTEM_RADIUS'
  | 'DEAD_CLASS'
  | 'CSS_OFF_PALETTE'

export interface ColorToken {
  readonly name: string
  /** Flat hex. For Scanline Fade (a gradient in the table) this comes from the matrix row. */
  readonly hex: string | null
  readonly cssVar: string
  readonly role: string
  /** Surface token names this may be normal-size text on. Empty = never text. */
  readonly textOn: readonly string[]
  /** Surface token names it is below 4.5:1 on. */
  readonly neverTextOn: readonly string[]
  /** Role marks it a background/surface. */
  readonly isSurface: boolean
  /**
   * A surface TEXT actually sits on. Excludes surfaces design.md's own Role
   * column calls borders/dividers — Graphite Light is in the matrix so border
   * and focus-ring contrast can be checked, and design.md says outright it "is a
   * border, not a ground". Counting it as a text ground would condemn Pewter,
   * which the same document names the secondary-text default.
   */
  readonly isTextGround: boolean
}

export interface MatrixCell {
  readonly fg: string
  readonly bg: string
  readonly ratio: number
  readonly label: string
}

export interface RampStop {
  readonly stops: string
  readonly hex: string
  readonly note: string
}

export interface AliasRow {
  readonly classes: readonly string[]
  readonly tokenName: string
  readonly hex: string
}

export interface Violation {
  readonly code: ViolationCode
  readonly file: string
  readonly line: number
  readonly className: string
  readonly detail: string
  readonly fix: string
  /**
   * Site-specific context — for contrast findings, the ground THIS occurrence
   * resolved against. Printed on the occurrence's own line, because grouping
   * sites under one heading must never imply they share a diagnosis they do
   * not: an earlier version printed only the first site's ground for a group of
   * eleven, and that is exactly what let twenty false positives hide in plain
   * sight.
   */
  readonly site?: string
}

export interface DesignSystem {
  /** The canonical 13. design.md: "Canonical palette = the 13 rows. Nothing else." */
  readonly colors: readonly ColorToken[]
  readonly byHex: ReadonlyMap<string, ColorToken>
  readonly byName: ReadonlyMap<string, ColorToken>
  /** Surfaces the matrix has columns for. */
  readonly surfaces: readonly string[]
  readonly matrix: readonly MatrixCell[]
  /** hex -> documented derived ramp stop (explicitly NOT palette). */
  readonly ramps: ReadonlyMap<string, RampStop>
  readonly aliases: readonly AliasRow[]
  /** font family (lowercased) -> sanctioned px sizes */
  readonly fontSizes: ReadonlyMap<string, ReadonlySet<number>>
  readonly allFontSizes: ReadonlySet<number>
  readonly radii: ReadonlySet<string>
  readonly shadowTokens: ReadonlyMap<string, string>
  readonly cssVars: ReadonlySet<string>
  /**
   * The monospaced PROSE window, parsed from design.md's Mono Range Rules.
   * Sizes outside it are sanctioned only for marks — see MonoStep.
   */
  readonly monoProseRange: { readonly min: number; readonly max: number } | null
  /** The narrowly-scoped mono steps and the classes design.md makes mandatory on each. */
  readonly monoSteps: readonly MonoStep[]
  /** px -> design.md's explicit reason that step does not exist ("Why 11px does not exist"). */
  readonly sizeNonExistence: ReadonlyMap<number, string>
}

export interface MonoStep {
  readonly step: string
  readonly size: number
  /** Tailwind utilities design.md marks as required, e.g. `tabular-nums`. */
  readonly requires: readonly string[]
  readonly sanctionedFor: string
  readonly forbiddenFor: string
}

export interface TailwindMap {
  readonly colors: ReadonlyMap<string, string>
  readonly radii: ReadonlyMap<string, string>
  readonly shadows: ReadonlyMap<string, string>
  readonly fontSizes: ReadonlyMap<string, string>
}

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const RED = '[0;31m'
const GREEN = '[0;32m'
const YELLOW = '[1;33m'
const CYAN = '[0;36m'
const DIM = '[2m'
const BOLD = '[1m'
const RESET = '[0m'

const rel = (p: string): string => path.relative(REPO_ROOT, p)

// ─── Color math ───────────────────────────────────────────────────────────────

function normalizeHex(raw: string): string | null {
  let h = raw.trim().toLowerCase()
  if (h.startsWith('#')) h = h.slice(1)
  if (/^[0-9a-f]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('')
  if (/^[0-9a-f]{8}$/.test(h)) h = h.slice(0, 6) // drop alpha for palette identity
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null
}

function rgbOf(hex: string): [number, number, number] {
  const h = hex.slice(1)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export function relativeLuminance(hex: string): number {
  const linear = rgbOf(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** design.md's own threshold vocabulary, from its Thresholds table. */
function wcagLabel(ratio: number): string {
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA-large'
  return 'FAIL'
}

function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgbOf(a)
  const [r2, g2, b2] = rgbOf(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

// ─── 1. Parse design.md ───────────────────────────────────────────────────────

function mdSection(md: string, heading: string): string {
  const idx = md.indexOf(heading)
  if (idx === -1) return ''
  const rest = md.slice(idx + heading.length)
  const level = (heading.match(/^#+/) ?? ['#'])[0].length
  const next = rest.search(new RegExp(`\\n#{1,${level}} `, 'm'))
  return next === -1 ? rest : rest.slice(0, next)
}

/** Splits a markdown table row into trimmed cells. */
function cellsOf(row: string): string[] {
  const t = row.trim()
  if (!t.startsWith('|')) return []
  return t.slice(1, t.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim())
}

/** `Blackout, Depth` / `none` / `all` -> a name list. */
function nameList(cell: string, all: readonly string[]): string[] {
  const v = cell.trim().toLowerCase()
  if (v === 'none' || v === '') return []
  if (v === 'all') return [...all]
  return cell.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * design.md is markdown, and parsing markdown with regexes is normally a bad
 * idea. It is the right call here: the alternative is transcribing the palette
 * into this file, which recreates the exact problem the script exists to solve.
 *
 * Every parse is anchored to a literal heading or header row and asserts it
 * found something. A restructured design.md therefore fails LOUDLY rather than
 * silently sanctioning nothing (an empty palette would make every class a
 * violation) or everything (an empty violation list reads as a clean tree).
 */
export function parseDesignSystem(designMdPath: string = DESIGN_MD): DesignSystem {
  const md = fs.readFileSync(designMdPath, 'utf8')
  const bail = (what: string): never => {
    throw new Error(
      `${rel(designMdPath)}: ${what}. design.md's structure changed — fix the parser in ` +
        `${rel(__filename_)}. Do NOT let this check degrade to a silent pass.`,
    )
  }

  // --- 1a. The WCAG matrix (parsed first: it supplies Scanline Fade's flat hex)
  const matrixSection = mdSection(md, '### Matrix')
  const matrixRows = matrixSection.split('\n').filter((l) => l.trim().startsWith('|'))
  const headerCells = cellsOf(matrixRows[0] ?? '')
  if (headerCells.length < 2) bail('could not find the header row of the `### Matrix` table')
  /** `Graphite Deep \`#151617\`` -> { name, hex } */
  const labelOf = (cell: string): { name: string; hex: string | null } => {
    const m = /^(.*?)\s*`(#[0-9a-fA-F]{3,8})`\s*$/.exec(cell)
    if (m === null) return { name: cell.trim(), hex: null }
    return { name: (m[1] ?? '').trim(), hex: normalizeHex(m[2] ?? '') }
  }
  const surfaceLabels = headerCells.slice(1).map(labelOf)
  const surfaces = surfaceLabels.map((s) => s.name)
  const matrixHex = new Map<string, string>()
  for (const s of surfaceLabels) if (s.hex !== null) matrixHex.set(s.name, s.hex)

  const matrix: MatrixCell[] = []
  for (const row of matrixRows.slice(1)) {
    const cells = cellsOf(row)
    if (cells.length !== headerCells.length) continue
    if (/^-+$/.test((cells[0] ?? '').replace(/[|: ]/g, ''))) continue // separator row
    const fg = labelOf(cells[0] ?? '')
    if (fg.name === '' || fg.name === 'Foreground') continue
    if (fg.hex !== null) matrixHex.set(fg.name, fg.hex)
    cells.slice(1).forEach((cell, i) => {
      const m = /^([\d.]+)\s+(AAA|AA-large|AA|FAIL)$/.exec(cell.trim())
      if (m === null) return // the `—` diagonal
      matrix.push({
        fg: fg.name,
        bg: surfaces[i] ?? '',
        ratio: Number(m[1]),
        label: m[2] ?? '',
      })
    })
  }
  if (matrix.length === 0) bail('parsed 0 cells from the `### Matrix` table')

  // --- 1b. The canonical token table ----------------------------------------
  const tokenSection = mdSection(md, '## Tokens — Colors')
  const headerIdx = tokenSection.indexOf('| Name | Value | Token | Text On |')
  if (headerIdx === -1) {
    bail('could not find the token-table header `| Name | Value | Token | Text On |`')
  }
  const tokenLines: string[] = []
  for (const line of tokenSection.slice(headerIdx).split('\n').slice(2)) {
    if (!line.trim().startsWith('|')) break // the row block ends at the first non-`|` line
    tokenLines.push(line)
  }

  const colors: ColorToken[] = []
  const rawRows: { cells: string[] }[] = tokenLines.map((l) => ({ cells: cellsOf(l) }))
  const allNames = rawRows.map((r) => (r.cells[0] ?? '').trim()).filter((n) => n.length > 0)

  for (const { cells } of rawRows) {
    if (cells.length < 6) continue
    const [name = '', value = '', token = '', textOn = '', neverTextOn = '', role = ''] = cells
    // ONE ROW IS NOT A HEX (Scanline Fade is a linear-gradient literal). Skip the
    // coercion and take the flat form from the matrix, where the doc publishes it.
    const hex = normalizeHex((/`([^`]+)`/.exec(value)?.[1] ?? value)) ?? matrixHex.get(name.trim()) ?? null
    const roleLower = role.toLowerCase()
    const isSurface = /background|surface|ground/.test(roleLower)
    colors.push({
      name: name.trim(),
      hex,
      cssVar: (/`([^`]+)`/.exec(token)?.[1] ?? token).trim(),
      role: role.trim(),
      textOn: nameList(textOn, surfaces),
      neverTextOn: nameList(neverTextOn, surfaces),
      isSurface,
      isTextGround: isSurface && !/borders?|dividers?/.test(roleLower),
    })
  }
  if (colors.length === 0) bail('parsed 0 rows from the canonical token table')

  const byHex = new Map<string, ColorToken>()
  const byName = new Map<string, ColorToken>()
  for (const c of colors) {
    byName.set(c.name, c)
    if (c.hex !== null) byHex.set(c.hex, c)
  }
  void allNames

  // --- 1c. Derived ramp stops (documented, explicitly NOT palette) -----------
  const ramps = new Map<string, RampStop>()
  for (const row of mdSection(md, '### Derived Tailwind ramps').split('\n')) {
    const cells = cellsOf(row)
    if (cells.length !== 3) continue
    const [stops = '', value = '', note = ''] = cells
    if (stops === 'Tailwind stop') continue
    const hex = normalizeHex(/`([^`]+)`/.exec(value)?.[1] ?? value)
    if (hex === null) continue
    ramps.set(hex, { stops: stops.replace(/`/g, ''), hex, note: note.trim() })
  }

  // --- 1d. The Tailwind alias table -----------------------------------------
  const aliases: AliasRow[] = []
  for (const row of mdSection(md, '### Tailwind alias trap').split('\n')) {
    const cells = cellsOf(row)
    if (cells.length !== 3) continue
    const [classCell = '', tokenCell = ''] = cells
    if (classCell === 'Tailwind class') continue
    const classes = [...classCell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '')
    const hex = normalizeHex(/`(#[0-9a-fA-F]{3,8})`/.exec(tokenCell)?.[1] ?? '')
    const tokenName = tokenCell.replace(/`[^`]*`/g, '').trim()
    if (classes.length === 0 || hex === null) continue
    aliases.push({ classes, tokenName, hex })
  }

  // --- 1e. Type sizes, per font family --------------------------------------
  const fontSizes = new Map<string, Set<number>>()
  const typography = mdSection(md, '## Tokens — Typography')
  for (const m of typography.matchAll(/###\s+([A-Za-z][A-Za-z0-9 ]*?)\s+—[\s\S]*?\n- \*\*Sizes:\*\*\s*([^\n]+)/g)) {
    const set = new Set<number>()
    for (const s of (m[2] ?? '').matchAll(/(\d+(?:\.\d+)?)px/g)) set.add(Number(s[1]))
    if (set.size > 0) fontSizes.set((m[1] ?? '').trim().toLowerCase(), set)
  }
  const scaleSizes = new Set<number>()
  for (const m of mdSection(md, '### Type Scale').matchAll(/\|\s*[a-z-]+\s*\|\s*(\d+)px\s*\|/g)) {
    scaleSizes.add(Number(m[1]))
  }
  if (scaleSizes.size > 0) fontSizes.set('scale', scaleSizes)
  const allFontSizes = new Set<number>()
  for (const set of fontSizes.values()) for (const v of set) allFontSizes.add(v)
  if (allFontSizes.size === 0) bail('parsed 0 font sizes')

  // --- 1e2. Mono range rules -------------------------------------------------
  //
  // design.md scopes the ends of the mono scale by INTENT, not by number: the
  // same 10px is correct for a wordmark and wrong for a date label. Both the
  // prose window and the per-step requirements are parsed, never assumed — the
  // whole point of the doc rewrite was to make this mechanical.
  const monoSection = mdSection(md, '### Mono Range Rules')
  const proseMatch = /floored at (\d+)px[^.]*?capped at (\d+)px/.exec(monoSection)
  const monoProseRange =
    proseMatch === null
      ? null
      : { min: Number(proseMatch[1]), max: Number(proseMatch[2]) }

  const monoSteps: MonoStep[] = []
  for (const row of monoSection.split('\n')) {
    const cells = cellsOf(row)
    if (cells.length !== 3) continue
    const [stepCell = '', sanctioned = '', forbidden = ''] = cells
    const m = /^`([a-z-]+)`\s*(\d+)px$/.exec(stepCell.trim())
    if (m === null) continue
    // Required utilities are the backticked tokens in the "Sanctioned for" cell
    // that have Tailwind utility shape (`tabular-nums`, `pointer-events-none`,
    // `select-none`). Symbols and single glyphs quoted as examples — `AFR`,
    // `1`, `↗` — do not match, so they are not mistaken for requirements.
    const requires = [...sanctioned.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((r) => r[1] ?? '')
    monoSteps.push({
      step: m[1] ?? '',
      size: Number(m[2]),
      requires,
      sanctionedFor: sanctioned.replace(/\*\*/g, '').trim(),
      forbiddenFor: forbidden.replace(/\*\*/g, '').trim(),
    })
  }

  // design.md now states outright which sizes do NOT exist and why. Quoting the
  // clause turns "not on the scale" from an assertion by this script into a
  // citation, which is the difference between an argument and a decision.
  const sizeNonExistence = new Map<number, string>()
  for (const m of monoSection.matchAll(/\*\*Why (\d+)px does not exist\.\*\*\s*([^\n]*(?:\n(?!\n|\*\*|\|)[^\n]*)*)/g)) {
    sizeNonExistence.set(Number(m[1]), (m[2] ?? '').replace(/\s+/g, ' ').replace(/`/g, '').trim())
  }

  // --- 1f. Radii -------------------------------------------------------------
  const radii = new Set<string>(['0px']) // a square corner is always on-system
  for (const m of mdSection(md, '### Border Radius').matchAll(/\|\s*[a-z]+\s*\|\s*(\d+)px\s*\|/g)) {
    radii.add(`${m[1]}px`)
  }
  if (radii.size <= 1) bail('parsed 0 radii from the Border Radius table')

  // --- 1g. Shadow / glow tokens ---------------------------------------------
  const shadowTokens = new Map<string, string>()
  for (const heading of ['### Shadows', '### Glow']) {
    for (const m of mdSection(md, heading).matchAll(/\|\s*([a-z-]+)\s*\|\s*`([^`]+)`\s*\|\s*`--shadow-[a-z-]+`\s*\|/g)) {
      shadowTokens.set((m[1] ?? '').trim(), (m[2] ?? '').trim())
    }
  }
  if (shadowTokens.size === 0) bail('parsed 0 shadow tokens')

  // --- 1h. Declared custom properties ---------------------------------------
  const cssVars = new Set<string>()
  for (const m of md.matchAll(/(--[a-z0-9-]+):\s*[^;]+;/g)) cssVars.add(m[1] ?? '')

  return {
    colors, byHex, byName, surfaces, matrix, ramps, aliases,
    fontSizes, allFontSizes, radii, shadowTokens, cssVars,
    monoProseRange, monoSteps, sizeNonExistence,
  }
}

// ─── 2. Parse tailwind.config.ts (the token -> class-name mapping) ────────────

/**
 * Reads the CLASS NAMES design.md's token values are reachable through. This is
 * a mapping layer, never a palette: a hex here that design.md does not account
 * for is drift, and RAMP_DRIFT reports it.
 */
export function parseTailwindConfig(configPath: string = TAILWIND_CONFIG): TailwindMap {
  const sf = ts.createSourceFile(
    configPath, fs.readFileSync(configPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  )

  const propName = (p: ts.ObjectLiteralElementLike): string | null => {
    const n = p.name
    if (n === undefined) return null
    // NumericLiteral matters: Tailwind scale stops are written `500: '#797d86'`,
    // so dropping numeric keys silently loses every `neutral-*` / `primary-*`
    // stop — i.e. exactly the remapped scales this check exists to resolve.
    return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null
  }

  const findObject = (key: string): ts.ObjectLiteralExpression | null => {
    let found: ts.ObjectLiteralExpression | null = null
    const visit = (node: ts.Node): void => {
      if (found !== null) return
      if (ts.isPropertyAssignment(node) && propName(node) === key && ts.isObjectLiteralExpression(node.initializer)) {
        found = node.initializer
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
  }

  /** Flattens `{ a: '#x', b: { DEFAULT: '#y', deep: '#z' } }` -> a, b, b-deep. */
  const flatten = (obj: ts.ObjectLiteralExpression, prefix: string, out: Map<string, string>): void => {
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue
      const name = propName(p)
      if (name === null) continue
      // `DEFAULT` collapses into its parent (`graphite: { DEFAULT }` -> `graphite`),
      // but a TOP-LEVEL `DEFAULT` (borderRadius, boxShadow) has no parent to
      // collapse into and must keep its own key — collapsing it to '' made every
      // bare `rounded` look like a class the config does not define.
      const key = name === 'DEFAULT' && prefix !== '' ? prefix : prefix === '' ? name : `${prefix}-${name}`
      const init = p.initializer
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) out.set(key, init.text)
      else if (ts.isObjectLiteralExpression(init)) flatten(init, key, out)
    }
  }

  const pick = (key: string): Map<string, string> => {
    const out = new Map<string, string>()
    const obj = findObject(key)
    if (obj !== null) flatten(obj, '', out)
    return out
  }

  const colorsRaw = pick('colors')
  const colors = new Map<string, string>()
  for (const [k, v] of colorsRaw) {
    const hex = normalizeHex(v)
    if (hex !== null) colors.set(k, hex)
  }
  if (colors.size === 0) {
    throw new Error(
      `${rel(configPath)}: parsed 0 colors from theme.extend.colors. The config layout changed — fix the ` +
        `parser in ${rel(__filename_)} rather than shipping a check that sanctions nothing.`,
    )
  }
  return { colors, radii: pick('borderRadius'), shadows: pick('boxShadow'), fontSizes: pick('fontSize') }
}

// ─── 3. Extract candidate class tokens from source ────────────────────────────

/** A run of class tokens that render together, with the condition they render under. */
export interface ClassGroup {
  readonly tokens: readonly string[]
  readonly cond: Cond
}

export interface ClassOccurrence {
  readonly file: string
  readonly line: number
  /** Raw whitespace-delimited token, variants and all. */
  readonly raw: string
  /** The branch condition of the literal this token came from. */
  readonly cond: Cond
  /** Every token in the same string literal — same branch by construction. */
  readonly siblings: readonly string[]
  /**
   * All class groups on the SAME element, each with its own branch condition.
   * Pairing across groups is only legal when their conditions are compatible.
   */
  readonly elementGroups: readonly ClassGroup[]
  /** Class groups of each enclosing JSX element, innermost first. */
  readonly ancestorGroups: readonly (readonly ClassGroup[])[]
  /** Tag name of each enclosing JSX element, innermost first (`div`, `Card`, …). */
  readonly ancestorTags: readonly string[]
  /** Local component name -> module specifier, for one-hop component resolution. */
  readonly imports: ReadonlyMap<string, string>
}

function walk(dir: string, out: string[], exts: readonly string[]): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.turbo') continue
      walk(p, out, exts)
    } else if (exts.some((e) => p.endsWith(e))) out.push(p)
  }
  return out
}

/**
 * Collects whitespace-delimited tokens from every STRING LITERAL in a .ts/.tsx
 * file, with exact line numbers.
 *
 * Literals rather than a raw-text grep, for two reasons that both bit the
 * earlier ad-hoc greps:
 *   - comments in this repo QUOTE the anti-patterns they warn about
 *     ("a `text-neutral-500` on a card surface"), so a text scan reports the
 *     warning as the violation. Literal nodes exclude comments by construction.
 *   - prose contains hyphenated words that look like utilities ("copy to
 *     clipboard" -> `to-clipboard`, "top-to-bottom"). Splitting on whitespace
 *     inside literals and then requiring a recognised utility family drops them.
 *
 * className is deliberately not special-cased: class strings live in exported
 * constant maps (`const STATUS_STYLE = { open: 'text-pewter …' }`) as often as
 * in JSX, and a check that only saw JSX attributes would miss exactly the shared
 * styling tables where one bad token does the most damage.
 */
function parseSource(file: string): { sf: ts.SourceFile; text: string } {
  const text = fs.readFileSync(file, 'utf8')
  return {
    text,
    sf: ts.createSourceFile(
      file, text, ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }
}

function isLiteralNode(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
  )
}

/**
 * The branch condition of `node` relative to `root`, accumulated by walking up.
 *
 * A literal inside `whenTrue` carries the condition; inside `whenFalse` it
 * carries its negation; inside the CONDITION itself it is unconditional. `&&`
 * and `??` right-hand sides are treated the same way, since they are the other
 * common way a class is applied conditionally.
 */
function condOfNode(node: ts.Node, root: ts.Node, sf: ts.SourceFile): Cond {
  const parts: Lit[] = []
  let cur: ts.Node = node
  while (cur !== root && cur.parent !== undefined) {
    const parent: ts.Node = cur.parent
    if (ts.isConditionalExpression(parent)) {
      const raw = parent.condition.getText(sf).replace(/\s+/g, ' ').trim()
      const c = condLiteralOf(parent.condition, sf)
      if (cur === parent.whenTrue) parts.push(...c)
      else if (cur === parent.whenFalse) parts.push(...negateCond(c, raw))
      // inside `parent.condition` itself: unconditional, add nothing
    } else if (ts.isBinaryExpression(parent) && cur === parent.right) {
      const op = parent.operatorToken.kind
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        parts.push(...condLiteralOf(parent.left, sf))
      } else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const raw = parent.left.getText(sf).replace(/\s+/g, ' ').trim()
        parts.push(...negateCond(condLiteralOf(parent.left, sf), raw))
      }
    }
    cur = parent
  }
  return parts
}

/** One group per string literal beneath `node`, each carrying its branch condition. */
function classGroupsUnder(node: ts.Node, sf: ts.SourceFile): ClassGroup[] {
  const out: ClassGroup[] = []
  const visit = (n: ts.Node): void => {
    if (isLiteralNode(n)) {
      const tokens = [...n.getText().matchAll(/[^\s'"`{}\\]+/g)].map((m) => m[0])
      if (tokens.length > 0) out.push({ tokens, cond: condOfNode(n, node, sf) })
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** The `className` groups declared directly on a JSX opening element. */
function classNameGroupsOf(open: ts.JsxOpeningLikeElement, sf: ts.SourceFile): ClassGroup[] {
  for (const attr of open.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue
    const name = attr.name.getText()
    if (name !== 'className' && name !== 'class') continue
    const init = attr.initializer
    return init === undefined ? [] : classGroupsUnder(init, sf)
  }
  return []
}

function tagNameOf(open: ts.JsxOpeningLikeElement): string {
  return open.tagName.getText()
}

export function extractClassOccurrences(file: string): ClassOccurrence[] {
  const { sf, text } = parseSource(file)
  const out: ClassOccurrence[] = []

  const imports = new Map<string, string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (clause === undefined) continue
    if (clause.name !== undefined) imports.set(clause.name.text, spec)
    const named = clause.namedBindings
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const el of named.elements) imports.set(el.name.text, spec)
    }
  }

  /** JSX elements enclosing the cursor, innermost first. */
  const stack: ts.JsxOpeningLikeElement[] = []

  const record = (node: ts.Node): void => {
    const start = node.getStart(sf)
    const slice = text.slice(start, node.getEnd())
    const tokens: { raw: string; offset: number }[] = []
    for (const m of slice.matchAll(/[^\s'"`{}\\]+/g)) {
      if (m.index === undefined) continue
      tokens.push({ raw: m[0], offset: m.index })
    }
    const siblings = tokens.map((t) => t.raw)
    const ancestors = [...stack].reverse()
    const ancestorGroups = ancestors.map((a) => classNameGroupsOf(a, sf))
    const ancestorTags = ancestors.map(tagNameOf)
    // Groups on THIS element. When the literal sits inside a className, that
    // attribute's groups are the alternatives it competes with; when it lives in
    // a shared style table there is no attribute, so the literal stands alone.
    const own = ancestorGroups[0] ?? []
    const inOwnClassName = own.some((g) => g.tokens.length === siblings.length && g.tokens.every((v, i) => v === siblings[i]))
    const cond = inOwnClassName
      ? (own.find((g) => g.tokens.every((v, i) => v === siblings[i]))?.cond ?? TRUE_COND)
      : TRUE_COND
    const elementGroups: ClassGroup[] = inOwnClassName ? own : [{ tokens: siblings, cond: TRUE_COND }]
    for (const t of tokens) {
      out.push({
        file: rel(file),
        line: sf.getLineAndCharacterOfPosition(start + t.offset).line + 1,
        raw: t.raw,
        cond,
        siblings,
        elementGroups,
        ancestorGroups,
        ancestorTags,
        imports,
      })
    }
  }

  const visit = (node: ts.Node): void => {
    if (isLiteralNode(node)) {
      record(node)
      return
    }
    if (ts.isJsxElement(node)) {
      stack.push(node.openingElement)
      ts.forEachChild(node, visit)
      stack.pop()
      return
    }
    if (ts.isJsxSelfClosingElement(node)) {
      stack.push(node)
      ts.forEachChild(node, visit)
      stack.pop()
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * The class tokens of the OUTERMOST JSX element in a component file that
 * declares a background. Used for one hop across a component boundary: text
 * inside `<Card>` sits on whatever Card's root element paints.
 *
 * Deliberately shallow — one hop, first background found. Deeper resolution
 * would need real type information and cross-file render-tree analysis, which
 * is well past what a CI gate should attempt. The failure mode of stopping here
 * is a MISSED violation, never a false one; see the ground-resolution limits in
 * the header.
 */
const rootBgCache = new Map<string, string[] | null>()
function rootBackgroundClassesOf(file: string): string[] | null {
  const cached = rootBgCache.get(file)
  if (cached !== undefined) return cached
  let result: string[] | null = null
  try {
    const { sf } = parseSource(file)
    const visit = (node: ts.Node): void => {
      if (result !== null) return
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const open = ts.isJsxElement(node) ? node.openingElement : node
        const tokens = classNameGroupsOf(open, sf).flatMap((g) => g.tokens)
        if (tokens.some((t) => splitAlpha(stripVariants(t)).base.startsWith('bg-'))) {
          result = tokens
          return
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  } catch {
    result = null
  }
  rootBgCache.set(file, result)
  return result
}

/** Resolves an import specifier to a file on disk, honouring the `@/` alias. */
function resolveModulePath(spec: string, fromFile: string, webRoot: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(webRoot, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return null
  for (const candidate of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// ─── 4. Class resolution ──────────────────────────────────────────────────────

// ─── Condition algebra (branch correlation) ───────────────────────────────────
//
// A className is not a set of classes; it is a set of ALTERNATIVE renderings.
//
//   cond ? 'bg-primary-900 text-whiteout' : 'bg-transparent text-neutral-500'
//
// Flattening that into one bag pairs `bg-primary-900` from the taken branch with
// `text-neutral-500` from the untaken one and reports a 3.01:1 contrast defect
// for a combination THAT CANNOT OCCUR AT RUNTIME. Twenty of this check's first
// twenty-five contrast findings were exactly that mistake.
//
// So every class literal carries the branch condition under which it renders,
// and two classes may only be paired when their conditions do not contradict.
// This mirrors the algebra in scripts/check-convex-refs.ts, which solved the
// structurally identical problem for conditional Convex args in the same cycle;
// it is duplicated rather than imported because that file is a different gate
// with its own lifecycle, and the algebra is generic logic, not shared policy.
//
// Deliberately tiny and sound-by-construction: a condition is a CONJUNCTION of
// literals, and anything it cannot represent degrades to an opaque atom that
// neither implies nor contradicts anything. Degrading always lands on
// "possible", never on a false claim of impossibility — an unrepresentable
// condition therefore costs a missed pairing, never an invented one.

interface Lit {
  readonly key: string
  readonly neg: boolean
}
type Cond = readonly Lit[]
const TRUE_COND: Cond = []

function condLiteralOf(expr: ts.Expression, sf: ts.SourceFile): Cond {
  const text = expr.getText(sf).replace(/\s+/g, ' ').trim()
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return [{ key: expr.operand.getText(sf).replace(/\s+/g, ' ').trim(), neg: true }]
  }
  return [{ key: text, neg: false }]
}

function negateCond(c: Cond, raw: string): Cond {
  const only = c.length === 1 ? c[0] : undefined
  return only === undefined ? [{ key: `!(${raw})`, neg: false }] : [{ key: only.key, neg: !only.neg }]
}

/**
 * Can these two classes ever render together? Only false when some condition is
 * asserted both ways — i.e. they sit on opposite sides of the same ternary.
 */
function compatible(a: Cond, b: Cond): boolean {
  return !a.some((x) => b.some((y) => y.key === x.key && y.neg !== x.neg))
}

function condText(c: Cond): string {
  if (c.length === 0) return 'always'
  return c.map((l) => (l.neg ? `!(${l.key})` : l.key)).join(' && ')
}

/** Strips responsive/state variants, `!important`, and a leading `-`. */
export function stripVariants(raw: string): string {
  let s = raw
  // Drop variants left-to-right, ignoring `:` inside [...] — arbitrary variants
  // and arbitrary values both use brackets (`[&>*]:text-x`, `text-[hsl(0,0%,0%)]`).
  for (;;) {
    let depth = 0
    let cut = -1
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i]
      if (c === '[') depth += 1
      else if (c === ']') depth -= 1
      else if (c === ':' && depth === 0) { cut = i; break }
    }
    if (cut === -1) break
    s = s.slice(cut + 1)
  }
  if (s.startsWith('!')) s = s.slice(1)
  if (s.startsWith('-')) s = s.slice(1)
  return s
}

/**
 * The variant chain a class is gated on: `hover:bg-x` -> 'hover', `bg-x` -> ''.
 * Two classes only describe the same rendered state when their variants agree,
 * or when the unprefixed one is not overridden in that state.
 */
export function variantOf(raw: string): string {
  const bare = stripVariants(raw)
  const idx = raw.length - bare.length
  return idx <= 0 ? '' : raw.slice(0, idx).replace(/[!:-]+$/, '')
}

/** `bg-primary-900/40` -> { base: 'bg-primary-900', alpha: '40' }. */
function splitAlpha(s: string): { base: string; alpha: string | null } {
  if (s.includes('[')) return { base: s, alpha: null } // `/` may live inside an arbitrary value
  const i = s.lastIndexOf('/')
  return i === -1 ? { base: s, alpha: null } : { base: s.slice(0, i), alpha: s.slice(i + 1) }
}

const COLOR_PREFIXES: readonly string[] = [
  'text', 'bg', 'border', 'ring-offset', 'ring', 'from', 'via', 'to', 'divide',
  'fill', 'stroke', 'outline', 'decoration', 'accent', 'caret', 'placeholder',
]

/**
 * Prefixes that put a token on screen as NORMAL-SIZE TEXT, and are therefore
 * subject to the 4.5:1 floor. `border-*`, `ring-*`, `fill-*`, `stroke-*` and
 * `divide-*` are deliberately absent: design.md's own Thresholds table puts
 * non-text UI boundaries, icons and dots on the 3:1 AA-large threshold, so
 * holding a red border or a status dot to the text floor would be a false
 * positive that teaches people to ignore this check.
 */
const TEXT_PREFIXES = new Set(['text', 'placeholder', 'decoration'])

/** Directional border/divide suffixes: `border-l-neutral-700` -> `neutral-700`. */
const DIRECTIONS = new Set(['t', 'r', 'b', 'l', 'x', 'y', 's', 'e'])

/**
 * Is this element rendered in the monospaced family?
 *
 * `font-mono` cascades, so an ancestor declaring it makes every descendant mono
 * unless one of them switches back. Walking outward from the element and taking
 * the first family declaration wins gets both cases right; looking only at the
 * element's own class list would silently miss mono text nested inside a mono
 * panel, which is the common shape in this app.
 */
function isMonoContext(occ: ClassOccurrence): boolean {
  const layers = [occ.siblings, ...occ.ancestorGroups.map((gs) => gs.flatMap((g) => g.tokens))]
  for (const layer of layers) {
    for (const t of layer) {
      const c = stripVariants(t)
      if (c === 'font-mono') return true
      if (c === 'font-sans' || c === 'font-serif') return false
    }
  }
  return false
}

type ColorValue =
  | { kind: 'token'; hex: string; className: string }
  | { kind: 'arbitrary'; hex: string | null; text: string }
  | { kind: 'system' }
  | { kind: 'cssvar'; name: string }
  | { kind: 'colorless' }
  | { kind: 'undefined-family'; family: string }
  | { kind: 'not-a-color' }

function resolveColorValue(value: string, tw: TailwindMap): ColorValue {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).replace(/^color:/, '').replace(/_/g, ' ').trim()
    if (CSS_SYSTEM_COLORS.has(inner.toLowerCase())) return { kind: 'system' }
    const varMatch = /^var\((--[a-z0-9-]+)/.exec(inner)
    if (varMatch !== null) return { kind: 'cssvar', name: varMatch[1] ?? '' }
    const hex = normalizeHex(inner)
    if (hex !== null) return { kind: 'arbitrary', hex, text: inner }
    if (/^(rgba?|hsla?|oklch|lab|color)\(/i.test(inner)) return { kind: 'arbitrary', hex: null, text: inner }
    return { kind: 'not-a-color' }
  }
  if (COLORLESS_KEYWORDS.has(value)) return { kind: 'colorless' }
  const hex = tw.colors.get(value)
  if (hex !== undefined) return { kind: 'token', hex, className: value }
  if (value === 'white') return { kind: 'token', hex: '#ffffff', className: 'white' }
  if (value === 'black') return { kind: 'token', hex: '#000000', className: 'black' }
  const family = value.split('-')[0] ?? ''
  if (TAILWIND_DEFAULT_COLOR_FAMILIES.includes(family)) return { kind: 'undefined-family', family }
  return { kind: 'not-a-color' }
}

// ─── 5. The analysis ──────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  readonly designMd?: string
  readonly tailwindConfig?: string
  readonly webRoot?: string
  readonly waivers?: readonly Waiver[]
}

export interface AnalyzeResult {
  /** design.md's own internal-consistency failures. */
  readonly docViolations: readonly Violation[]
  /** apps/web conformance failures. */
  readonly violations: readonly Violation[]
  readonly design: DesignSystem
  readonly tailwind: TailwindMap
  readonly filesScanned: number
  readonly classesInspected: number
  readonly unusedWaivers: readonly Waiver[]
  /**
   * Usage count of every numeric Tailwind ramp stop (`neutral-500`, …) across
   * apps/web, counted from the scan rather than from the violation list so a
   * stop is reported as unused only when it is genuinely absent. This is what
   * lets the check tell you when a stop has become bannable in ESLint, instead
   * of relying on someone noticing.
   */
  readonly stopUsage: ReadonlyMap<string, number>
}

export function analyze(options: AnalyzeOptions = {}): AnalyzeResult {
  const designPath = options.designMd ?? DESIGN_MD
  const configPath = options.tailwindConfig ?? TAILWIND_CONFIG
  const design = parseDesignSystem(designPath)
  const tailwind = parseTailwindConfig(configPath)
  const webRoot = options.webRoot ?? WEB_ROOT
  const waivers = options.waivers ?? WAIVERS

  const docViolations: Violation[] = []
  const stopUsage = new Map<string, number>()
  const raw: Violation[] = []
  const DOC = rel(designPath)

  // ── 5a. design.md internal consistency ─────────────────────────────────────

  // MATRIX_DRIFT — recompute every published cell. design.md calls the matrix
  // "the source of truth for every contrast decision"; if its numbers and the
  // formula disagree, every derived decision downstream is built on a number
  // nobody can reproduce.
  for (const cell of design.matrix) {
    const fg = design.byName.get(cell.fg)
    const bg = design.byName.get(cell.bg)
    if (fg?.hex === undefined || fg.hex === null || bg?.hex === undefined || bg.hex === null) continue
    const computed = contrastRatio(fg.hex, bg.hex)
    const rounded = Number(computed.toFixed(2))
    const label = wcagLabel(computed)
    if (Math.abs(rounded - cell.ratio) > 0.011 || label !== cell.label) {
      docViolations.push({
        code: 'MATRIX_DRIFT',
        file: DOC,
        line: 0,
        className: `${cell.fg} on ${cell.bg}`,
        detail:
          `design.md publishes ${cell.ratio.toFixed(2)} ${cell.label}; recomputed from ` +
          `${fg.hex} on ${bg.hex} it is ${rounded.toFixed(2)} ${label}.`,
        fix: `regenerate the matrix in ${DOC}. The published number is what every downstream decision cites.`,
      })
    }
  }

  // TEXT_ON_DRIFT — the `Text On` column is a pure contrast claim, so it must be
  // reproducible. (`Never Text On` is NOT checked in reverse: a token can be
  // barred from text for brand reasons too — Neon Glow clears AA everywhere and
  // is still barred from body copy by the Don'ts.)
  for (const token of design.colors) {
    if (token.hex === null) continue
    for (const groundName of token.textOn) {
      const ground = design.byName.get(groundName)
      if (ground?.hex === undefined || ground.hex === null) continue
      const ratio = contrastRatio(token.hex, ground.hex)
      if (ratio < AA_NORMAL) {
        docViolations.push({
          code: 'TEXT_ON_DRIFT',
          file: DOC,
          line: 0,
          className: `${token.name} Text On ${groundName}`,
          detail: `the token table sanctions ${token.name} as text on ${groundName}, but that pair is ${ratio.toFixed(2)}:1 — below the ${AA_NORMAL}:1 floor.`,
          fix: `remove ${groundName} from ${token.name}'s \`Text On\` column in ${DOC}, or change the token's value.`,
        })
      }
    }
  }

  // ALIAS_DRIFT — design.md's alias table is the bridge between token names and
  // the `neutral-*` spellings the codebase actually uses. If it drifts from the
  // config, the doc is teaching people the wrong mapping.
  for (const alias of design.aliases) {
    for (const cls of alias.classes) {
      const prefix = COLOR_PREFIXES.find((p) => cls.startsWith(`${p}-`))
      if (prefix === undefined) continue
      const resolved = resolveColorValue(cls.slice(prefix.length + 1), tailwind)
      const actual = resolved.kind === 'token' ? resolved.hex : null
      if (actual === null) {
        docViolations.push({
          code: 'ALIAS_DRIFT',
          file: DOC,
          line: 0,
          className: cls,
          detail: `design.md's alias table lists \`${cls}\` as ${alias.tokenName} ${alias.hex}, but ${rel(configPath)} defines no such color class.`,
          fix: `fix the alias table in ${DOC} or add the class to ${rel(configPath)}.`,
        })
      } else if (actual !== alias.hex) {
        docViolations.push({
          code: 'ALIAS_DRIFT',
          file: DOC,
          line: 0,
          className: cls,
          detail: `design.md's alias table claims \`${cls}\` is ${alias.tokenName} ${alias.hex}; ${rel(configPath)} actually resolves it to ${actual}.`,
          fix: `reconcile ${DOC} with ${rel(configPath)} — a wrong alias table is worse than none, because it is believed.`,
        })
      }
    }
  }

  // RAMP_DRIFT — every color the config can generate must be either a canonical
  // token or a ramp stop design.md's appendix accounts for. The appendix says it
  // exists "so the doc and the config are reconcilable"; this is that check.
  const rampDriftSeen = new Set<string>()
  for (const [cls, hex] of tailwind.colors) {
    if (design.byHex.has(hex) || design.ramps.has(hex) || rampDriftSeen.has(hex)) continue
    rampDriftSeen.add(hex)
    const others = [...tailwind.colors.entries()].filter(([, h]) => h === hex).map(([k]) => k)
    docViolations.push({
      code: 'RAMP_DRIFT',
      file: rel(configPath),
      line: 0,
      className: others.join(' / '),
      detail: `${rel(configPath)} defines ${hex} (${others.join(', ')}), which is neither one of design.md's ${design.colors.length} canonical tokens nor a stop listed in its "Derived Tailwind ramps" appendix.`,
      fix: `add the stop to that appendix table in ${DOC} (with its contrast note), or delete it from the config. ${cls} can otherwise render a color no document has ever sanctioned.`,
    })
  }

  // ── 5b. helpers over the parsed system ─────────────────────────────────────

  /**
   * Tokens design.md's own Role column disqualifies as a substitute. Read off
   * the document rather than listed here, so a Role rewrite moves the advice:
   *   - decorative-only tokens are never a component color;
   *   - tokens the Don'ts bar from body copy (Neon Glow) or reserve for
   *     icons/dots/borders (System Warning) are not text substitutes, even
   *     though both clear AA — suggesting them would trade a contrast defect
   *     for a brand-rule defect.
   */
  const decorativeOnly = (c: ColorToken): boolean => /decorative effect only/i.test(c.role)
  const barredFromCopy = (c: ColorToken): boolean =>
    /barred from body copy|reserve this token for/i.test(c.role) || c.textOn.length === 0

  const nearestToken = (hex: string, forText: boolean): ColorToken | null => {
    let best: ColorToken | null = null
    let bestD = Infinity
    for (const c of design.colors) {
      if (c.hex === null || c.hex === hex || decorativeOnly(c)) continue
      if (forText && barredFromCopy(c)) continue
      const d = colorDistance(hex, c.hex)
      if (d < bestD) { bestD = d; best = c }
    }
    return best
  }

  /** Nearest token that is a legitimate text color AND clears AA on every listed ground. */
  const suggestTextToken = (hex: string, grounds: readonly string[]): ColorToken | null => {
    let best: ColorToken | null = null
    let bestD = Infinity
    for (const c of design.colors) {
      if (c.hex === null || c.hex === hex || decorativeOnly(c) || barredFromCopy(c)) continue
      if (!grounds.every((g) => contrastRatio(c.hex ?? '#000000', g) >= AA_NORMAL)) continue
      const d = colorDistance(hex, c.hex)
      if (d < bestD) { bestD = d; best = c }
    }
    return best
  }

  /** The class that reaches a token by its design.md NAME, e.g. `text-pewter`. */
  const tokenClassFor = (prefix: string, token: ColorToken): string => {
    const wanted = token.name.toLowerCase().replace(/\s+/g, '-')
    for (const [cls, hex] of tailwind.colors) if (hex === token.hex && cls === wanted) return `${prefix}-${cls}`
    for (const [cls, hex] of tailwind.colors) if (hex === token.hex && !/^\w+-\d+$/.test(cls)) return `${prefix}-${cls}`
    return `${prefix}-<${token.name}>`
  }

  // ── ground resolution ──────────────────────────────────────────────────────
  //
  // Contrast is a property of a PAIR, so a text token on its own is not yet a
  // defect: design.md clears Ash on Blackout (5.09) and bars it on Graphite Deep
  // (4.39). A check that flagged every `text-ash` would condemn the sanctioned
  // nav links and page-ground table headers along with the real defects, and a
  // check people have to argue with is a check people turn off.
  //
  // So the ground is RESOLVED rather than presumed, in this order:
  //   1. a background on the same element (including variant states such as
  //      `hover:bg-*`, which manufacture their own ground on interaction);
  //   2. a background on an enclosing JSX element in the same file;
  //   3. one hop into an enclosing local component's root element;
  //   4. the ambient page ground painted by `body` in globals.css.
  // An opaque background occludes everything outside it. Translucent layers are
  // composited over whatever resolves behind them.

  interface Ground {
    readonly label: string
    readonly hex: string
    /** How the ground was established — quoted in the violation message. */
    readonly source: string
  }

  /** Ambient page ground: what `body` actually paints, read from the stylesheets. */
  const ambientGround = ((): Ground => {
    for (const css of walk(webRoot, [], ['.css'])) {
      const text = fs.readFileSync(css, 'utf8')
      const bodyRule = /(^|\})\s*body\s*\{([^}]*)\}/m.exec(text)
      const decl = bodyRule === null ? null : /background(?:-color)?\s*:\s*([^;]+);/.exec(bodyRule[2] ?? '')
      const hex = decl === null ? null : normalizeHex(decl[1] ?? '')
      if (hex !== null) {
        const token = design.byHex.get(hex)
        return {
          label: token?.name ?? hex,
          hex,
          source: `the ambient page ground — ${rel(css)} paints body ${hex}`,
        }
      }
    }
    const pageToken = design.colors.find((c) => c.hex !== null && /page background/i.test(c.role))
    return {
      label: pageToken?.name ?? 'unknown',
      hex: pageToken?.hex ?? '#000000',
      source: `the ambient page ground (design.md: "${pageToken?.role ?? 'page background'}")`,
    }
  })()

  /** Resolves a `bg-*` class token to a ground, or null when it paints nothing. */
  const groundOf = (token: string, via: string): { ground: Ground | null; translucent: boolean } => {
    const { base, alpha } = splitAlpha(stripVariants(token))
    if (!base.startsWith('bg-')) return { ground: null, translucent: false }
    const r = resolveColorValue(base.slice(3), tailwind)
    let hex: string | null = null
    if (r.kind === 'token') hex = r.hex
    else if (r.kind === 'arbitrary') hex = r.hex
    if (hex === null) return { ground: null, translucent: false } // transparent / system / unresolvable
    const named = design.byHex.get(hex)
    const ramp = design.ramps.get(hex)
    const label = named?.name ?? (ramp === undefined ? hex : `${ramp.stops} ${hex}`)
    return {
      ground: { label, hex, source: `\`${token}\` ${via}` },
      translucent: alpha !== null,
    }
  }

  /** Composites a translucent layer over the ground behind it. */
  const composite = (fg: string, alpha: number, behind: string): string => {
    const a = rgbOf(fg)
    const b = rgbOf(behind)
    const mix = a.map((v, i) => Math.round(v * alpha + (b[i] ?? 0) * (1 - alpha)))
    return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }

  /**
   * The grounds a given TEXT token can actually be rendered against.
   *
   * Two things make this more than "find a bg- class nearby", and getting
   * either wrong invents defects that cannot occur:
   *
   * BRANCHES. `cond ? 'bg-primary-900 text-whiteout' : 'bg-transparent
   * text-neutral-500'` never renders `bg-primary-900` with `text-neutral-500`.
   * Only groups whose condition is compatible with the text token's own branch
   * are eligible.
   *
   * STATES. `hover:bg-graphite-deep hover:text-cloud text-ash` never renders Ash
   * on Graphite Deep either: the variant that changes the fill changes the text
   * with it. So the pairing is done per RENDERED STATE — for each state, the
   * effective text is that state's override if it has one and the resting colour
   * otherwise, and likewise for the fill. A resting text colour is only paired
   * with a hover fill when the hover does NOT also set the text.
   */
  const resolveGrounds = (occ: ClassOccurrence, absFile: string): Ground[] => {
    const selfVariant = variantOf(occ.raw)

    // Groups on this element that can co-render with the text token.
    const eligible = occ.elementGroups.filter((g) => compatible(g.cond, occ.cond))

    const branchNote =
      occ.elementGroups.length > 1 && occ.cond.length > 0 ? ` on branch \`${condText(occ.cond)}\`` : ''

    const bgByVariant = new Map<string, { token: string; cond: Cond }[]>()
    const textVariants = new Set<string>()
    for (const g of eligible) {
      for (const t of g.tokens) {
        const b = splitAlpha(stripVariants(t)).base
        const v = variantOf(t)
        if (b.startsWith('bg-')) {
          const list = bgByVariant.get(v) ?? []
          list.push({ token: t, cond: g.cond })
          bgByVariant.set(v, list)
        } else if (b.startsWith('text-') && resolveColorValue(b.slice(5), tailwind).kind !== 'not-a-color') {
          textVariants.add(v)
        }
      }
    }

    // Which rendered states is THIS token the effective text colour in?
    const states: string[] =
      selfVariant !== ''
        ? [selfVariant]
        : ['', ...[...bgByVariant.keys()].filter((v) => v !== '' && !textVariants.has(v))]

    const grounds: Ground[] = []
    const seen = new Set<string>()
    const push = (g: Ground): void => {
      if (seen.has(g.hex)) return
      seen.add(g.hex)
      grounds.push(g)
    }

    for (const state of states) {
      const stateLabel = state === '' ? '' : ` in the \`${state}:\` state`
      // The fill for this state: the state's own bg if it sets one, else the base.
      const candidates = bgByVariant.get(state) ?? (state === '' ? [] : bgByVariant.get('') ?? [])
      let opaque: Ground | null = null
      const translucent: { token: string; hex: string; alpha: number }[] = []
      for (const c of candidates) {
        const { ground, translucent: isAlpha } = groundOf(c.token, `on this element${stateLabel}${branchNote}`)
        if (ground === null) continue
        if (isAlpha) {
          const a = Number(splitAlpha(stripVariants(c.token)).alpha ?? '100') / 100
          translucent.push({ token: c.token, hex: ground.hex, alpha: Number.isFinite(a) ? a : 1 })
        } else if (opaque === null) {
          opaque = ground
        }
      }

      // Nothing opaque on the element in this state — look outward.
      //
      // Ancestor conditions are correlated with this element's, NOT independent
      // of it. The pattern that proves it: a nav pill whose <Link> carries
      // `isActive ? 'bg-whiteout …' : 'bg-transparent …'` and whose count <span>
      // carries `isActive ? 'text-graphite-deep' : 'text-pewter'`. The same
      // `isActive` gates both, so Pewter can never land on the Whiteout fill —
      // and treating the ancestor's branches as independent reports exactly that
      // impossible pair. So ancestor groups are filtered by the same algebra.
      //
      // Two different components could coincidentally both name a condition
      // `isActive`; keying on source text would then over-suppress. That errs
      // toward missing a defect rather than inventing one, which is the same
      // direction as every other limitation here and the only acceptable one
      // for a blocking check.
      if (opaque === null) {
        const outer: { tokens: readonly string[]; via: string }[] = []
        occ.ancestorGroups.slice(1).forEach((groups, i) => {
          outer.push({
            tokens: groups.filter((g) => compatible(g.cond, occ.cond)).flatMap((g) => g.tokens),
            via: `on the enclosing <${occ.ancestorTags[i + 1] ?? '?'}>`,
          })
        })
        occ.ancestorTags.forEach((tag) => {
          if (!/^[A-Z]/.test(tag)) return
          const spec = occ.imports.get(tag.split('.')[0] ?? tag)
          if (spec === undefined) return
          const modPath = resolveModulePath(spec, absFile, webRoot)
          if (modPath === null) return
          const rootCls = rootBackgroundClassesOf(modPath)
          if (rootCls !== null) outer.push({ tokens: rootCls, via: `on <${tag}>'s root element (${rel(modPath)})` })
        })
        for (const layer of outer) {
          if (opaque !== null) break
          for (const t of layer.tokens) {
            if (variantOf(t) !== '') continue // a hover fill on an ancestor is that element's state, not this one's
            const { ground, translucent: isAlpha } = groundOf(t, layer.via)
            if (ground === null || isAlpha) continue
            opaque = ground
            break
          }
        }
      }

      const base = opaque ?? ambientGround
      push(base)
      for (const t of translucent) {
        push({
          label: `${t.token} over ${base.label}`,
          hex: composite(t.hex, t.alpha, base.hex),
          source: `\`${t.token}\` on this element${stateLabel}${branchNote}, composited over ${base.label}`,
        })
      }
    }
    return grounds
  }

  // ── 5c. scan apps/web ──────────────────────────────────────────────────────
  const sourceFiles = walk(webRoot, [], ['.ts', '.tsx'])
  let classesInspected = 0

  for (const file of sourceFiles) {
    for (const occ of extractClassOccurrences(file)) {
      const base = splitAlpha(stripVariants(occ.raw)).base
      const at = { file: occ.file, line: occ.line, className: occ.raw }

      // ---- radius ---------------------------------------------------------
      if (base === 'rounded' || base.startsWith('rounded-')) {
        classesInspected += 1
        const suffix = base === 'rounded' ? 'DEFAULT' : base.slice('rounded-'.length)
        const CORNERS = new Set(['t', 'r', 'b', 'l', 's', 'e', 'tl', 'tr', 'br', 'bl', 'ss', 'se', 'es', 'ee'])
        const parts = suffix.split('-')
        const key = parts.length > 1 && CORNERS.has(parts[0] ?? '') ? parts.slice(1).join('-') : suffix
        const arbitrary = /^\[(.+)\]$/.exec(key)
        const value = arbitrary !== null
          ? (arbitrary[1] ?? '').replace(/_/g, ' ')
          : tailwind.radii.get(key === '' || CORNERS.has(key) ? 'DEFAULT' : key)
        if (value === undefined) {
          raw.push({
            ...at,
            code: 'DEAD_CLASS',
            detail: `no borderRadius key '${key}' exists in ${rel(configPath)}, so this class generates no CSS at all.`,
            fix: `use one of: ${[...tailwind.radii.keys()].map((k) => (k === 'DEFAULT' ? 'rounded' : `rounded-${k}`)).join(', ')}.`,
          })
        } else if (!value.startsWith('var(') && !design.radii.has(value.trim())) {
          raw.push({
            ...at,
            code: 'OFF_SYSTEM_RADIUS',
            detail: `resolves to ${value.trim()}, which is not in design.md's Border Radius table (${[...design.radii].join(', ')}).`,
            fix: `design.md holds a strict shape dichotomy: 9999px for buttons (rounded-full), 4px for every other container.`,
          })
        }
        continue
      }

      // ---- shadow ---------------------------------------------------------
      if (base === 'shadow' || base.startsWith('shadow-')) {
        classesInspected += 1
        const key = base === 'shadow' ? 'DEFAULT' : base.slice('shadow-'.length)
        if (key === 'none') continue // removing a shadow is never elevation
        const sanctioned = [...design.shadowTokens.keys()]
        const arbitrary = /^\[(.+)\]$/.exec(key)
        if (arbitrary !== null) {
          const inner = (arbitrary[1] ?? '').replace(/_/g, ' ')
          const varMatch = /var\((--[a-z0-9-]+)\)/.exec(inner)
          if (varMatch !== null) {
            if (!design.cssVars.has(varMatch[1] ?? '')) {
              raw.push({
                ...at, code: 'ELEVATION_SHADOW',
                detail: `references ${varMatch[1] ?? ''}, which design.md does not declare.`,
                fix: `use a design.md shadow token: ${sanctioned.map((t) => `var(--shadow-${t})`).join(', ')}.`,
              })
            }
            continue
          }
          raw.push({
            ...at, code: 'ELEVATION_SHADOW',
            detail: `hard-codes a box-shadow value (${inner}).`,
            fix: `design.md: "Achieve depth by layering near-black surfaces, not with box-shadows." The only sanctioned shadows are ${sanctioned.map((t) => `shadow-[var(--shadow-${t})]`).join(', ')}.`,
          })
          continue
        }
        const configured = tailwind.shadows.get(key)
        if (configured === undefined) {
          const stock = ['sm', 'DEFAULT', 'md', 'lg', 'xl', '2xl', 'inner'].includes(key)
          raw.push({
            ...at,
            code: stock ? 'ELEVATION_SHADOW' : 'DEAD_CLASS',
            detail: stock
              ? `\`shadow-${key}\` is a stock Tailwind elevation shadow that ${rel(configPath)} does not define.`
              : `no boxShadow key '${key}' is defined in ${rel(configPath)}. This class generates NO CSS — the glow it looks like it applies is not rendering at all.`,
            fix: stock
              ? `depth is layered near-black surfaces; remove it.`
              : `write shadow-[var(--shadow-${key})] instead — design.md declares the custom property, but no Tailwind utility is generated for it.`,
          })
          continue
        }
        const declared = [...design.shadowTokens.values()].some((v) => v.replace(/\s+/g, '') === configured.replace(/\s+/g, ''))
        if (!declared) {
          raw.push({
            ...at, code: 'ELEVATION_SHADOW',
            detail: `resolves to "${configured}", which is not one of design.md's shadow tokens (${sanctioned.join(', ')}).`,
            fix: `use a design.md shadow token or remove the shadow.`,
          })
        }
        continue
      }

      // ---- font size ------------------------------------------------------
      if (base.startsWith('text-')) {
        const value = base.slice('text-'.length)
        const mono = isMonoContext(occ)
        const monoFamily = [...design.fontSizes.keys()].find((f) => f.includes('mono'))
        const sanctioned = mono && monoFamily !== undefined
          ? (design.fontSizes.get(monoFamily) ?? design.allFontSizes)
          : design.allFontSizes
        const scaleName = mono && monoFamily !== undefined ? `the ${monoFamily} scale` : "design.md's type scale"
        const scale = [...sanctioned].sort((a, b) => a - b)
        const nearest = (n: number): number => scale.reduce((p, c) => (Math.abs(c - n) < Math.abs(p - n) ? c : p), scale[0] ?? 0)

        /** Everything declared on this element and its ancestors. */
        const context = new Set<string>([
          ...occ.siblings.map(stripVariants),
          ...occ.ancestorGroups.flat().flatMap((g) => g.tokens).map(stripVariants),
        ])

        const checkSize = (px: number, label: string): void => {
          classesInspected += 1

          // 1. Off the scale entirely. design.md now carries explicit
          //    non-existence clauses ("Why 11px does not exist"), so this is a
          //    defect rather than merely undocumented — quote the clause.
          if (!sanctioned.has(px)) {
            const why = design.sizeNonExistence.get(px)
            raw.push({
              ...at, code: 'OFF_SCALE_TYPE',
              detail:
                `${label} is ${px}px, which is not on ${scaleName} (${scale.map((v) => `${v}px`).join(', ')}).` +
                (why === undefined ? '' : ` design.md: "${why}"`),
              fix: `use ${nearest(px)}px — or add the step to design.md's type scale first. design.md: "There is no fourth category."`,
            })
            return
          }
          if (!mono || design.monoProseRange === null) return

          // 2. On the scale, but outside the mono PROSE window. The size alone
          //    cannot settle this: 10px is correct for a wordmark and wrong for
          //    a date label. Where design.md gives a mechanical discriminator,
          //    use it; where it does not, say so rather than guess.
          const { min, max } = design.monoProseRange
          if (px >= min && px <= max) return
          const step = design.monoSteps.find((st) => st.size === px)
          const missing = (step?.requires ?? []).filter((r) => !context.has(r))

          if (step !== undefined && step.requires.length > 0) {
            if (missing.length === 0) return // requirements met — a sanctioned mark/metric
            raw.push({
              ...at, code: 'MONO_STEP_REQUIREMENT',
              detail:
                `${label} is the mono \`${step.step}\` ${px}px step, which design.md makes conditional: ` +
                `${missing.map((m) => `\`${m}\``).join(', ')} ${missing.length === 1 ? 'is' : 'are'} required and absent here ` +
                `(neither on this element nor on any enclosing one). Sanctioned for: ${step.sanctionedFor} Forbidden for: ${step.forbiddenFor}`,
              fix:
                `add ${missing.map((m) => `\`${m}\``).join(' and ')} if this really is ${step.step} — otherwise it is prose, and prose is ` +
                `floored at ${min}px and capped at ${max}px, so use a size in that range.`,
            })
            return
          }

          raw.push({
            ...at, code: 'MONO_RANGE_REVIEW',
            detail:
              `${label} is the mono \`${step?.step ?? '?'}\` ${px}px step, outside the ${min}–${max}px mono PROSE window. ` +
              `design.md sanctions it for marks only — ${step?.sanctionedFor ?? 'non-prose marks'} — and forbids it for ${step?.forbiddenFor ?? 'prose'} ` +
              `Whether this element is a mark or prose is NOT statically decidable: it depends on what the text says at runtime, ` +
              `and design.md gives no mechanical discriminator for this step.`,
            fix:
              `read the element. If it is a single word, digit or symbol read as a mark, it is correct as-is and needs no change. ` +
              `If a user reads it as language, it is drift — use ${min}px (the prose floor).`,
          })
        }

        const arbitrary = /^\[(.+)\]$/.exec(value)
        if (arbitrary !== null) {
          const pxs = [...(arbitrary[1] ?? '').matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
          if (pxs.length > 0) {
            for (const px of pxs) checkSize(px, `\`${base}\``)
            continue
          }
        }
        const namedPx = TAILWIND_DEFAULT_FONT_SIZES[value]
        if (namedPx !== undefined) {
          if (tailwind.fontSizes.size === 0) checkSize(namedPx, `\`text-${value}\``)
          continue
        }
      }

      // ---- color ----------------------------------------------------------
      const prefix = COLOR_PREFIXES.find((p) => base.startsWith(`${p}-`))
      if (prefix === undefined) continue
      let value = base.slice(prefix.length + 1)
      if (prefix === 'border' || prefix === 'divide') {
        const parts = value.split('-')
        if (parts.length > 1 && DIRECTIONS.has(parts[0] ?? '')) value = parts.slice(1).join('-')
      }
      const resolved = resolveColorValue(value, tailwind)
      // Count ramp-stop usage for every colour class, violation or not — the
      // ESLint ban list can only grow when a stop reaches genuinely zero uses.
      if (/^[a-z]+-\d{2,3}$/.test(value) && tailwind.colors.has(value)) {
        stopUsage.set(value, (stopUsage.get(value) ?? 0) + 1)
      }
      if (resolved.kind === 'not-a-color' || resolved.kind === 'colorless' || resolved.kind === 'system') continue
      classesInspected += 1

      if (resolved.kind === 'cssvar') {
        if (!design.cssVars.has(resolved.name)) {
          raw.push({
            ...at, code: 'ARBITRARY_COLOR',
            detail: `references custom property ${resolved.name}, which design.md does not declare.`,
            fix: `use a documented token, or declare the property in ${DOC} first.`,
          })
        }
        continue
      }

      // ---- contrast, before any question of spelling ------------------------
      //
      // Legibility is checked on the RESOLVED COLOUR, whatever spelling put it
      // there — token name, legacy alias, ramp stop or a raw `text-[#797d86]`.
      // Reporting the spelling first and returning would let the identical
      // colour escape the contrast check purely by being written differently,
      // which is the failure this whole file exists to prevent.
      const paintedHex = resolved.kind === 'token' || resolved.kind === 'arbitrary' ? resolved.hex : null
      if (TEXT_PREFIXES.has(prefix) && paintedHex !== null) {
        const known = design.byHex.get(paintedHex)
        const rampStop = design.ramps.get(paintedHex)
        const name = known?.name ?? (rampStop === undefined ? paintedHex : `${rampStop.stops} ${paintedHex}`)
        const failing = resolveGrounds(occ, file)
          .filter((g) => g.hex !== paintedHex)
          .map((g) => ({ g, ratio: contrastRatio(paintedHex, g.hex) }))
          .filter((x) => x.ratio < AA_NORMAL)
        if (failing.length > 0) {
          const worst = failing.reduce((a, b) => (a.ratio <= b.ratio ? a : b))
          const alt = suggestTextToken(paintedHex, failing.map((f) => f.g.hex))
          raw.push({
            ...at, code: 'SUB_AA_TEXT',
            site: `${worst.g.label} ${worst.ratio.toFixed(2)}:1 — ${worst.g.source}`,
            detail:
              `${name} (${paintedHex}) on ${worst.g.label} (${worst.g.hex}) is ${worst.ratio.toFixed(2)}:1 — below the ${AA_NORMAL}:1 floor. ` +
              `Ground resolved from ${worst.g.source}.` +
              (known === undefined
                ? ''
                : ` design.md's \`Never Text On\` for ${known.name}: ${known.neverTextOn.join(', ') || '(none listed)'}.`) +
              (failing.length > 1
                ? ` Also fails on ${failing.filter((f) => f !== worst).map((f) => `${f.g.label} ${f.ratio.toFixed(2)}:1`).join(', ')}.`
                : ''),
            fix: alt === null || alt.hex === null
              ? `use a token design.md sanctions as text on ${worst.g.label}.`
              : `use ${tokenClassFor(prefix, alt)} (${alt.name}, ${alt.hex}) — ${contrastRatio(alt.hex, worst.g.hex).toFixed(2)}:1 on ${worst.g.label}.`,
          })
          continue
        }
      }

      if (resolved.kind === 'undefined-family') {
        raw.push({
          ...at, code: 'OFF_PALETTE',
          detail: `\`${resolved.family}\` is a stock Tailwind color family. design.md's canonical palette is ${design.colors.length} tokens and none come from it.`,
          fix: `design.md: "Don't use saturated colors other than the primary brand green and the occasional red alert accent." Pick a canonical token.`,
        })
        continue
      }

      if (resolved.kind === 'arbitrary') {
        const token = resolved.hex === null ? undefined : design.byHex.get(resolved.hex)
        if (token !== undefined) {
          raw.push({
            ...at, code: 'ARBITRARY_COLOR',
            detail: `hard-codes ${resolved.text}, which is the ${token.name} token spelled as a literal — so it silently stops tracking design.md the moment the token's value changes.`,
            fix: `use ${tokenClassFor(prefix, token)}.`,
          })
        } else {
          const near = resolved.hex === null ? null : nearestToken(resolved.hex, TEXT_PREFIXES.has(prefix))
          raw.push({
            ...at, code: 'ARBITRARY_COLOR',
            detail: `hard-codes ${resolved.text}, which is not a canonical design.md token${near === null ? '' : ` (nearest: ${near.name} ${near.hex ?? ''})`}.`,
            fix: near === null
              ? `replace it with a canonical token.`
              : `use ${tokenClassFor(prefix, near)} (${near.name}, ${near.hex ?? ''}) — or add this color to design.md's token table first.`,
          })
        }
        continue
      }

      // resolved.kind === 'token' — resolve the HEX to a canonical token. This
      // is the step that makes `text-neutral-500`, `text-ash` and
      // `text-[#797d86]` one finding under three spellings.
      const token = design.byHex.get(resolved.hex)

      if (token === undefined) {
        const ramp = design.ramps.get(resolved.hex)
        const near = nearestToken(resolved.hex, TEXT_PREFIXES.has(prefix))
        if (ramp !== undefined) {
          raw.push({
            ...at, code: 'DERIVED_RAMP',
            detail: `${resolved.hex} is a derived ramp stop (${ramp.stops}${ramp.note === '' ? '' : ` — ${ramp.note}`}). design.md's appendix: these "are not an expansion of the palette and must not be reached for in new work".`,
            fix: near === null
              ? `use a canonical token.`
              : `use ${tokenClassFor(prefix, near)} (${near.name}, ${near.hex ?? ''}) — the nearest canonical token.`,
          })
        } else {
          raw.push({
            ...at, code: 'OFF_PALETTE',
            detail: `resolves to ${resolved.hex} via ${rel(configPath)}, and ${resolved.hex} is in neither design.md's canonical palette nor its documented ramp appendix.`,
            fix: near === null
              ? `use a canonical token.`
              : `nearest canonical token is ${near.name} (${near.hex ?? ''}) -> ${tokenClassFor(prefix, near)}. If this shade is genuinely needed, add it to ${DOC} FIRST — design.md is authoritative, tailwind.config.ts is only the mapping.`,
          })
        }
        continue
      }

      // The hex is canonical and the pairing is either legible or unprovable —
      // contrast was checked above, on the RESOLVED COLOUR, so that an alias or
      // an arbitrary-hex spelling cannot dodge it. The remaining question is
      // only whether the colour is reached by its own token name.
      const canonical = token.name.toLowerCase().replace(/\s+/g, '-')
      if (resolved.className !== canonical) {
        raw.push({
          ...at, code: 'ALIAS_SPELLING',
          detail: `\`${resolved.className}\` resolves to ${token.name} (${token.hex ?? ''}) only through ${rel(configPath)}'s remapped legacy scale — the class name gives no hint which token it is.`,
          fix: `use ${tokenClassFor(prefix, token)}. design.md's "Tailwind alias trap" section exists because this spelling is how the sub-AA Ash token spread across the app under the name \`neutral-500\`.`,
        })
      }
    }
  }

  // ── 5d. hex literals in stylesheets ────────────────────────────────────────
  for (const file of walk(webRoot, [], ['.css'])) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((lineText, i) => {
      // A `--color-x: #hex` line IS the mapping of design.md into CSS, not a use
      // of a raw color; skip the declarations and check the usages.
      if (/^\s*--[a-z0-9-]+\s*:/.test(lineText)) return
      for (const m of lineText.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        const hex = normalizeHex(m[0])
        if (hex === null || design.byHex.has(hex)) continue
        const ramp = design.ramps.get(hex)
        const near = nearestToken(hex, false)
        raw.push({
          file: rel(file), line: i + 1, className: m[0], code: 'CSS_OFF_PALETTE',
          detail: `raw hex ${m[0]} is not a canonical design.md token${ramp === undefined ? '' : ` (it is the derived ramp stop ${ramp.stops})`}.`,
          fix: near === null
            ? `use a canonical token.`
            : `use var(${near.cssVar}) (${near.name}, ${near.hex ?? ''}) or add this color to ${DOC} first.`,
        })
      }
    })
  }

  // ── 5e. waivers ────────────────────────────────────────────────────────────
  const used = new Set<number>()
  const violations = raw.filter((v) => {
    const idx = waivers.findIndex(
      (w) =>
        w.code === v.code &&
        w.className === stripVariants(v.className) &&
        // `file` is matched as a repo-relative path or a suffix of one, so a
        // waiver reads the same way whether it names a full path or the tail.
        (w.file === undefined || w.file === v.file || v.file.endsWith(`/${w.file}`)),
    )
    if (idx === -1) return true
    used.add(idx)
    return false
  })

  return {
    docViolations,
    violations,
    design,
    tailwind,
    filesScanned: sourceFiles.length,
    classesInspected,
    unusedWaivers: waivers.filter((_, i) => !used.has(i)),
    stopUsage,
  }
}

// ─── 6. Enforcement tiers and the ratchet ─────────────────────────────────────

/**
 * How each violation code is enforced.
 *
 *   'block'   any occurrence fails CI, starting now.
 *   'frozen'  fails only if the count rises above the committed baseline in
 *             scripts/design-token-baseline.json. A ratchet, not a waiver: new
 *             violations are blocked immediately, the debt is a visible number
 *             in a committed file, and the number may only ever go down.
 *   'report'  never fails. Reserved for findings that are an open question for
 *             design.md rather than a defect in the code.
 *
 * ANY CODE NOT LISTED HERE DEFAULTS TO 'block'. That default is deliberate: a
 * newly added check must fail loudly rather than slip in as unenforced, and a
 * code sitting at zero today (OFF_PALETTE, DEAD_CLASS, CSS_OFF_PALETTE) must
 * stay at zero without anyone having to remember to promote it.
 */
export const TIERS: Partial<Record<ViolationCode, 'block' | 'frozen' | 'report'>> = {
  // ── Tier 2: frozen at count, needs its own remediation cycle ──
  // ~1,125 usages across 82 files. Every one is a mechanical spelling swap, but
  // there are too many to land alongside anything else, and the only way to
  // make them pass today would be a blanket disable — which would destroy the
  // signal permanently. Frozen instead: the count may fall, never rise.
  ALIAS_SPELLING: 'frozen',
  DERIVED_RAMP: 'frozen',

  // ── Tier 3: report only, pending a design.md decision ──
  // Every occurrence is a `font-mono` element, and design.md's Geist Mono size
  // list stops at 20px while the product ships mono numerals at 24/40/64px and
  // mono labels at 10/11/13px. Whether the scale is wrong or the components
  // are is a question for the design owner, not a defect the web team can fix
  // by guessing. Failing CI on an unanswered question trains people to ignore
  // the check.
  // OFF_SCALE_TYPE is Tier 1 (the default): design.md now carries explicit
  // non-existence clauses for 11px and 13px and closes with "There is no fourth
  // category", so an off-scale size is a defect, not an open question.
  //
  // MONO_RANGE_REVIEW is the honest third outcome. A mono size outside the
  // 12-20px prose window is sanctioned for marks and forbidden for prose, and
  // which one an element is depends on what its text SAYS — not on anything in
  // its class list. Flagging the legitimate wordmarks and ordinal badges would
  // train people to ignore the check; passing real 10px prose would defeat it.
  // So it reports and never fails, and the reader is asked to look.
  MONO_RANGE_REVIEW: 'report',
}

export const tierOf = (code: ViolationCode): 'block' | 'frozen' | 'report' => TIERS[code] ?? 'block'

/**
 * Printed on EVERY run, including clean ones. Kept as an exported constant, and
 * pinned by tests/unit/design_tokens.test.ts, specifically so it cannot be
 * trimmed as noise later: it is the difference between a tool people trust
 * correctly and one they trust blindly. A green SUB_AA_TEXT result means no
 * contrast defect was PROVABLE, and the ways it can fail to prove one are
 * ordinary and common.
 */
/**
 * The symmetric statement to GROUND_RESOLUTION_NOTICE, and the more important
 * of the two.
 *
 * That notice is about false NEGATIVES — what this check can fail to prove. This
 * one is about false POSITIVES: what it can wrongly ASSERT. The asymmetry
 * matters because the consequences are not symmetric. A missed defect costs one
 * defect. A confidently wrong defect costs the whole check: it gets argued with,
 * then ignored, then disabled, and after that it catches nothing at all.
 *
 * This is not hypothetical here. The first version of this check reported 25
 * contrast defects and 20 of them were impossible — it merged mutually
 * exclusive ternary branches and paired a background from the taken branch with
 * a text colour from the untaken one. It was one hand audit away from being
 * switched off permanently. Both statements print on every run.
 */
export const FALSE_POSITIVE_NOTICE =
  '  caveat:   contrast findings assert a text/ground PAIR actually renders. That is inference, and it can be\n' +
  '            wrong. Branch correlation is textual: classes on opposite sides of one ternary are never paired,\n' +
  '            and neither are a resting text colour and a hover fill when the hover also sets the text — but\n' +
  '            two conditions that are equivalent while written differently (`isActive` vs `!isInactive`) are\n' +
  '            treated as independent, and this check cannot see a condition it cannot read. If a finding\n' +
  '            describes a state you do not believe can occur, it may be right that it cannot: report it.'

export const GROUND_RESOLUTION_NOTICE =
  '  note:     contrast is only checked where the GROUND can be resolved — same element (including\n' +
  '            hover/focus fills), an enclosing element, one hop into a component root, or the ambient\n' +
  '            page ground. A surface painted further away resolves to the page ground, the most\n' +
  '            forgiving in the system, so this check UNDER-REPORTS. "No SUB_AA_TEXT" means no defect\n' +
  '            was provable, not that the contrast is correct.'

/**
 * The build verdict, as a pure function of what was found. Exported so the
 * exit-code semantics of each tier are testable rather than implied by the
 * shape of main().
 */
export function verdict(input: {
  readonly violations: readonly Violation[]
  readonly docViolations: readonly Violation[]
  readonly unusedWaivers: readonly Waiver[]
  readonly ratchet: readonly RatchetEntry[]
}): { readonly failed: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = []
  const blocking = input.violations.filter((v) => tierOf(v.code) === 'block')
  if (input.docViolations.length > 0) reasons.push(`${input.docViolations.length} document-level inconsistency`)
  if (blocking.length > 0) reasons.push(`${blocking.length} Tier 1 (blocking) violation(s)`)
  for (const r of input.ratchet) {
    if (r.grown.length > 0) reasons.push(`${r.code} rose above its baseline (${r.baseline} → ${r.actual})`)
  }
  if (input.unusedWaivers.length > 0) reasons.push(`${input.unusedWaivers.length} waiver(s) suppressing nothing`)
  return { failed: reasons.length > 0, reasons }
}

const BASELINE_FILE = path.join(REPO_ROOT, 'scripts/design-token-baseline.json')

export interface Baseline {
  readonly frozen: Readonly<Record<string, { readonly total: number; readonly classes: Readonly<Record<string, number>> }>>
}

export function loadBaseline(file: string = BASELINE_FILE): Baseline {
  if (!fs.existsSync(file)) {
    // A missing baseline must not silently disable the ratchet — with no
    // recorded counts, every frozen code would read as "no increase" forever.
    throw new Error(
      `${rel(file)} is missing. The frozen-count ratchet cannot run without it. ` +
        `Regenerate it with: pnpm tsx scripts/check-design-tokens.ts --write-baseline`,
    )
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  const frozen = (parsed as { frozen?: Baseline['frozen'] }).frozen
  if (frozen === undefined) throw new Error(`${rel(file)}: missing top-level "frozen" object.`)
  return { frozen }
}

export interface RatchetEntry {
  readonly code: ViolationCode
  readonly baseline: number
  readonly actual: number
  /** Classes whose count rose above baseline (a brand-new class has baseline 0). */
  readonly grown: readonly { readonly className: string; readonly baseline: number; readonly actual: number }[]
  /** Classes whose count fell — the baseline should be lowered in the same commit. */
  readonly shrunk: readonly { readonly className: string; readonly baseline: number; readonly actual: number }[]
}

/**
 * Compares the frozen codes against the committed baseline.
 *
 * A rise fails. A fall does NOT fail — it prints, loudly, with an instruction to
 * lower the baseline in the same commit. Failing on a decrease would break CI
 * for the very commit that improves things, which is how ratchets get deleted.
 * A stale-high baseline cannot hide: the delta is printed on every single run.
 */
export function evaluateRatchet(violations: readonly Violation[], baseline: Baseline): RatchetEntry[] {
  const out: RatchetEntry[] = []
  const codes = new Set<string>([
    ...Object.keys(baseline.frozen),
    ...violations.filter((v) => tierOf(v.code) === 'frozen').map((v) => v.code),
  ])
  for (const code of [...codes].sort()) {
    const base = baseline.frozen[code] ?? { total: 0, classes: {} }
    const actual = violations.filter((v) => v.code === code)
    const actualByClass = new Map<string, number>()
    for (const v of actual) {
      const k = stripVariants(v.className)
      actualByClass.set(k, (actualByClass.get(k) ?? 0) + 1)
    }
    const grown: RatchetEntry['grown'] = [...actualByClass.entries()]
      .filter(([k, n]) => n > (base.classes[k] ?? 0))
      .map(([k, n]) => ({ className: k, baseline: base.classes[k] ?? 0, actual: n }))
      .sort((a, b) => b.actual - b.baseline - (a.actual - a.baseline))
    const shrunk: RatchetEntry['shrunk'] = Object.entries(base.classes)
      .filter(([k, n]) => (actualByClass.get(k) ?? 0) < n)
      .map(([k, n]) => ({ className: k, baseline: n, actual: actualByClass.get(k) ?? 0 }))
      .sort((a, b) => b.baseline - b.actual - (a.baseline - a.actual))
    out.push({ code: code as ViolationCode, baseline: base.total, actual: actual.length, grown, shrunk })
  }
  return out
}

/**
 * The `_README` block from the existing baseline file, preserved verbatim
 * across regeneration. JSON has no comments, and a numbers-only file gives a
 * future reader no way to tell a ratchet from a rubber stamp.
 */
function readBaselineDoc(): Record<string, unknown> {
  if (!fs.existsSync(BASELINE_FILE)) return {}
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as Record<string, unknown>
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'frozen'))
}

/** Serialises the current counts into the baseline file's shape. */
function baselineFrom(violations: readonly Violation[]): Baseline {
  const frozen: Record<string, { total: number; classes: Record<string, number> }> = {}
  for (const v of violations) {
    if (tierOf(v.code) !== 'frozen') continue
    const entry = (frozen[v.code] ??= { total: 0, classes: {} })
    const k = stripVariants(v.className)
    entry.total += 1
    entry.classes[k] = (entry.classes[k] ?? 0) + 1
  }
  for (const entry of Object.values(frozen)) {
    entry.classes = Object.fromEntries(Object.entries(entry.classes).sort((a, b) => b[1] - a[1]))
  }
  return { frozen }
}

/**
 * Ramp stops that have reached zero usage and are therefore ready to be banned
 * outright in .eslintrc.js.
 *
 * The ban list is read out of the real ESLint config and its own regex is used
 * for the membership test, so this can never drift from what ESLint actually
 * enforces. This is the mechanism that makes the tool drive its own
 * remediation: as the frozen counts fall, the check names the stops that have
 * become bannable instead of waiting for someone to notice.
 */
export function bannableStops(stopUsage: ReadonlyMap<string, number>, tailwind: TailwindMap): string[] {
  let banned: RegExp[] = []
  try {
    const require_ = createRequire(import.meta.url)
    const config = require_(path.join(REPO_ROOT, '.eslintrc.js')) as {
      rules?: Record<string, unknown>
    }
    const rule = config.rules?.['no-restricted-syntax']
    const entries = Array.isArray(rule) ? rule.slice(1) : []
    for (const e of entries) {
      const selector = (e as { selector?: string }).selector ?? ''
      const m = /\[[\w.]+=\/(.*)\/\]$/.exec(selector)
      if (m !== null && m[1] !== undefined) banned.push(new RegExp(m[1]))
    }
  } catch {
    banned = []
  }
  const stops = [...tailwind.colors.keys()].filter((k) => /^[a-z]+-\d{2,3}$/.test(k))
  return stops
    .filter((stop) => (stopUsage.get(stop) ?? 0) === 0)
    .filter((stop) => !banned.some((re) => re.test(`text-${stop}`)))
    .sort()
}

// ─── 7. Reporting ─────────────────────────────────────────────────────────────

const HEADLINE: Record<ViolationCode, string> = {
  MATRIX_DRIFT: 'Published contrast ratio does not match the recomputed value',
  TEXT_ON_DRIFT: '`Text On` sanctions a pair that is below AA',
  ALIAS_DRIFT: 'Alias table disagrees with tailwind.config.ts',
  RAMP_DRIFT: 'Config defines a color no design.md table accounts for',
  SUB_AA_TEXT: 'Text token below WCAG AA 4.5:1 on a sanctioned ground',
  DEAD_CLASS: 'Class generates no CSS (silently does nothing)',
  OFF_PALETTE: 'Color outside design.md’s canonical palette',
  DERIVED_RAMP: 'Derived ramp stop — explicitly not a palette token',
  ARBITRARY_COLOR: 'Arbitrary color value (bypasses the token layer)',
  OFF_SCALE_TYPE: 'Font size off design.md’s type scale',
  MONO_RANGE_REVIEW: 'Mono size outside the prose window — prose vs mark not statically decidable',
  MONO_STEP_REQUIREMENT: 'Mono step used without the class design.md makes mandatory on it',
  ELEVATION_SHADOW: 'Box-shadow where design.md forbids it',
  OFF_SYSTEM_RADIUS: 'Radius outside the 4px / 9999px system',
  CSS_OFF_PALETTE: 'Raw off-palette hex in a stylesheet',
  ALIAS_SPELLING: 'Canonical token reached by its legacy alias spelling',
}

const DOC_ORDER: readonly ViolationCode[] = ['MATRIX_DRIFT', 'TEXT_ON_DRIFT', 'ALIAS_DRIFT', 'RAMP_DRIFT']
const CODE_ORDER: readonly ViolationCode[] = [
  'SUB_AA_TEXT', 'DEAD_CLASS', 'OFF_PALETTE', 'DERIVED_RAMP', 'ARBITRARY_COLOR',
  'OFF_SCALE_TYPE', 'MONO_STEP_REQUIREMENT', 'ELEVATION_SHADOW', 'OFF_SYSTEM_RADIUS',
  'CSS_OFF_PALETTE', 'ALIAS_SPELLING', 'MONO_RANGE_REVIEW',
]

function groupBy(list: readonly Violation[]): Map<ViolationCode, Violation[]> {
  const m = new Map<ViolationCode, Violation[]>()
  for (const v of list) {
    const arr = m.get(v.code)
    if (arr === undefined) m.set(v.code, [v])
    else arr.push(v)
  }
  return m
}

function printGroup(list: readonly Violation[], codes: readonly ViolationCode[], showAll: boolean): void {
  const byCode = groupBy(list)
  for (const code of codes) {
    const items = byCode.get(code)
    if (items === undefined) continue
    console.log(`${BOLD}${CYAN}━━ ${code} — ${HEADLINE[code]} (${items.length})${RESET}`)
    // Keyed by the FULL diagnosis, not just the class name: two sites share a
    // heading only when the `problem:` and `fix:` lines are true for BOTH.
    const byClass = new Map<string, Violation[]>()
    for (const v of items) {
      const key = `${stripVariants(v.className)}\u0000${v.detail}\u0000${v.fix}`
      const arr = byClass.get(key)
      if (arr === undefined) byClass.set(key, [v])
      else arr.push(v)
    }
    for (const [key, occs] of [...byClass.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const first = occs[0]
      if (first === undefined) continue
      const cls = key.split('\u0000')[0] ?? ''
      console.log(`\n  ${RED}✗ ${BOLD}${cls}${RESET}${RED}${occs.length > 1 ? ` ×${occs.length}` : ''}${RESET}`)
      console.log(`    problem: ${first.detail}`)
      console.log(`    fix:     ${first.fix}`)
      const shown = showAll ? occs : occs.slice(0, 5)
      for (const o of shown) {
        const where = o.site === undefined ? '' : `  ${DIM}→ ${o.site}${RESET}`
        console.log(`      ${DIM}${o.file}${o.line > 0 ? `:${o.line}` : ''}${RESET}  ${o.className}${where}`)
      }
      if (occs.length > shown.length) {
        console.log(`      ${DIM}… and ${occs.length - shown.length} more (run with --all)${RESET}`)
      }
    }
    console.log('')
  }
}

function main(): number {
  const showAll = process.argv.includes('--all')
  const result = analyze()
  const { design, tailwind, docViolations, violations } = result

  if (process.argv.includes('--tokens')) {
    console.log(`${BOLD}Canonical tokens parsed from ${rel(DESIGN_MD)}${RESET}`)
    for (const c of design.colors) {
      const kind = [c.isTextGround ? 'ground' : c.isSurface ? 'surface' : '', c.textOn.length > 0 ? 'text' : '']
        .filter(Boolean).join('+')
      console.log(
        `  ${(c.hex ?? '(gradient)').padEnd(11)} ${c.name.padEnd(15)} ${(kind || '-').padEnd(13)}` +
          ` textOn=[${c.textOn.join(', ')}]  never=[${c.neverTextOn.join(', ')}]`,
      )
    }
    console.log(`\n  surfaces: ${design.surfaces.join(', ')}`)
    console.log(`  matrix:   ${design.matrix.length} cells`)
    console.log(`  ramps:    ${design.ramps.size} documented derived stops`)
    console.log(`  aliases:  ${design.aliases.length} rows`)
    console.log(`  radii:    ${[...design.radii].join(', ')}`)
    console.log(`  shadows:  ${[...design.shadowTokens.keys()].join(', ')}`)
    for (const [fam, sizes] of design.fontSizes) {
      console.log(`  sizes[${fam}]: ${[...sizes].sort((a, b) => a - b).map((s) => `${s}px`).join(', ')}`)
    }
    console.log(`\n${BOLD}${rel(TAILWIND_CONFIG)}${RESET}: ${tailwind.colors.size} color classes, ${tailwind.radii.size} radii, ${tailwind.shadows.size} shadows`)
    return 0
  }

  if (process.argv.includes('--write-baseline')) {
    // Regenerating is only ever legitimate when the counts went DOWN. Writing a
    // higher number is the one edit that is never correct, so it is refused
    // here rather than left to review to catch.
    const current = baselineFrom(violations)
    const previous = fs.existsSync(BASELINE_FILE) ? loadBaseline() : { frozen: {} }
    // A code with no entry yet is being recorded for the first time, which is
    // the only way a baseline can ever be established. A code that ALREADY has
    // an entry may only go down. Deleting an entry to "reset" it is not a way
    // around this: evaluateRatchet treats a missing entry as 0, so the very
    // next run fails on every occurrence.
    const raised = Object.entries(current.frozen).filter(
      ([code, e]) => previous.frozen[code] !== undefined && e.total > (previous.frozen[code]?.total ?? 0),
    )
    if (raised.length > 0) {
      console.error(
        `${RED}Refusing to write a HIGHER baseline for: ${raised.map(([c, e]) => `${c} ${previous.frozen[c]?.total ?? 0} → ${e.total}`).join(', ')}.${RESET}\n` +
          `${YELLOW}This file is a ratchet. Remove the new violations instead; raising the number is never the fix.${RESET}`,
      )
      return 1
    }
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...readBaselineDoc(), ...current }, null, 2)}\n`)
    console.log(`${GREEN}Wrote ${rel(BASELINE_FILE)}${RESET}`)
    for (const [code, e] of Object.entries(current.frozen)) {
      console.log(`  ${code}: ${previous.frozen[code]?.total ?? 0} → ${e.total}`)
    }
    return 0
  }

  const baseline = loadBaseline()

  console.log(`${BOLD}Design-token conformance (design.md → apps/web)${RESET}`)
  console.log(
    `${DIM}  palette:  ${design.colors.length} canonical tokens + ${design.ramps.size} documented ramp stops, parsed from ${rel(DESIGN_MD)}` +
      `\n            (this script hard-codes no palette, no size list and no contrast ratio)` +
      `\n  mapping:  ${tailwind.colors.size} color classes from ${rel(TAILWIND_CONFIG)}, resolved by VALUE so alias spellings cannot hide` +
      `\n  scanned:  ${result.filesScanned} files under ${rel(WEB_ROOT)}, ${result.classesInspected} design-bearing classes inspected` +
      `\n  matrix:   ${design.matrix.length} published cells recomputed from the sRGB luminance formula${RESET}`,
  )
  console.log(`${YELLOW}${GROUND_RESOLUTION_NOTICE}${RESET}`)
  console.log(`${YELLOW}${FALSE_POSITIVE_NOTICE}${RESET}`)
  console.log('')

  if (process.argv.includes('--matrix')) {
    console.log(`${BOLD}Recomputed contrast matrix${RESET} ${DIM}(computed here, cross-checked against design.md)${RESET}`)
    for (const cell of design.matrix) {
      const fg = design.byName.get(cell.fg)
      const bg = design.byName.get(cell.bg)
      if (fg?.hex == null || bg?.hex == null) continue
      const r = contrastRatio(fg.hex, bg.hex)
      const ok = Math.abs(Number(r.toFixed(2)) - cell.ratio) <= 0.011 && wcagLabel(r) === cell.label
      console.log(
        `  ${ok ? GREEN + '✓' : RED + '✗'}${RESET} ${r.toFixed(2).padStart(6)}:1 ${wcagLabel(r).padEnd(9)}` +
          ` ${cell.fg} on ${cell.bg}${ok ? '' : `${RED}  doc says ${cell.ratio.toFixed(2)} ${cell.label}${RESET}`}`,
      )
    }
    console.log('')
  }


  if (docViolations.length > 0) {
    console.log(`${RED}${BOLD}✗ ${docViolations.length} internal inconsistency in ${rel(DESIGN_MD)} / ${rel(TAILWIND_CONFIG)}${RESET}`)
    console.log(`${DIM}  These are fixed in the DOCUMENT, not in the components. design.md is authoritative;`)
    console.log(`  where it contradicts itself or the config, every downstream decision inherits the error.${RESET}\n`)
    printGroup(docViolations, DOC_ORDER, showAll)
  }

  // ── Tier 1: blocking ───────────────────────────────────────────────────────
  const blocking = violations.filter((v) => tierOf(v.code) === 'block')
  const frozen = violations.filter((v) => tierOf(v.code) === 'frozen')
  const reportOnly = violations.filter((v) => tierOf(v.code) === 'report')

  const summarise = (items: readonly Violation[], order: readonly ViolationCode[]): void => {
    const byCode = groupBy(items)
    for (const code of order) {
      const list = byCode.get(code)
      if (list === undefined) continue
      const classes = new Set(list.map((v) => stripVariants(v.className)))
      const files = new Set(list.map((v) => v.file))
      console.log(
        `    ${String(list.length).padStart(4)}  ${code.padEnd(18)}` +
          ` ${DIM}${classes.size} distinct class${classes.size === 1 ? '' : 'es'}, ${files.size} file${files.size === 1 ? '' : 's'}${RESET}`,
      )
    }
  }

  if (blocking.length > 0) {
    console.log(`${RED}${BOLD}✗ TIER 1 — BLOCKING: ${blocking.length} violation${blocking.length === 1 ? '' : 's'} that fail this build${RESET}`)
    console.log(`${DIM}  Any occurrence of these codes fails CI. No grace period, no baseline.${RESET}\n`)
    summarise(blocking, CODE_ORDER)
    console.log('')
    printGroup(blocking, CODE_ORDER, showAll)
  }

  // ── Tier 2: frozen at count ────────────────────────────────────────────────
  const ratchet = evaluateRatchet(violations, baseline)
  if (ratchet.length > 0) {
    const rising = ratchet.filter((r) => r.grown.length > 0)
    const falling = ratchet.filter((r) => r.grown.length === 0 && r.shrunk.length > 0)

    console.log(`${BOLD}${rising.length > 0 ? RED + '✗' : GREEN + '✓'} TIER 2 — FROZEN AT COUNT${RESET}`)
    console.log(
      `${DIM}  Known debt with a number attached. These counts may only ever go DOWN; any increase fails.` +
        `\n  Baseline: ${rel(BASELINE_FILE)}${RESET}`,
    )
    for (const r of ratchet) {
      const delta = r.actual - r.baseline
      const arrow = delta > 0 ? `${RED}+${delta}${RESET}` : delta < 0 ? `${GREEN}${delta}${RESET}` : `${DIM}±0${RESET}`
      console.log(`    ${String(r.actual).padStart(4)}  ${r.code.padEnd(18)} ${DIM}baseline ${r.baseline}${RESET}  ${arrow}`)
    }
    console.log('')

    for (const r of rising) {
      console.log(`${RED}${BOLD}✗ ${r.code} ROSE ABOVE ITS BASELINE — ${r.baseline} → ${r.actual} (+${r.actual - r.baseline})${RESET}`)
      console.log(`${DIM}  This is frozen debt, not permitted drift. The classes that grew:${RESET}`)
      for (const g of r.grown) {
        const label = g.baseline === 0 ? `${RED}NEW${RESET}` : `+${g.actual - g.baseline}`
        console.log(`    ${g.className.padEnd(28)} ${g.baseline} → ${g.actual}  ${label}`)
      }
      console.log(
        `    fix:  remove the new occurrences. Do NOT raise the baseline in ${rel(BASELINE_FILE)} —` +
          `\n          it is a ratchet, and raising it is the one edit that is never correct.\n`,
      )
    }

    for (const r of falling) {
      console.log(`${GREEN}${BOLD}↓ ${r.code} FELL BELOW ITS BASELINE — ${r.baseline} → ${r.actual} (${r.actual - r.baseline})${RESET}`)
      console.log(`${DIM}  Progress. Lower the baseline IN THE SAME COMMIT so the ground you gained is held:${RESET}`)
      for (const sh of r.shrunk.slice(0, showAll ? r.shrunk.length : 8)) {
        console.log(`    ${sh.className.padEnd(28)} ${sh.baseline} → ${sh.actual}`)
      }
      if (!showAll && r.shrunk.length > 8) console.log(`    ${DIM}… and ${r.shrunk.length - 8} more (--all)${RESET}`)
      console.log(`    fix:  pnpm tsx ${rel(__filename_)} --write-baseline\n`)
    }

    if (frozen.length > 0 && showAll) printGroup(frozen, CODE_ORDER, showAll)
    else if (frozen.length > 0) {
      console.log(`${DIM}  (${frozen.length} frozen violations not itemised here — run with --all for the full inventory.)${RESET}\n`)
    }
  }

  // ── Ramp stops that have become bannable ───────────────────────────────────
  const bannable = bannableStops(result.stopUsage, tailwind)
  if (bannable.length > 0) {
    console.log(`${BOLD}${CYAN}→ ${bannable.length} ramp stop${bannable.length === 1 ? ' has' : 's have'} reached ZERO usage and can now be banned outright${RESET}`)
    console.log(
      `${DIM}  Add ${bannable.length === 1 ? 'it' : 'them'} to the no-restricted-syntax alternation in .eslintrc.js so the` +
        `\n  spelling can never come back. This list is computed from the real ESLint` +
        `\n  config, so it shrinks to nothing once they are added.${RESET}`,
    )
    console.log(`    ${bannable.join(', ')}\n`)
  }

  // ── Tier 3: report only ────────────────────────────────────────────────────
  if (reportOnly.length > 0) {
    console.log(`${BOLD}${YELLOW}⊘ TIER 3 — REPORT ONLY: ${reportOnly.length} site${reportOnly.length === 1 ? '' : 's'} a human must look at${RESET}`)
    console.log(
      `${YELLOW}  These do NOT fail the build, and they are NOT tolerated drift. design.md has already` +
        `\n  decided the rule; what cannot be decided HERE is which side of it a given element falls on,` +
        `\n  because it depends on what the text says at runtime rather than on anything in its class` +
        `\n  list. Flagging the legitimate cases would train people to ignore this check; passing the real` +
        `\n  ones would defeat it. So each is named, with the question to answer, and left to a reader.${RESET}\n`,
    )
    printGroup(reportOnly, CODE_ORDER, showAll)
  }

  if (result.unusedWaivers.length > 0) {
    console.log(`${RED}${BOLD}✗ ${result.unusedWaivers.length} waiver(s) suppress nothing${RESET}\n`)
    for (const w of result.unusedWaivers) {
      console.log(`${RED}✗ ${BOLD}${w.code} / ${w.className}${RESET}`)
      console.log(`    reason:  "${w.reason}"`)
      console.log(`    problem: no violation matches this waiver, so it mutes nothing and can hide the next real drift.`)
      console.log(`    fix:     delete the entry from WAIVERS in ${rel(__filename_)}.\n`)
    }
  }

  const { failed, reasons } = verdict({
    violations,
    docViolations,
    unusedWaivers: result.unusedWaivers,
    ratchet,
  })

  if (!failed) {
    console.log(
      `${GREEN}✓ No blocking design-token violations, and no frozen count rose above its baseline.${RESET}`,
    )
    if (reportOnly.length > 0 || violations.length > 0) {
      console.log(
        `${DIM}  ${violations.length} known violation${violations.length === 1 ? '' : 's'} remain under Tier 2/3 — see above. This is a PASS on the` +
          `\n  ratchet, not a clean tree.${RESET}`,
      )
    }
    return 0
  }

  console.log(`${RED}${BOLD}✗ FAILED:${RESET} ${reasons.join('; ')}`)
  console.log(
    `${YELLOW}design.md is authoritative (CLAUDE.md §Design Quality Rules). Nothing above is fixed by editing` +
      `\n${rel(__filename_)} or by raising a baseline — either the code moves onto the system, or design.md` +
      `\nchanges first and this check follows it automatically.${RESET}`,
  )
  return 1
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename_)
if (invokedDirectly) process.exit(main())
