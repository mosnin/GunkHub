import {
  compareSpendToLimit,
  spendStatement,
  spendUsability,
  type BudgetLimit,
  type SpendFigure,
} from '@agent-flight-recorder/contracts'

/**
 * ONE SPEND FIGURE, RENDERED AS WHAT IT IS.
 *
 * ---------------------------------------------------------------------------
 * THE COMPONENT THIS FILE EXISTS INSTEAD OF
 * ---------------------------------------------------------------------------
 *
 * The natural thing to build here is a progress bar. It is the single most
 * natural thing to build here, and it is a lie in visual form.
 *
 * A bar that fills toward a limit asserts a DENOMINATOR — it says "you are this
 * far along, and the remainder is yours". The figures this product has cannot
 * support that sentence. The counter-backed ones are add-only and unscaled, so
 * they are wrong only DOWNWARD, by an amount nobody has bounded: they can prove
 * a breach and can never prove compliance. There is no remainder to draw,
 * because the true position could be anywhere between the drawn mark and past
 * the end of the bar.
 *
 * Note that contracts refuses to make this renderable in the first place, and
 * the refusal is structural rather than advisory. There is no `amount` field —
 * a reconciled figure calls its number `reconciledAmount` and an approximate
 * one calls its number `estimatedAmount`, and the two types share NO property
 * at all — so `spend.amount / limit.limitAmount` does not compile. There is no
 * `headroomRemaining` on an armed breaker either. A percentage cannot be
 * computed here without first narrowing, at which point the author has typed
 * the word `estimated` and this doc is one hover away.
 *
 * So what is drawn instead is the ONE SENTENCE CONTRACTS COMPOSES, plus the
 * error bounds as text. `spendStatement` is deliberately the only prose a
 * surface should render for a figure: its approximate branch never states a
 * bare number, it names the estimate as an estimate, and it states the bounds
 * INCLUDING "unbounded" when they are `null`. Paraphrasing it here would be how
 * the caveat gets dropped.
 *
 * `null` IS NOT `0` IN THE BOUNDS ROW BELOW, and the two are rendered as
 * visibly different words. `couldUnderstateBy: null` means nobody measured how
 * wrong this can be — which is an honest thing to say and makes headroom
 * unestablishable. `couldUnderstateBy: 0` would be the claim that the figure
 * cannot be low. Rendering both as "0" would collapse the one distinction that
 * decides whether a breaker can ever arm.
 */
interface SpendFigureViewProps {
  figure: SpendFigure
  /** The limit this figure is about — each breaker state carries its own. */
  limit: BudgetLimit
}

/** How a bound is written. `null` gets a word, never a numeral, and never "0". */
function boundText(bound: number | null): string {
  return bound === null ? 'unbounded — nobody measured this' : String(bound)
}

const COMPARISON_TEXT: Record<ReturnType<typeof compareSpendToLimit>, string> = {
  provably_at_or_over: 'Establishes: the limit is reached or exceeded.',
  provably_under: 'Establishes: there is headroom, at this figure’s least favourable reading.',
  not_decidable:
    'Establishes nothing about this limit — the figure straddles it, or states no bound in the direction that ' +
    'would decide it.',
}

export function SpendFigureView({ figure, limit }: SpendFigureViewProps) {
  const usability = spendUsability(figure)

  if (usability === 'unusable') {
    return (
      <div className="rounded-[4px] border border-system-warning bg-graphite-deep p-3">
        <p className="text-xs font-mono uppercase tracking-wider text-ember">
          Unusable spend figure
        </p>
        <p className="mt-1.5 text-sm text-cloud leading-relaxed">
          This figure is not something arithmetic can be done with, so nothing at all follows from it about the
          limit. It is not being read as zero, and it is not being read as headroom.
        </p>
      </div>
    )
  }

  const comparison = compareSpendToLimit(figure, limit)

  return (
    <div className="rounded-[4px] border border-graphite bg-graphite-deep p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-mono uppercase tracking-wider text-neon-glow">
          {figure.basis === 'reconciled' ? 'Reconciled — summed from the event log' : 'Estimate — not a measurement'}
        </span>
        {figure.basis === 'approximate' && (
          <span className="text-xs font-mono text-pewter">source: {figure.kind}</span>
        )}
      </div>

      {/*
        THE CONTRACT'S OWN SENTENCE, VERBATIM. Not paraphrased, not truncated,
        not split across a tooltip — the hedge and the number are one sentence
        on purpose, and every way of separating them is a way of showing the
        number without the hedge.
      */}
      <p className="mt-2 text-sm text-whiteout leading-relaxed">{spendStatement(figure, limit)}</p>

      <p className="mt-2 text-sm text-pewter leading-relaxed">{COMPARISON_TEXT[comparison]}</p>

      {figure.basis === 'approximate' && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="font-mono text-pewter">could understate by</dt>
          <dd className="font-mono text-cloud">{boundText(figure.couldUnderstateBy)}</dd>
          <dt className="font-mono text-pewter">could overstate by</dt>
          <dd className="font-mono text-cloud">{boundText(figure.couldOverstateBy)}</dd>
          <dt className="font-mono text-pewter">for an exact figure</dt>
          <dd className="text-cloud leading-relaxed">{figure.wouldBeReconciledBy}</dd>
        </dl>
      )}

      {figure.basis === 'reconciled' && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="font-mono text-pewter">summed through</dt>
          <dd className="font-mono text-cloud tabular-nums">
            {new Date(figure.reconciledThrough).toISOString()}
          </dd>
          <dt className="font-mono text-pewter">events read</dt>
          <dd className="font-mono text-cloud tabular-nums">
            {figure.establishedBy.reduce((sum, proof) => sum + (proof.eventsSummed || 0), 0)}
          </dd>
        </dl>
      )}
    </div>
  )
}
