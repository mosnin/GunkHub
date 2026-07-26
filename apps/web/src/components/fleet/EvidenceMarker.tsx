/**
 * EvidenceMarker — THREE markers, three components, never one with a `kind`.
 *
 * ===========================================================================
 * WHY THREE COMPONENTS AND NOT ONE PROP
 * ===========================================================================
 *
 * `<Marker certainty={x}>` compiles just as happily with the wrong value
 * passed, and one day would be — in a map over a merged list, in a copy-paste,
 * in a refactor that unified the sections "for consistency". `ObservedMarker`,
 * `HypothesisMarker` and `UnansweredMarker` take no arguments that could be
 * wrong. The mistake is unrepresentable rather than merely unlikely.
 *
 * This mirrors the contract's own barrier: `ObservedCorrelation`,
 * `HypothesisedCause` and `UnansweredFleetQuestion` do not unify, each
 * carrying a required field the others lack (`observedBy` / `sharedBy` +
 * `wouldBeTestedBy` / `unknownBecause`). The component layer keeps that
 * barrier rather than dissolving it at the render boundary — which is exactly
 * where such barriers are usually lost.
 *
 * ---------------------------------------------------------------------------
 * COLOUR IS REINFORCEMENT. IT CARRIES NOTHING ON ITS OWN.
 * ---------------------------------------------------------------------------
 *
 * design.md's palette is one accent (Neon Glow), one signal red and a
 * greyscale ramp. There is no second and third accent hue to spend on three
 * epistemic bands even if colour were a safe channel — and it is not: a
 * screenshot pasted into an incident channel, a screen reader, greyscale
 * printing and forced-colors mode all lose it.
 *
 * So the distinction rides on five NON-COLOUR channels, any one sufficient:
 *
 *   1. THE WORD          `OBSERVED` / `HYPOTHESIS` / `UNANSWERED`. Spelled
 *                        out, monospace. NO ONE IS A SUBSTRING OF ANOTHER —
 *                        an earlier surface in this codebase used
 *                        `PROVEN`/`UNPROVEN`, where a text assertion for the
 *                        first silently passes on the second.
 *   2. TRAILING GLYPH    nothing / `?` / `—`. Literal text characters, so they
 *                        survive being read aloud and being stripped of style.
 *   3. BORDER STYLE      solid / dashed / dotted. Three geometries, no hue.
 *   4. SILHOUETTE        filled 4px square / hollow pill / hollow circle.
 *                        Three shapes at 6px, plus two different radii.
 *   5. GRAMMATICAL MOOD  the visually-hidden sentence is past indicative,
 *                        interrogative, and interrogative-about-the-scan
 *                        respectively. A listener knows which band they are in
 *                        without having learned the vocabulary.
 *
 * tests/unit/fleet_ui_correlation.test.tsx strips every `class`, `style`,
 * `title` and `data-*` attribute from the tree and asserts the three remain
 * distinguishable by text alone. Any real reader — greyscale, screen reader,
 * forced-colors, colour-vision-deficient — has strictly more information than
 * that test does.
 */

const CHIP =
  'inline-flex items-center gap-1.5 border font-mono font-medium whitespace-nowrap text-xs px-2 py-0.5'

/**
 * A RECORDED FACT: this happened, on these agents, cited by these rows.
 * Solid border, filled chip, solid square glyph, 4px container radius.
 */
export function ObservedMarker() {
  return (
    <span
      data-band="observed"
      className={`${CHIP} rounded-[4px] border-solid bg-graphite border-graphite-light text-ember`}
    >
      <span aria-hidden="true" className="w-1.5 h-1.5 shrink-0 bg-ember rounded-[4px]" />
      OBSERVED
      <span className="sr-only">
        {' '}
        — observed: this was recorded on the agents and runs cited. It is a fact about what
        happened, and it says nothing about why.
      </span>
    </span>
  )
}

/**
 * A PROPOSAL: someone should test this. Dashed border, no fill, hollow pill
 * glyph, pill container radius — the one shape design.md reserves for buttons,
 * because "this is not a container of facts" is exactly the read wanted, and it
 * is unmistakable beside the square.
 */
export function HypothesisMarker() {
  return (
    <span
      data-band="hypothesis"
      className={`${CHIP} rounded-full border-dashed bg-transparent border-graphite-light text-pewter`}
    >
      <span
        aria-hidden="true"
        className="w-1.5 h-1.5 shrink-0 bg-transparent border border-pewter rounded-full"
      />
      HYPOTHESIS ?
      <span className="sr-only">
        {' '}
        — hypothesis: could this be the shared cause? Nothing recorded establishes that it is. It is
        a question to test, not a finding to act on.
      </span>
    </span>
  )
}

/**
 * A QUESTION THE SCAN COULD NOT DECIDE. Dotted border, no fill, hollow circle
 * glyph, 4px radius. Neither a finding nor the absence of one — and never
 * silently dropped, because a gap rendered as nothing reads as "nothing wrong".
 */
export function UnansweredMarker() {
  return (
    <span
      data-band="unanswered"
      className={`${CHIP} rounded-[4px] border-dotted bg-transparent border-graphite-light text-cloud`}
    >
      <span
        aria-hidden="true"
        className="w-1.5 h-1.5 shrink-0 bg-transparent border border-cloud rounded-full"
      />
      UNANSWERED —
      <span className="sr-only">
        {' '}
        — unanswered: could the scan decide this? It could not. This is neither a finding nor the
        absence of one, and it is why the scan as a whole is not a clean bill of health.
      </span>
    </span>
  )
}
