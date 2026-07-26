# Neon — Style Reference
> Server Room After Dark. A deep black environment where data and interactions are the only sources of light.

**Theme:** dark

The design feels like a high-end server room after dark — a pure black void where information glows. A strict monochrome palette of pure black (#000000) and white (#ffffff) creates maximum contrast, ensuring text and UI are starkly legible. All visual energy comes from a single, electric green (#34d59a) that mimics terminal output and data visualizations, used exclusively for accents and decorative, code-like background graphics. The system achieves depth not with shadows but with subtle, layered near-black surfaces. A unique tension exists between the pill-shaped buttons and the sharp, 4px corners of all other UI containers.

## Tokens — Colors

> **Read the `Text On` column before using any token as text.** No text token in
> this system is valid on every surface. A token used as normal-size text on a
> ground outside its `Text On` list is a **WCAG AA failure and a shipping defect**
> — not a style preference. The authoritative numbers are in
> [Contrast — WCAG Matrix](#contrast--wcag-matrix); this column is derived from it.

Column definitions:

- **Text On** — surfaces where this token clears **4.5:1** and may be used for
  normal-size text (body, labels, metadata, table cells, captions). `none` means
  the token is not a text color at any size.
- **Never Text On** — sanctioned surfaces where this token is **below 4.5:1**.
  Using it as normal text on these grounds ships sub-AA copy.

| Name | Value | Token | Text On | Never Text On | Role |
|------|-------|-------|---------|---------------|------|
| Neon Glow | `#34d59a` | `--color-neon-glow` | Blackout, Depth, Graphite Deep, Graphite, Graphite Light | none | Key brand accent, active state indicators, data visualizations. Clears AA on every sanctioned surface, but is still **barred from body copy and headlines** by the Don'ts — accent, status and data-viz use only. |
| Neon Muted | `#285d49` | `--color-neon-muted` | none | Blackout, Depth, Graphite Deep, Graphite, Graphite Light | **Not a text color.** Background/fill only — subtle background tones in visualizations, less prominent brand elements. Peaks at 2.75:1 on Blackout. |
| Scanline Fade | `linear-gradient(90deg, rgba(57, 165, 125, 0.6) 50%, rgba(0, 0, 0, 0) 50%)` | `--color-scanline-fade` | none | all | **Not a text color.** Decorative effect only — mimics a terminal scanline. (Flat form `#39a57d`; see matrix.) |
| System Warning | `#ff3621` | `--color-system-warning` | Blackout, Depth, Graphite Deep | Graphite, Graphite Light | Urgent-attention icons, dots, borders and status fills, used sparingly. **Error text on a Graphite surface fails AA (4.20:1), and on the `destructive-900` hover fill 4.12:1** — reserve this token for the icon/dot/border and set the message body in Ember, Whiteout or Cloud. |
| Ember | `#ff6a5a` | `--color-ember` | Blackout, Depth, Graphite Deep, Graphite, Graphite Light | Whiteout | **The readable red — destructive/error text.** System Warning is the *signal* red (icons, dots, borders); Ember is the *legible* red for copy. It is the only red in the system that clears AA on Graphite (5.40:1) and on the destructive fills (5.30:1 on `destructive-900`, 5.98:1 on `destructive-50`), which is exactly what the error-text remediation requires. Fails on Whiteout (2.81:1) — never on a light ground. |
| Whiteout | `#ffffff` | `--color-whiteout` | Blackout, Depth, Graphite Deep, Graphite, Graphite Light | none | Primary text, primary CTA button backgrounds, icons. The only text token safe on every dark surface. |
| Ash | `#797d86` | `--color-ash` | Blackout, Depth | Graphite Deep, Graphite, Graphite Light | Secondary text **on the page ground only**, and inactive navigation links in the header. **Fails AA on every elevated surface** (4.39:1 on Graphite Deep, 3.68:1 on Graphite). Inside a card, panel, code block or table, use **Pewter** instead. |
| Pewter | `#94979e` | `--color-pewter` | Blackout, Depth, Graphite Deep, Graphite | Graphite Light | **The default secondary/tertiary text color on elevated surfaces** — metadata, placeholder text, table cells, captions on cards and panels (6.19:1 on Graphite Deep, 5.19:1 on Graphite). |
| Cloud | `#c9cbcf` | `--color-cloud` | Blackout, Depth, Graphite Deep, Graphite, Graphite Light | none | Hover states on dark elements, subtle highlights. Safe as text on every dark surface (≥ 7.91:1). |
| Graphite Light | `#303236` | `--color-graphite-light` | none | all | **Not a text color.** Borders, dividers, subtle UI structure. Also the ground for the Ghost Pill Button's border. |
| Graphite | `#242628` | `--color-graphite` | none | all | **Surface, not text.** Secondary surfaces floating on the background. |
| Graphite Deep | `#151617` | `--color-graphite-deep` | Whiteout | Blackout, Depth, Graphite, Graphite Light | **Primarily a surface** — card backgrounds, code block surfaces. Its one sanctioned text use is the Primary Pill Button label on a Whiteout ground (18.12:1). |
| Depth | `#0a0a0b` | `--color-depth` | none | all | **Surface, not text.** The darkest surface color before pure black, for subtle elevation. |
| Blackout | `#000000` | `--color-blackout` | Whiteout | Depth, Graphite Deep, Graphite, Graphite Light | **Primarily the absolute page background.** As text it is legible only on Whiteout (21:1) — e.g. selection highlight text on the Neon Glow ground (11.13:1). |

## Contrast — WCAG Matrix

This matrix is the **source of truth for every contrast decision in this system.**
Check a proposed pairing against it rather than re-deriving the numbers. If you add
or change a color token, regenerate this table in the same change — the `Text On`
column of the color table above is derived from it and must stay consistent.

Values are WCAG 2.x contrast ratios computed from the sRGB relative-luminance
formula, foreground against background, independently recomputed 2026-07-24.

### Thresholds

| Label | Ratio | Applies to |
|-------|-------|------------|
| `AAA` | ≥ 7.0 | Enhanced. Normal text at any size. |
| `AA` | ≥ 4.5 | **The floor for all body copy, labels, metadata, table cells, captions, code, and any text below 24px (or below 18.66px bold).** |
| `AA-large` | ≥ 3.0 | **Large text only** — ≥ 24px regular or ≥ 18.66px bold — and non-text UI boundaries (focus rings, control borders, chart strokes) per WCAG 1.4.11. |
| `FAIL` | < 3.0 | Not usable as text or as a meaningful boundary at any size. |

> **`AA-large` is not a pass for body copy.** In this product almost all text is
> 12–16px (see the Type Scale: `caption` 12px, `body-sm` 14px, `body` 16px), so
> `AA-large` effectively means **fail**. Only `heading-sm` (24px) and larger may
> rely on the 3:1 threshold. A dense debugging UI is overwhelmingly small text —
> assume 4.5:1 is the bar unless you have measured the rendered size.

### Matrix

Rows are foreground tokens, columns are sanctioned surfaces. `Graphite Light` is a
border/divider token and is only rarely a text ground; it is included so border and
focus-ring contrast can be checked.

| Foreground | Blackout `#000000` | Depth `#0a0a0b` | Graphite Deep `#151617` | Graphite `#242628` | Graphite Light `#303236` | Whiteout `#ffffff` |
|------------|--------------------|-----------------|-------------------------|--------------------|--------------------------|--------------------|
| Whiteout `#ffffff` | 21.00 AAA | 19.79 AAA | 18.12 AAA | 15.19 AAA | 12.84 AAA | — |
| Cloud `#c9cbcf` | 12.93 AAA | 12.18 AAA | 11.15 AAA | 9.35 AAA | 7.91 AAA | 1.62 FAIL |
| Pewter `#94979e` | 7.18 AAA | 6.77 AA | 6.19 AA | 5.19 AA | 4.39 AA-large | 2.92 FAIL |
| Ash `#797d86` | 5.09 AA | 4.80 AA | 4.39 AA-large | 3.68 AA-large | 3.11 AA-large | 4.13 AA-large |
| Neon Glow `#34d59a` | 11.13 AAA | 10.49 AAA | 9.60 AAA | 8.05 AAA | 6.81 AA | 1.89 FAIL |
| Neon Muted `#285d49` | 2.75 FAIL | 2.59 FAIL | 2.37 FAIL | 1.99 FAIL | 1.68 FAIL | 7.63 AAA |
| System Warning `#ff3621` | 5.80 AA | 5.47 AA | 5.01 AA | 4.20 AA-large | 3.55 AA-large | 3.62 AA-large |
| Ember `#ff6a5a` | 7.46 AAA | 7.03 AAA | 6.44 AA | 5.40 AA | 4.56 AA | 2.81 FAIL |
| Graphite Light `#303236` | 1.64 FAIL | 1.54 FAIL | 1.41 FAIL | 1.18 FAIL | — | 12.84 AAA |
| Scanline Fade `#39a57d` | 6.85 AA | 6.46 AA | 5.91 AA | 4.95 AA | 4.19 AA-large | 3.06 AA-large |

### Interaction-state grounds

**A token's ground can be created by its own `hover:`, `focus:`, `active:`,
`aria-selected:` or `data-state` fill.** A control whose label sits on a
transparent background inherits the contrast of whatever is *behind* it in the
resting state — but the moment an interaction state paints a fill underneath that
label, it manufactures a new foreground/background pairing that never existed in
the static markup.

This is invisible to any check that only inspects resting-state grounds. It is how
the destructive Button shipped a violation: the label was on transparent (no static
defect), and `hover:bg-destructive-900` created a 4.12:1 pairing on hover only.

When a component paints an interaction fill, check the label against **the fill**,
not the page surface:

| Interaction fill | Value | Whiteout | Cloud | Ember `#ff6a5a` | System Warning `#ff3621` |
|------------------|-------|----------|-------|-----------------|--------------------------|
| `destructive-900` / `destructive-100` | `#4d120c` | 15.04 AAA | 9.26 AAA | 5.30 AA | 4.12 AA-large |
| `destructive-50` | `#3a0e0a` | 16.95 AAA | 10.44 AAA | 5.98 AA | 4.65 AA |
| `primary-900` | `#123b2f` | 12.44 AAA | 7.66 AAA | — | — |
| `success-900` | `#123b2f` | 12.44 AAA | 7.66 AAA | — | — |

Every hover/selected fill in the system is *darker* than the surface it sits on, so
a label that clears AA at rest generally still clears it on hover — **except for
System Warning on `destructive-900`, which drops to 4.12:1.** That is the one
pairing to watch, and Ember (5.30:1) is its fix.

### Consequences to know

1. **Ash is a Blackout-and-Depth-only text color.** It fails AA on every elevated
   surface. Because cards, panels, code blocks and tables all sit on Graphite Deep
   or Graphite, **most secondary text in this product must be Pewter, not Ash.**
2. **Pewter is the secondary-text default on surfaces**, and clears AA everywhere
   except directly on Graphite Light (4.39:1) — which is a border, not a ground.
3. **System Warning fails AA as text on Graphite (4.20:1) and on the
   `destructive-900` hover fill (4.12:1).** It is the signal red, not the copy red.
   Error *text* uses **Ember `#ff6a5a`** — the only red clearing AA on Graphite
   (5.40:1) and on both destructive fills — or Whiteout/Cloud. Keep System Warning
   for the icon, dot or border, where the 3:1 non-text threshold applies.
4. **Neon Glow clears AA on all dark surfaces** but remains barred from body copy
   and headlines by the Don'ts — that is a brand rule, not a contrast one.
5. **Neon Muted, Graphite Light, Graphite, Depth and Scanline Fade are never text.**

### Tailwind alias trap

`apps/web/tailwind.config.ts` remaps Tailwind's `neutral` scale onto these tokens,
so a class name can hide which token you actually picked. These aliases are the
same colors and carry the same constraints:

| Tailwind class | Token | Same rules as |
|----------------|-------|---------------|
| `text-neutral-50` / `text-whiteout` | Whiteout `#ffffff` | Whiteout row |
| `text-neutral-200` / `text-cloud` | Cloud `#c9cbcf` | Cloud row |
| `text-neutral-400` / `text-pewter` | Pewter `#94979e` | Pewter row |
| `text-neutral-500` / `text-ash` | Ash `#797d86` | **Ash row — fails AA on cards** |
| `bg-neutral-950` | Blackout `#000000` | page ground |
| `bg-neutral-900` | Depth `#0a0a0b` | surface |
| `bg-neutral-850` | Graphite Deep `#151617` | card surface |
| `bg-neutral-800` | Graphite `#242628` | surface |
| `border-neutral-700` | Graphite Light `#303236` | border |

**`text-neutral-500` is Ash.** It is the most common way this violation enters the
codebase, because the class name gives no hint that it is the sub-AA-on-cards token.
Inside any `bg-neutral-850` / `bg-neutral-800` / `bg-graphite*` container, secondary
text must be `text-neutral-400` (Pewter) or lighter.

## Tokens — Typography

### Inter — Headlines and primary marketing copy. Its clean, neutral geometry provides high readability, contrasting with the more stylized monospaced font. · `--font-inter`
- **Substitute:** Inter
- **Weights:** 400, 500
- **Sizes:** 10px, 12px, 13px, 14px, 15px, 16px, 18px, 20px, 24px, 28px, 32px, 40px, 44px, 48px, 60px, 80px
- **Line height:** 1.00, 1.13, 1.25, 1.38, 1.50
- **Letter spacing:** Tight negative tracking on all display and heading sizes (-3.2px at 80px, -1.2px at 48px), becoming normal at body copy sizes.
- **Role:** Headlines and primary marketing copy. Its clean, neutral geometry provides high readability, contrasting with the more stylized monospaced font.

### Geist Mono — Code snippets, UI labels, and data displays. Its monospaced form adds a technical, typewriter-like precision, reinforcing the developer-centric identity. · `--font-geistmono`
- **Substitute:** Fira Code, Source Code Pro
- **Weights:** 400, 500, 600
- **Sizes:** 10px, 12px, 14px, 16px, 18px, 20px, 24px, 40px, 64px
- **Line height:** 1.00, 1.13, 1.38, 1.50, 1.65
- **Letter spacing:** Slight negative tracking enhances density in UI contexts (-0.7px at 14px, -0.43px at 16px), tightening further on metric displays (-0.8px at 40px, -1.28px at 64px) and flattening to 0 at the 10px `micro` step, where negative tracking destroys legibility.
- **Range rule:** Geist Mono is **not** bounded at 20px. It runs 10px–64px, but the ends are narrowly scoped: **above 20px it is for tabular figures only** (`metric-sm`, `metric`) plus the decorative `watermark`; **below 12px it is for non-prose marks only** (`micro`). See Mono Range Rules below.
- **Role:** Code snippets, UI labels, and data displays. Its monospaced form adds a technical, typewriter-like precision, reinforcing the developer-centric identity.

### Type Scale

| Role | Size | Line Height | Letter Spacing | Token |
|------|------|-------------|----------------|-------|
| caption | 12px | 1.5 | -0.7px | `--text-caption` |
| body-sm | 14px | 1.5 | -0.7px | `--text-body-sm` |
| body | 16px | 1.5 | -0.43px | `--text-body` |
| subheading | 18px | 1.38 | -0.36px | `--text-subheading` |
| heading-sm | 24px | 1.25 | -0.24px | `--text-heading-sm` |
| heading | 32px | 1.25 | -0.64px | `--text-heading` |
| heading-lg | 48px | 1.13 | -1.2px | `--text-heading-lg` |
| display | 80px | 1 | -3.2px | `--text-display` |
| micro | 10px | 1.5 | 0px | `--text-micro` |
| metric-xs | 20px | 1 | -0.3px | `--text-metric-xs` |
| metric-sm | 24px | 1 | -0.24px | `--text-metric-sm` |
| metric | 40px | 1 | -0.8px | `--text-metric` |
| watermark | 64px | 1 | -1.28px | `--text-watermark` |

### Mono Range Rules

The five mono steps above exist because the product legitimately uses them. Each is
narrowly scoped, and **the scope is the point** — these are not general-purpose
sizes that happen to be monospaced.

The governing distinction is **prose vs. mark**, not numeral vs. label:

- **Prose** is anything a reader parses as language or data they must read
  accurately — labels, metadata, dates, code, messages, table cells.
  **Prose is floored at 12px (`caption`) and capped at 20px.**
- **A mark** is a glyph read as a symbol, not as language — a wordmark, an ordinal
  in a badge, an icon glyph, a decorative background numeral. Marks may sit
  outside the prose range because they are not read.

| Step | Sanctioned for | Forbidden for |
|------|----------------|---------------|
| `micro` 10px | Non-prose marks only: wordmark lockups (`AFR`), ordinal badges (`1`–`4`), icon glyphs (`↗`). Must be a single word, digit, or symbol. | **All prose.** Labels, dates, metadata, hints, messages, table cells, code. If a user reads it as words, 10px is too small — use `caption` 12px. |
| `metric-xs` 20px | The smallest tabular metric tier — dense stat rows inside cards and panels. **Requires `tabular-nums`.** | Prose of any kind. It is a number slot, not a size for text that happens to be 20px. |
| `metric-sm` 24px | Tabular metric values on cards and inline meters. **Requires `tabular-nums`.** | Headings (use Inter `heading-sm`), body copy, any non-numeric string. |
| `metric` 40px | Primary tabular metric values in stat displays. **Requires `tabular-nums`.** | Headings, body copy, any non-numeric string. |
| `watermark` 64px | Decorative background numerals only. Must be non-interactive and non-selectable (`pointer-events-none`, `select-none`), sit in the Graphite range at reduced opacity, and **carry no information that is not already stated in real text.** | Anything a user must read. It is imagery (see Imagery), not typography. |

**Why large mono numerals are correct here.** This is a debugging tool; engineers
scan columns of numbers and compare them across rows and runs. Monospaced tabular
figures keep digits in fixed columns so magnitude is legible by *shape* before it
is read — a 40px proportional numeral would defeat that. Large mono metrics are a
deliberate choice, not drift. **`tabular-nums` is mandatory on `metric-sm` and
`metric`**; without it the step provides no benefit over Inter and should not be
used.

**Why 11px does not exist.** There is no 11px step and none will be added. Between
`micro` 10px (marks) and `caption` 12px (the prose floor) there is no case an 11px
step serves. Existing 11px text moves to `caption`.

**Why 13px does not exist.** Code and terminal surfaces use `body-sm` 14px. 13px
sits between two sanctioned steps and buys nothing.

**There is no fourth category.** Every mono size in the product is either one of
the nine sanctioned values above or a defect. A size that is "in use but not
listed" is drift by definition — that ambiguity is what allowed this to accumulate.

## Tokens — Spacing & Shapes

**Base unit:** 4px

**Density:** comfortable

### Spacing Scale

| Name | Value | Token |
|------|-------|-------|
| 4 | 4px | `--spacing-4` |
| 8 | 8px | `--spacing-8` |
| 12 | 12px | `--spacing-12` |
| 16 | 16px | `--spacing-16` |
| 20 | 20px | `--spacing-20` |
| 24 | 24px | `--spacing-24` |
| 28 | 28px | `--spacing-28` |
| 32 | 32px | `--spacing-32` |
| 36 | 36px | `--spacing-36` |
| 40 | 40px | `--spacing-40` |
| 56 | 56px | `--spacing-56` |
| 64 | 64px | `--spacing-64` |
| 80 | 80px | `--spacing-80` |
| 128 | 128px | `--spacing-128` |
| 160 | 160px | `--spacing-160` |
| 240 | 240px | `--spacing-240` |

### Border Radius

| Element | Value |
|---------|-------|
| cards | 4px |
| inputs | 4px |
| buttons | 9999px |
| containers | 4px |

### Shadows

| Name | Value | Token |
|------|-------|-------|
| lg | `rgba(0, 0, 0, 0.4) 0px 8px 20px 0px` | `--shadow-lg` |

### Glow

| Name | Value | Token |
|------|-------|-------|
| glow | `0 0 8px rgba(52, 213, 154, 0.7)` | `--shadow-glow` |
| glow-warn | `0 0 8px rgba(255, 54, 33, 0.6)` | `--shadow-glow-warn` |

The accent glow is the signature "data glow" of live/status indicator dots — a
soft Neon Glow halo that reads as powered-on hardware in the dark server room.
It is sanctioned **only** for small status/live dots (≤ 8px) and the active-nav
tick: elements that carry state, never decoration. It must never be used for
elevation — depth remains layered near-black surfaces (see Elevation). Use the
`--shadow-glow` token rather than ad-hoc box-shadow values.

`--shadow-glow-warn` is the destructive/warn counterpart, using the System
Warning red. It is sanctioned **only** for small status dots (≤ 8px) that carry
a failed/alert state (e.g. a failed-run badge dot). Never for elevation, text,
borders, or any element larger than a status dot. As with the accent glow, use
the token — never ad-hoc red box-shadow literals.

### Layout

- **Page max-width:** 1200px
- **Section gap:** 96-128px
- **Card padding:** 24px
- **Element gap:** 8-16px

## Components

### Primary Pill Button
**Role:** The main call-to-action, e.g., 'Get started', 'Sign up'.

A pill-shaped button with a Whiteout (#ffffff) background and Graphite Deep (#151617) text. Uses Inter font. Padding is H: 28px, V: 12px. Radius is 9999px.

### Ghost Pill Button
**Role:** Secondary actions, e.g., 'Read the docs', 'Log in'.

A pill-shaped button with a transparent background, Whiteout (#ffffff) text, and a 1px solid border in Graphite Light (#303236). Uses Inter font. Padding is H: 18px, V: 12px. Radius is 9999px.

### Feature List Item
**Role:** Bulleted items in feature sections.

Whiteout (#ffffff) text using Inter. Preceded by a small dot or icon colored with Neon Glow (#34d59a).

### Navigation Link
**Role:** Links in the main site header.

Text in Ash (#797d86) using Inter font, **valid because the header sits directly on the Blackout (#000000) ground** (5.09:1). On hover or active state, text becomes Whiteout (#ffffff). If a nav is ever placed on an elevated surface — a Graphite Deep sidebar or panel — switch the inactive state to Pewter (#94979e); Ash on Graphite Deep is 4.39:1 and fails AA.

### Tag Badge
**Role:** Small informational tags, like 'A DATABRICKS COMPANY'.

Small, all-caps text using GeistMono. **Badge text is small (12px) and badges almost always sit on a filled Graphite (#242628) or Graphite Deep (#151617) chip, so the label must be Pewter (#94979e) or lighter** — Ash on a Graphite chip is 3.68:1 and fails AA badly. Ash is acceptable only for an unfilled badge sitting directly on the Blackout ground. Often preceded by a Neon Glow (#34d59a) icon or symbol.

### Announcement Bar
**Role:** A persistent top bar for site-wide announcements.

Full-width bar with a Blackout (#000000) background. Text uses Inter font in a legible color like Whiteout (#ffffff) or Neon Glow (#34d59a).

### Logo Bar
**Role:** A section displaying logos of partner or client companies.

A row of logos rendered in a monochrome Ash (#797d86) or Pewter (#94979e) color on a Blackout (#000000) background. Logos are non-text graphics, so the 3:1 threshold applies rather than 4.5:1 — but any accompanying wordmark rendered as live text follows the text rules above.

## Do's and Don'ts

### Do
- Use pure Blackout (#000000) for all main section backgrounds.
- Reserve Neon Glow (#34d59a) for interactive highlights, data visualizations, and small decorative accents only.
- Employ the Whiteout (#ffffff) pill button for all primary calls-to-action.
- Use GeistMono for all code snippets, terminal simulations, and compact UI labels.
- Apply tight negative letter-spacing (-1.2px or more) to all headlines 48px and larger.
- Achieve depth by layering near-black surfaces (e.g., #151617 on #000000), not with box-shadows.
- Maintain a strict dichotomy of shapes: 9999px radius for buttons, 4px for all other containers.
- Use Pewter (#94979e) for secondary and tertiary text on any elevated surface — cards, panels, code blocks, table rows, badges.
- Check every new text/background pairing against the [contrast matrix](#contrast--wcag-matrix) before shipping it.

### Don't
- Don't use gradients or background colors on main page sections.
- Don't use traditional box-shadows for elevation.
- Don't use Neon Glow (#34d59a) for body copy or headlines.
- Don't use saturated colors other than the primary brand green and the occasional red alert accent.
- Don't mix Inter and Geist Mono within the same sentence or headline.
- Don't set mono prose below 12px or above 20px. Sizes outside that range are reserved for tabular metrics (`metric-sm`, `metric`, both requiring `tabular-nums`), decorative watermarks, and non-prose marks (`micro`) — never for labels, dates, metadata, or copy.
- Don't use `metric-sm` or `metric` without `tabular-nums`, and don't use them for anything that isn't a number.
- Don't use rounded corners larger than 4px on cards, code blocks, or input fields.
- Don't create buttons that aren't pill-shaped.
- **Don't use Ash (#797d86) as text on Graphite Deep, Graphite, or Graphite Light.** It measures 4.39:1 / 3.68:1 / 3.11:1 — all below the 4.5:1 AA floor. This is the single most common accessibility defect in this codebase; `text-neutral-500` is the alias that smuggles it in.
- Don't treat an `AA-large` (3:1) result as a pass for body copy. It is valid only at ≥ 24px regular / ≥ 18.66px bold, and virtually no text in this product is that large.
- Don't use System Warning (#ff3621) for error *copy* on a Graphite surface (4.20:1) or on the destructive-900 hover fill (4.12:1). Keep the red on the icon, dot, or border and set the message text in Ember (#ff6a5a), Whiteout, or Cloud.
- **Don't check only the resting state.** If a component paints a `hover:`, `focus:`, `active:` or `aria-selected:` fill behind its own label, that fill is a new ground and must be measured as one. Transparent-at-rest is not a pass.
- Don't use Neon Muted (#285d49), Graphite Light (#303236), or Scanline Fade as a text color — none clears 3:1 on any dark surface.

## Elevation

Elevation is achieved through layered, near-black surfaces, not traditional box-shadows. Surfaces like Graphite Deep (#151617) float on the pure Blackout (#000000) background, creating depth through contrast without relying on blurs. This reinforces a flat, digital-native aesthetic.

## Imagery

Visuals are exclusively abstract, generative graphics resembling data streams, server activity, or glitch art. Composed of thin vertical lines in Neon Glow (#34d59a) and other muted tones, they serve as atmospheric backdrops rather than informational content. Product visuals are limited to stylized screenshots of terminal windows and code blocks, treated as UI components. Large decorative background numerals (the `watermark` step) belong to this category rather than to typography: they are atmospheric marks, and must be non-selectable, non-interactive, and redundant to information already present in real text. Photography and traditional illustrations are absent. This text-and-abstract-graphic approach creates a purely digital, code-native environment.

## Layout

The page structure is full-bleed black, creating an immersive, infinite canvas. A centered headline over an abstract data-viz graphic defines the hero. Below the hero, content is organized within a centered max-width container (approx. 1200px), creating focus. Sections flow seamlessly into one another without visual dividers, relying on generous vertical spacing (96-128px) to create rhythm. Content is arranged in simple, symmetrical layouts: centered stacks for headlines, two-column grids for feature lists, and multi-column grids for logos. A sticky header provides persistent navigation.

## Agent Prompt Guide

### Quick Color Reference
- **Page Background:** Blackout (`#000000`)
- **Primary Text:** Whiteout (`#ffffff`) — safe on every surface
- **Secondary Text on a card / panel / code block / table:** **Pewter (`#94979e`)**
  — this is the common case; almost all secondary text in the product sits on an
  elevated surface
- **Secondary Text directly on the page ground (Blackout / Depth):** Ash
  (`#797d86`) — **only** here. Ash on Graphite Deep is 4.39:1 and fails AA.
- **Accent / Highlight:** Neon Glow (`#34d59a`) — accents and status only, never body copy
- **CTA Button:** Whiteout (`#ffffff`) background, Graphite Deep (`#151617`) text
- **Border / Divider:** Graphite Light (`#303236`)

### Example Component Prompts
1.  **Hero Section:** "Create a full-screen hero section with a `Blackout` #000000 background. Add a large display headline: text 'Fast Postgres Databases', font `Inter` 80px weight 500, color `Whiteout` #ffffff, line-height 1.0, and letter-spacing -3.2px. Below it, add a primary CTA button: 'Get started' in a `Whiteout` #ffffff pill with `Graphite Deep` #151617 text, 9999px radius, and 12px 28px padding."
2.  **Code Block:** "Design a terminal code block component. Use a `Graphite Deep` #151617 background with 4px rounded corners and 24px padding. The text inside should use the `GeistMono` font at 14px. Default text color is `Whiteout` #ffffff. Highlight specific keywords or outputs with `Neon Glow` #34d59a."
3.  **Feature Section:** "Create a two-column section on a `Blackout` #000000 background. In the left column, create a list of features with `Whiteout` #ffffff text and a `Neon Glow` #34d59a dot prefix. In the right column, add a heading 'Integrate with a single command' using `Inter` 48px, `Whiteout` #ffffff color, and -1.2px letter-spacing."

## Similar Brands

- **Vercel** — Identical developer focus with a black/white monochrome palette, single accent color, and use of Inter font.
- **Linear** — Shares a pristine, high-contrast dark UI, minimalist aesthetic, and sharp focus on typography.
- **GitHub** — Similar dark-mode theming, developer-centric tooling aesthetic, and heavy reliance on monospaced fonts for identity.
- **Replit** — Also uses a dark, code-focused environment with vibrant color accents to appeal to a developer audience.

## Quick Start

### CSS Custom Properties

```css
:root {
  /* Colors */
  --color-neon-glow: #34d59a;
  --color-neon-muted: #285d49;
  --color-scanline-fade: #39a57d;
  --gradient-scanline-fade: linear-gradient(90deg, rgba(57, 165, 125, 0.6) 50%, rgba(0, 0, 0, 0) 50%);
  --color-system-warning: #ff3621; /* signal red — icons/dots/borders only */
  --color-ember: #ff6a5a;          /* readable red — destructive/error copy */
  --color-whiteout: #ffffff;
  --color-ash: #797d86;
  --color-pewter: #94979e;
  --color-cloud: #c9cbcf;
  --color-graphite-light: #303236;
  --color-graphite: #242628;
  --color-graphite-deep: #151617;
  --color-depth: #0a0a0b;
  --color-blackout: #000000;

  /* Typography — Font Families */
  --font-inter: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
  /* Family name is 'Geist Mono' (with a space) — that is the name that resolves. */
  --font-geistmono: 'Geist Mono', 'Fira Code', 'Source Code Pro', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Typography — Scale */
  --text-caption: 12px;
  --leading-caption: 1.5;
  --tracking-caption: -0.7px;
  --text-body-sm: 14px;
  --leading-body-sm: 1.5;
  --tracking-body-sm: -0.7px;
  --text-body: 16px;
  --leading-body: 1.5;
  --tracking-body: -0.43px;
  --text-subheading: 18px;
  --leading-subheading: 1.38;
  --tracking-subheading: -0.36px;
  --text-heading-sm: 24px;
  --leading-heading-sm: 1.25;
  --tracking-heading-sm: -0.24px;
  --text-heading: 32px;
  --leading-heading: 1.25;
  --tracking-heading: -0.64px;
  --text-heading-lg: 48px;
  --leading-heading-lg: 1.13;
  --tracking-heading-lg: -1.2px;
  --text-display: 80px;
  --leading-display: 1;
  --tracking-display: -3.2px;
  /* Geist Mono range steps — see "Mono Range Rules" for scope. */
  --text-micro: 10px;        /* non-prose marks only, never labels or copy */
  --leading-micro: 1.5;
  --tracking-micro: 0px;
  --text-metric-xs: 20px;    /* tabular metric value; requires tabular-nums */
  --leading-metric-xs: 1;
  --tracking-metric-xs: -0.3px;
  --text-metric-sm: 24px;    /* tabular metric value; requires tabular-nums */
  --leading-metric-sm: 1;
  --tracking-metric-sm: -0.24px;
  --text-metric: 40px;       /* tabular metric value; requires tabular-nums */
  --leading-metric: 1;
  --tracking-metric: -0.8px;
  --text-watermark: 64px;    /* decorative background numeral; carries no info */
  --leading-watermark: 1;
  --tracking-watermark: -1.28px;

  /* Typography — Weights */
  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;

  /* Spacing */
  --spacing-unit: 4px;
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --spacing-24: 24px;
  --spacing-28: 28px;
  --spacing-32: 32px;
  --spacing-36: 36px;
  --spacing-40: 40px;
  --spacing-56: 56px;
  --spacing-64: 64px;
  --spacing-80: 80px;
  --spacing-128: 128px;
  --spacing-160: 160px;
  --spacing-240: 240px;

  /* Layout */
  --page-max-width: 1200px;
  --section-gap: 96-128px;
  --card-padding: 24px;
  --element-gap: 8-16px;

  /* Border Radius */
  --radius-md: 4px;

  /* Named Radii */
  --radius-cards: 4px;
  --radius-inputs: 4px;
  --radius-buttons: 9999px;
  --radius-containers: 4px;

  /* Shadows */
  --shadow-lg: rgba(0, 0, 0, 0.4) 0px 8px 20px 0px;
  /* Accent glow — live/status dots only, never elevation (see Glow) */
  --shadow-glow: 0 0 8px rgba(52, 213, 154, 0.7);
  /* Destructive/warn glow — failed/alert status dots only (see Glow) */
  --shadow-glow-warn: 0 0 8px rgba(255, 54, 33, 0.6);
}
```

### Tailwind v4

```css
@theme {
  /* Colors */
  --color-neon-glow: #34d59a;
  --color-neon-muted: #285d49;
  --color-scanline-fade: #39a57d;
  --color-system-warning: #ff3621; /* signal red — icons/dots/borders only */
  --color-ember: #ff6a5a;          /* readable red — destructive/error copy */
  --color-whiteout: #ffffff;
  --color-ash: #797d86;
  --color-pewter: #94979e;
  --color-cloud: #c9cbcf;
  --color-graphite-light: #303236;
  --color-graphite: #242628;
  --color-graphite-deep: #151617;
  --color-depth: #0a0a0b;
  --color-blackout: #000000;

  /* Typography */
  --font-inter: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
  /* Family name is 'Geist Mono' (with a space) — that is the name that resolves. */
  --font-geistmono: 'Geist Mono', 'Fira Code', 'Source Code Pro', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Typography — Scale */
  --text-caption: 12px;
  --leading-caption: 1.5;
  --tracking-caption: -0.7px;
  --text-body-sm: 14px;
  --leading-body-sm: 1.5;
  --tracking-body-sm: -0.7px;
  --text-body: 16px;
  --leading-body: 1.5;
  --tracking-body: -0.43px;
  --text-subheading: 18px;
  --leading-subheading: 1.38;
  --tracking-subheading: -0.36px;
  --text-heading-sm: 24px;
  --leading-heading-sm: 1.25;
  --tracking-heading-sm: -0.24px;
  --text-heading: 32px;
  --leading-heading: 1.25;
  --tracking-heading: -0.64px;
  --text-heading-lg: 48px;
  --leading-heading-lg: 1.13;
  --tracking-heading-lg: -1.2px;
  --text-display: 80px;
  --leading-display: 1;
  --tracking-display: -3.2px;
  /* Geist Mono range steps — see "Mono Range Rules" for scope. */
  --text-micro: 10px;        /* non-prose marks only, never labels or copy */
  --leading-micro: 1.5;
  --tracking-micro: 0px;
  --text-metric-xs: 20px;    /* tabular metric value; requires tabular-nums */
  --leading-metric-xs: 1;
  --tracking-metric-xs: -0.3px;
  --text-metric-sm: 24px;    /* tabular metric value; requires tabular-nums */
  --leading-metric-sm: 1;
  --tracking-metric-sm: -0.24px;
  --text-metric: 40px;       /* tabular metric value; requires tabular-nums */
  --leading-metric: 1;
  --tracking-metric: -0.8px;
  --text-watermark: 64px;    /* decorative background numeral; carries no info */
  --leading-watermark: 1;
  --tracking-watermark: -1.28px;

  /* Spacing */
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --spacing-24: 24px;
  --spacing-28: 28px;
  --spacing-32: 32px;
  --spacing-36: 36px;
  --spacing-40: 40px;
  --spacing-56: 56px;
  --spacing-64: 64px;
  --spacing-80: 80px;
  --spacing-128: 128px;
  --spacing-160: 160px;
  --spacing-240: 240px;

  /* Border Radius */
  --radius-md: 4px;

  /* Shadows */
  --shadow-lg: rgba(0, 0, 0, 0.4) 0px 8px 20px 0px;
  /* Accent glow — live/status dots only, never elevation (see Glow) */
  --shadow-glow: 0 0 8px rgba(52, 213, 154, 0.7);
  /* Destructive/warn glow — failed/alert status dots only (see Glow) */
  --shadow-glow-warn: 0 0 8px rgba(255, 54, 33, 0.6);
}
```

## Appendix — Implementation Notes and Known Drift

Audited 2026-07-24 against `apps/web/tailwind.config.ts` and
`apps/web/app/globals.css`.

### What is actually implemented

`globals.css` defines the **color, glow and font** custom properties only. The
`--text-*`, `--leading-*`, `--tracking-*`, `--spacing-*`, `--radius-*`,
`--shadow-lg` and layout properties shown in the Quick Start blocks above are
**reference values, not shipped custom properties** — nothing in `apps/web`
consumes them today, and `var(--text-body-sm)` would currently resolve to
nothing. The type scale and spacing scale are applied through Tailwind
utilities instead. Treat the Quick Start blocks as the spec; treat
`tailwind.config.ts` as the runtime.

### Derived Tailwind ramps — NOT canonical palette tokens

`tailwind.config.ts` remaps Tailwind's `neutral`, `primary`, `success`,
`destructive` and `warning` scales onto this system. Most stops land exactly on a
canonical token (see the alias table under Contrast), but the following stops are
**interpolated tints and shades that do not correspond to any token in this
document**:

| Tailwind stop | Value | Note |
|---------------|-------|------|
| `neutral-100` | `#f4f5f6` | interpolated |
| `neutral-300` | `#a6a9af` | interpolated |
| `neutral-600` | `#4a4d53` | interpolated — 2.48:1 on Blackout, **never text** |
| `primary-50` | `#e7fbf3` | Neon Glow tint |
| `primary-100` | `#c2f4e0` | Neon Glow tint |
| `primary-200` | `#8fe9c6` | Neon Glow tint |
| `primary-300` | `#5fdeae` | Neon Glow tint |
| `primary-600` | `#22b884` | Neon Glow shade |
| `primary-700` | `#1a8f68` | Neon Glow shade — 3.74:1 on Graphite, **not AA text there** |
| `primary-900` | `#123b2f` | Neon Glow shade — 1.69:1 on Blackout, **never text** |
| `destructive-600` / `warning-600` | `#e02a17` | System Warning shade — 3.89:1 on Graphite Deep, **not AA text there** |
| `destructive-700` / `warning-700` | `#b71f10` | System Warning shade — 2.78:1 on Graphite Deep, **never text** |
| `destructive-50` / `warning-50` | `#3a0e0a` | dark fill only |
| `destructive-100` / `900` | `#4d120c` | dark fill only |

These stops exist so that pre-existing Tailwind class names keep rendering inside
the Neon environment. **They are not an expansion of the palette and must not be
reached for in new work** — new work uses the named tokens (`text-pewter`,
`bg-graphite-deep`, `text-neon-glow`, …). Several of them are below the AA floor,
as annotated. They are listed here so the doc and the config are reconcilable and
so a token-table parser can distinguish canonical tokens from derived ramp stops.

**Canonical palette = the 14 rows of [Tokens — Colors](#tokens--colors). Nothing else.**
