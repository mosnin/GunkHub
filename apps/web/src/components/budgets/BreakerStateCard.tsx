import type { BreakerState } from '@agent-flight-recorder/contracts'

import { SpendFigureView } from '@/components/budgets/SpendFigureView'
import { BREAKER_STATE_LABEL } from '@/lib/budgets/vocabulary'

/**
 * ONE BREAKER'S STATE.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIELD IS READ AFTER NARROWING, AND NOTHING IS SPREAD
 * ---------------------------------------------------------------------------
 *
 * Contracts gives the three states no field in common — they are
 * `trippedBudgetId` / `armedBudgetId` / `undeterminedBudgetId`, and
 * `trippedLimit` / `armedLimit` / `undeterminedLimit` — precisely so that no
 * renderer can print one under another's heading by forgetting to narrow.
 * `state.budgetId` does not compile on any of them.
 *
 * This component honours that rather than routing around it. There is no
 * `{...state}` spread anywhere below and no shared accessor pulling the id out
 * before the switch: a spread would put a `tripped` state's fields into a JSX
 * scope where an `armed` heading is one edit away, and a shared accessor would
 * re-open exactly the collapse the three distinct names exist to prevent.
 *
 * ---------------------------------------------------------------------------
 * THE THREE BANDS ARE DISTINGUISHED BY WORDS FIRST AND COLOUR SECOND
 * ---------------------------------------------------------------------------
 *
 * Strip every class from this file and the three still read as three different
 * things, because each carries its own heading text and its own explanation.
 * Colour is redundant reinforcement, never the carrier — and specifically,
 * `undetermined` IS NOT DRAWN AS A CALM OR SUCCESSFUL STATE. In this deployment
 * it is the most common state by a wide margin: every counter-backed budget
 * sitting below its limit reports it, because the counter can prove a breach
 * and can never prove compliance. A quiet green row would teach an operator
 * that the majority of their screen means "fine", when it means "we cannot
 * tell, and we will tell you the moment it provably crosses".
 *
 * NOTHING BELOW CLAIMS AN AGENT WAS STOPPED. A tripped breaker is a fact about
 * the BREAKER; the trip statement is the server's own composed prose, rendered
 * verbatim under a heading that says whose fact it is.
 */
interface BreakerStateCardProps {
  state: BreakerState
}

export function BreakerStateCard({ state }: BreakerStateCardProps) {
  if (state.state === 'tripped') {
    const label = BREAKER_STATE_LABEL.tripped
    return (
      <article className="rounded-[4px] border border-system-warning bg-graphite-deep p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full bg-system-warning shadow-[var(--shadow-glow-warn)] shrink-0"
            />
            <h3 className="text-sm font-semibold text-whiteout">{label.label}</h3>
          </span>
          <code className="text-xs font-mono text-pewter">{state.trippedBudgetId}</code>
          <span className="text-xs font-mono text-pewter">
            {state.trippedBy === 'manual_trip' ? 'tripped by an operator' : 'limit reached'}
          </span>
          <time
            dateTime={new Date(state.trippedAt).toISOString()}
            className="text-xs font-mono text-pewter tabular-nums"
          >
            {new Date(state.trippedAt).toISOString()}
          </time>
        </header>
        <p className="mt-2 text-sm text-cloud leading-relaxed">{label.meaning}</p>
        {/* The server's own past-tense account, verbatim. Composed there under a
            guard that forbids execution claims; rephrasing it here is how a
            caveat gets dropped. */}
        <p className="mt-2 text-sm text-whiteout leading-relaxed">{state.trippedBecause}</p>
        <div className="mt-3 flex flex-col gap-2">
          <h4 className="text-xs font-mono uppercase tracking-wider text-pewter">
            Evidence ({state.determinedFrom.length})
          </h4>
          {state.determinedFrom.map((figure, index) => (
            <SpendFigureView key={index} figure={figure} limit={state.trippedLimit} />
          ))}
        </div>
      </article>
    )
  }

  if (state.state === 'armed') {
    const label = BREAKER_STATE_LABEL.armed
    return (
      <article className="rounded-[4px] border border-graphite-light bg-graphite-deep p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full bg-neon-glow shadow-[var(--shadow-glow)] shrink-0"
            />
            <h3 className="text-sm font-semibold text-whiteout">{label.label}</h3>
          </span>
          <code className="text-xs font-mono text-pewter">{state.armedBudgetId}</code>
          <time
            dateTime={new Date(state.establishedAt).toISOString()}
            className="text-xs font-mono text-pewter tabular-nums"
          >
            {new Date(state.establishedAt).toISOString()}
          </time>
        </header>
        <p className="mt-2 text-sm text-cloud leading-relaxed">{label.meaning}</p>
        <div className="mt-3 flex flex-col gap-2">
          <h4 className="text-xs font-mono uppercase tracking-wider text-pewter">
            Evidence for headroom ({state.establishedUnderBy.length})
          </h4>
          {state.establishedUnderBy.map((figure, index) => (
            <SpendFigureView key={index} figure={figure} limit={state.armedLimit} />
          ))}
        </div>
      </article>
    )
  }

  const label = BREAKER_STATE_LABEL.undetermined
  return (
    <article className="rounded-[4px] border border-graphite-light bg-graphite-deep p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex items-center gap-2">
          {/* No glow. A glow reads as powered-on hardware; this state is the
              absence of a reading, not a live one. */}
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-pewter shrink-0" />
          <h3 className="text-sm font-semibold text-whiteout">{label.label}</h3>
        </span>
        <code className="text-xs font-mono text-pewter">{state.undeterminedBudgetId}</code>
        <span className="text-xs font-mono text-pewter">{state.kind}</span>
      </header>
      <p className="mt-2 text-sm text-cloud leading-relaxed">{label.meaning}</p>
      <p className="mt-2 text-sm text-whiteout leading-relaxed">{state.undeterminedBecause}</p>
      {/* The difference between a product that says "I cannot tell" and one that
          says "I cannot tell YET, and here is what to do". A state that reads as
          a shrug is one people learn to configure around. */}
      <div className="mt-3 rounded-[4px] border border-graphite bg-graphite p-3">
        <p className="text-xs font-mono uppercase tracking-wider text-pewter">What would decide it</p>
        <p className="mt-1 text-sm text-whiteout leading-relaxed">{state.wouldBeDeterminedBy}</p>
      </div>
    </article>
  )
}
