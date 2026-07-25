/**
 * CertaintyMarker — the visual half of the three-band certainty distinction.
 *
 * ===========================================================================
 * WHY THIS IS NOT A COLOURED BADGE
 * ===========================================================================
 *
 * The obvious implementation is one `<Badge>` that is red when proven, amber
 * when speculative and grey when unknown. That implementation fails four
 * different readers:
 *
 *   - anyone with a colour vision deficiency (red/green being the most common
 *     axis, and the one a red/amber badge sits directly on);
 *   - anyone reading a screenshot pasted into a monochrome doc, or printed;
 *   - anyone using a screen reader, for whom a colour is simply absent;
 *   - anyone in forced-colors / high-contrast mode, where the user agent
 *     substitutes its own palette and the distinction evaporates entirely.
 *
 * design.md also makes the colour route structurally unavailable even if it
 * were accessible: the palette is deliberately narrow — Blackout ground,
 * Whiteout text, one Neon Glow accent and a red reserved for errors. There is
 * no third and fourth accent hue to spend on three bands, and inventing one
 * would mean changing design.md first.
 *
 * So the distinction is carried by FOUR redundant NON-COLOUR channels, any one
 * of which is sufficient alone:
 *
 *   1. THE WORD        `PROVEN` / `UNPROVEN` / `UNKNOWN`, spelled out in
 *                      monospace. Not an icon, not an abbreviation. Survives
 *                      greyscale, screen readers, and being read over a call.
 *   2. BORDER STYLE    solid / dashed / dotted. Three distinct geometries; a
 *                      dashed or dotted outline reads as provisional in every
 *                      visual system, and none of it is a hue.
 *   3. FILL            filled / transparent / transparent. Fill PRESENCE
 *                      survives greyscale where fill hue does not.
 *   4. GLYPH SILHOUETTE solid square / hollow square / hollow circle. Three
 *                      different shapes at 6px, independent of colour.
 *
 * Colour is layered on top as reinforcement only and carries nothing the four
 * channels above do not already carry. Strip every colour and the component
 * still reads correctly — that is the acceptance test, and
 * tests/unit/blast_radius_certainty.test.tsx enforces it by removing every
 * class and style attribute from the rendered tree and asserting the three
 * bands remain distinguishable.
 *
 * ---------------------------------------------------------------------------
 * THE ACCESSIBLE NAME IS A SENTENCE, NOT A WORD
 * ---------------------------------------------------------------------------
 *
 * `PROVEN` alone is ambiguous read aloud out of context, and `UNKNOWN` is
 * worse. The visually-hidden text spells out the actual epistemic claim, so a
 * screen-reader user gets the meaning rather than a label they must have
 * learned. The three sentences are in three different grammatical moods —
 * indicative, conditional, interrogative — which is itself a fifth channel.
 */

import type { Certainty } from '@/lib/divergence/labels'

import { CERTAINTY_COPY } from '@/lib/divergence/labels'
import { cn } from '@/lib/utils'

interface CertaintyMarkerProps {
  certainty: Certainty
  compact?: boolean
  className?: string
}

/** The non-colour channels, declared per band so the difference is auditable. */
const MARKER: Readonly<
  Record<Certainty, { chip: string; glyph: string; sentence: string }>
> = {
  proven: {
    // Solid border + filled chip.
    chip: 'border-solid bg-graphite border-graphite-light text-ember',
    // Solid square.
    glyph: 'bg-ember rounded-[4px]',
    sentence:
      'Proven: the recorded event log shows this could not have happened on the target version.',
  },
  speculative: {
    // Dashed border + no fill.
    chip: 'border-dashed bg-transparent border-graphite-light text-pewter',
    // Hollow square.
    glyph: 'bg-transparent border border-pewter rounded-[4px]',
    sentence:
      'Unproven: a configuration change that may or may not alter behaviour. This is not evidence of a break.',
  },
  indeterminate: {
    // Dotted border + no fill.
    chip: 'border-dotted bg-transparent border-graphite-light text-cloud',
    // Hollow circle — a different silhouette from both squares.
    glyph: 'bg-transparent border border-cloud rounded-full',
    sentence:
      'Unknown: this question could not be answered from what is recorded. It is neither a finding nor the absence of one.',
  },
}

export function CertaintyMarker({ certainty, compact = false, className }: CertaintyMarkerProps) {
  const m = MARKER[certainty]
  const copy = CERTAINTY_COPY[certainty]
  return (
    <span
      // `data-certainty` is what the structural tests assert on, and the hook
      // any future restyle must go through — so a restyle cannot quietly make
      // two bands identical without the tests noticing.
      data-certainty={certainty}
      title={m.sentence}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[4px] border font-mono font-medium whitespace-nowrap text-xs',
        compact ? 'px-1.5 py-0' : 'px-2 py-0.5',
        m.chip,
        className,
      )}
    >
      <span aria-hidden="true" className={cn('w-1.5 h-1.5 shrink-0', m.glyph)} />
      {copy.word}
      {/* The full claim, for assistive technology only. The chip stays dense. */}
      <span className="sr-only"> — {m.sentence}</span>
    </span>
  )
}

/**
 * Section heading for one certainty band.
 *
 * The three bands are separate landmarks with separate headings and separate
 * counts. This is the strongest structural guarantee available: a speculative
 * finding cannot be misread as proven when it is never in the proven list, and
 * `<section aria-labelledby>` makes that separation real for screen readers
 * rather than merely visual.
 *
 * Counts are per-section. There is no combined total anywhere in this tree —
 * summing bands is what launders conjecture into fact.
 */
interface CertaintySectionHeadingProps {
  certainty: Certainty
  /** DISTINCT REASONS in this band — the number the operator acts on. */
  reasonCount: number
  /** Distinct runs. Never added to another band's count. */
  runCount?: number
  id: string
}

export function CertaintySectionHeading({
  certainty,
  reasonCount,
  runCount,
  id,
}: CertaintySectionHeadingProps) {
  const copy = CERTAINTY_COPY[certainty]
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3 border-b border-graphite">
      <div className="flex items-center gap-2.5 min-w-0">
        <CertaintyMarker certainty={certainty} />
        <h2 id={id} className="text-sm font-semibold text-whiteout truncate">
          {copy.heading}
        </h2>
      </div>
      <div className="flex items-baseline gap-3 shrink-0 font-mono text-xs text-pewter tabular-nums">
        <span>
          <span className="text-whiteout">{reasonCount.toLocaleString()}</span>{' '}
          {certainty === 'indeterminate'
            ? reasonCount === 1
              ? 'question'
              : 'questions'
            : reasonCount === 1
              ? 'reason'
              : 'reasons'}
        </span>
        {runCount !== undefined && (
          <span>
            <span className="text-whiteout">{runCount.toLocaleString()}</span>{' '}
            {runCount === 1 ? 'run' : 'runs'}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The one-line epistemic caption under each section heading.
 *
 * Prose, not decoration. An operator arriving cold must be able to tell what a
 * section means without having learned the vocabulary, and the difference
 * between these three sentences is the difference the whole feature rests on.
 */
export function CertaintyCaption({ certainty }: { certainty: Certainty }) {
  return (
    <p className="px-4 py-2 text-xs text-pewter border-b border-graphite leading-relaxed">
      {CERTAINTY_COPY[certainty].caption}
    </p>
  )
}
