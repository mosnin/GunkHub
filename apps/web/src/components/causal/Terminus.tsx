/**
 * Terminus — how a causal chain stops. THREE components, never one with a
 * `kind`, because the three claims are not variations of each other.
 *
 * ===========================================================================
 * THE CLAIM THIS FILE CARRIES
 * ===========================================================================
 *
 *   RECORDED ORIGIN   The complete edge set into this run was read, and it is
 *                     empty. The recorded chain starts here. The walk is OVER.
 *
 *   CYCLE RE-ENTRY    The walk came back to a run it had already visited. It
 *                     CLOSED — nothing went unread — but a ring has no
 *                     earliest run, so there is no beginning to blame. Retry
 *                     loops and supervisor patterns are ordinary agent
 *                     architecture, so this is common rather than exotic.
 *
 *   TRAIL LOST        The walk ran out of road. This is NOT where the chain
 *                     ends, it is where we stopped being able to follow it.
 *                     There is more upstream and it is not on screen.
 *
 * The first two are COMPLETE frontiers and the third is not — but only the
 * first is an origin, and reporting a closed loop as a lost trail would state
 * something false about the scan just as surely as the reverse.
 *
 * TRAIL LOST is the common case in production — recording is opt-in and
 * best-effort — which is exactly why it must never borrow the origin's
 * treatment. An operator who reads a lost trail as an origin closes the
 * incident at the wrong agent while the real cause keeps firing.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE COMPONENTS AND NOT ONE PROP
 * ---------------------------------------------------------------------------
 *
 * `<Terminus kind={x} />` compiles just as happily with the wrong value, and
 * one day it would be — in a map over a merged list, in a copy-paste, in a
 * refactor that unified the three "for consistency".
 *
 * `packages/contracts/src/causality.ts` made the three share NO property
 * except the discriminant: `originRunId` + `hopsToOrigin` + `establishedBy`;
 * `reEnteredRunId` + `hopsToReEntry` + `cyclePath`; `lastReachedRunId` +
 * `hopsBeforeLoss` + `lostBecause` + `wouldBeRecoveredBy`. There is no field a
 * template could read without narrowing first — `t.runId` does not compile and
 * neither does `originRunId ?? lastReachedRunId`. This file keeps that barrier
 * at the RENDER boundary, which is where such barriers are usually lost — the
 * same decision `@/components/fleet/EvidenceMarker` and
 * `@/components/divergence/CertaintyMarker` made for their own bands.
 *
 * ---------------------------------------------------------------------------
 * COLOUR IS REINFORCEMENT. IT CARRIES NOTHING ON ITS OWN.
 * ---------------------------------------------------------------------------
 *
 * design.md's palette is one accent, one signal red and a greyscale ramp —
 * there is no second accent hue to spend on this even if colour were a safe
 * channel, and it is not: a screenshot pasted into an incident channel, a
 * screen reader, greyscale printing and forced-colors mode all lose it.
 *
 * So the distinction rides on SEVEN non-colour channels, any one sufficient:
 *
 *   1. THE WORD           `RECORDED ORIGIN` / `CYCLE RE-ENTRY` / `TRAIL LOST`.
 *                         No word appears under more than one, so a text
 *                         assertion for one cannot silently pass on another.
 *                         (An earlier surface here used PROVEN/UNPROVEN, where
 *                         it can; COMPLETE/INCOMPLETE would have repeated the
 *                         mistake exactly.)
 *   2. TRAILING GLYPH     nothing / `(o)` / `...`. Literal text characters, so
 *                         they survive being read aloud and being unstyled.
 *   3. FIELD LABELS       disjoint `<dt>`s, mirroring the contract's disjoint
 *                         fields. Origin: "Established by" / "Hops to origin".
 *                         Cycle: "The loop" / "Hops to re-entry". Lost: "Why
 *                         the trail stops here" / "To recover the trail" /
 *                         "Hops before loss". No label appears under two.
 *   4. DOM POSITION       the origin is a RUNG inside the ladder's `<ol>` — a
 *                         run the walk reached and proved. The other two are
 *                         `<aside>`s AFTER the list closes, because neither is
 *                         a proof about a rung. See `CausalLadder`.
 *   5. CONTAINED LIST     the cycle is the only terminus containing an `<ol>`
 *                         of its own — the loop path, which the contract
 *                         requires to be checkable against the edge set. A
 *                         cycle a reader cannot see is one they assume is a
 *                         bug in the tool.
 *   6. THE NUMBER'S NAME  `hopsToOrigin` and `hopsToReEntry` are TOTALS and are
 *                         printed as such; `hopsBeforeLoss` is a FLOOR and is
 *                         printed with "at least". The contract named the three
 *                         fields differently for this reason; printing them
 *                         under one label would flatten a certainty into a
 *                         lower bound — the `null`-versus-`0` defect in
 *                         numeric form.
 *   7. GRAMMATICAL MOOD   past indicative / present indicative about a shape /
 *                         negative existential with an explicit denial. A
 *                         listener knows which they are in without having
 *                         learned the vocabulary.
 *
 * The headline sentence for each comes from the contract's `originStatement`,
 * COMPOSED rather than transmitted, so no surface can phrase a lost trail in
 * the confident register.
 *
 * tests/unit/causal_ui_chain.test.tsx strips every `class`, `style`, `title`
 * and `data-*` attribute from the tree and asserts the three remain
 * distinguishable. With no classes there is no colour, no border style, no
 * fill and no glyph styling; with no `data-*` or `title` there is no hook only
 * a machine would read. Any real reader has strictly MORE information than
 * that test does.
 */

import { originStatement } from '@agent-flight-recorder/contracts'

import type { LostTrail, RecordedOrigin, TrailLossKind } from '@agent-flight-recorder/contracts'

import { truncateId } from '@/lib/utils'

const MARK =
  'inline-flex items-center gap-1.5 border font-mono font-medium whitespace-nowrap text-xs px-2 py-0.5'

const DL = 'mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs'
const DT = 'font-mono text-pewter whitespace-nowrap'
const DD = 'text-cloud leading-relaxed'

// ===========================================================================
// RECORDED ORIGIN — the walk is over
// ===========================================================================

/**
 * Rendered as the content of the LAST `<li>` of the ladder's ordered list,
 * because an origin IS a run the walk reached: it has a rung number, it is
 * navigable, and the run count includes it.
 *
 * Solid border, filled chip, solid square glyph, no trailing glyph, no next
 * move — there is nowhere further to go, and that is the entire message.
 */
export function RecordedOriginTerminus({ origin }: { origin: RecordedOrigin }) {
  // THE SAME ELEMENT-TRUST BUG AS `cyclePath`, on the higher-stakes claim.
  //
  // `Array.isArray` checked the container. A malformed element then reached
  // `truncateId(p.runId)` and crashed the panel — but the worse outcome is the
  // one that does NOT crash: a proof whose `inboundReadComplete` is not `true`,
  // or whose `inboundEdgesFound` is not `0`, or which read some OTHER run's
  // edge set, establishes NOTHING — and this component would have printed "the
  // complete inbound edge set of X was read" over it, under a confident
  // RECORDED ORIGIN badge.
  //
  // The contract calls that `unproven_origin` and describes it exactly: a LOST
  // TRAIL WEARING AN ORIGIN'S CLOTHES. The literal types (`true`, `0`) make it
  // unspellable in our code; a JSON body is typechecked by nobody, so it is
  // re-established here at the point of rendering the claim.
  const rawProofs: readonly unknown[] = Array.isArray(origin.establishedBy)
    ? origin.establishedBy
    : []
  const proofs = rawProofs.filter(
    (p): p is RecordedOrigin['establishedBy'][number] =>
      p !== null &&
      typeof p === 'object' &&
      typeof (p as { runId?: unknown }).runId === 'string' &&
      (p as { runId?: unknown }).runId === origin.originRunId &&
      (p as { inboundReadComplete?: unknown }).inboundReadComplete === true &&
      (p as { inboundEdgesFound?: unknown }).inboundEdgesFound === 0,
  )
  const proofIsSound = proofs.length === rawProofs.length && proofs.length > 0
  return (
    <div data-terminus="recorded_origin" className="mt-1">
      <span className={`${MARK} rounded-[4px] border-solid bg-graphite border-graphite-light text-cloud`}>
        <span aria-hidden="true" className="w-1.5 h-1.5 shrink-0 bg-cloud rounded-[4px]" />
        RECORDED ORIGIN
      </span>
      {/*
        The contract composes this sentence, including its own limit clause —
        "the origin of what was RECORDED". A surface that wrote its own would
        eventually write "root cause", which is the claim this type refuses.
      */}
      <p className="mt-2 text-xs text-cloud leading-relaxed">{originStatement(origin)}</p>
      <dl className={DL}>
        <dt className={DT}>Hops to origin</dt>
        <dd className={`${DD} font-mono tabular-nums`}>
          {origin.hopsToOrigin} — a total, because the walk reached the end
        </dd>
        <dt className={DT}>Established by</dt>
        <dd className={`${DD} font-mono`}>
          {!proofIsSound
            ? // Loud, not a footnote. Under a RECORDED ORIGIN badge, a quiet
              // "no proof" line is read as a formatting quirk rather than as
              // the retraction of the claim above it.
              <span className="text-ember">
                THIS ORIGIN IS UNPROVEN — the walk claims the chain ends here and carries no
                readable proof that this run’s inbound edge set was read complete and found empty.
                An origin without its proof is a lost trail wearing an origin’s clothes. Treat the
                chain as unfinished.
              </span>
            : proofs.map((p) => (
                <span key={`${p.runId}:${p.scannedAt}`} className="block">
                  the complete inbound edge set of{' '}
                  <span className="text-whiteout">{truncateId(p.runId, 16)}</span> was read, and it
                  held <span className="text-whiteout tabular-nums">{p.inboundEdgesFound}</span>{' '}
                  edges
                </span>
              ))}
        </dd>
      </dl>
      <span className="sr-only">
        Recorded origin: the complete set of edges into this run was read, and it was empty. The
        recorded chain begins here and the walk upstream is finished.
      </span>
    </div>
  )
}

// ===========================================================================
// TRAIL LOST — the walk is NOT over
// ===========================================================================

/**
 * The remedy differs sharply by `kind`, and stating which one applies is what
 * turns "I cannot tell" into "I cannot tell YET, and here is what to do".
 *
 * The two families matter to an operator in opposite ways: the first two are
 * OUR bound, so the data is still there and the fix is a bigger walk; the rest
 * are gaps in the record or in what is readable, so the fix is instrumentation
 * or retention. Both are LostTrail — neither can ever render as an origin —
 * but sending someone to instrument the SDK when they only needed a deeper
 * walk wastes the one resource an incident has none of.
 */
const LOSS_KIND_COPY: Readonly<Record<TrailLossKind, string>> = {
  depth_limit_reached:
    'We stopped, not the record. The chain continues past this point and those runs were simply not fetched.',
  budget_exhausted:
    'We stopped, not the record. The walk ran out of its row budget before expanding this frontier.',
  adjacent_run_unavailable:
    'The edge is real and the far end is gone: an adjacent run id is recorded, but the run itself is no longer readable — aged out under this org’s retention window, or purged.',
  edge_set_unreadable:
    'The edge set for this run could not be enumerated at all. Nothing was spent and nothing was read, so this says nothing about whether edges exist.',
  adjacency_unconfirmed:
    'This run’s edge set was read and came back empty, but the read could not be confirmed complete. THIS IS THE CASE THAT LOOKS EXACTLY LIKE AN ORIGIN AND IS NOT ONE.',
  convergence_not_followed:
    'The chain provably continues in more than one direction from here and the walk read none of them. There are several stories upstream of this run, not one — reading only the first is how the wrong thing gets rolled back.',
}

/**
 * Rendered as an `<aside>` AFTER the ladder's `</ol>`, because it does not
 * mark a run the walk proved anything about — it marks the place a run is
 * MISSING. It carries no rung number, and the list it follows is explicitly
 * not the whole chain.
 *
 * Dotted border, no fill, hollow circle glyph, a `...` that says the sequence
 * continues, and a first sentence that DENIES the origin reading outright
 * rather than leaving an operator to infer the difference under pressure.
 */
export function LostTrailTerminus({ lost }: { lost: LostTrail }) {
  return (
    <aside
      data-terminus="trail_lost"
      className="mt-3 border border-dotted border-graphite-light rounded-[4px] p-3"
    >
      <span className={`${MARK} rounded-full border-dotted bg-transparent border-graphite-light text-ember`}>
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 shrink-0 bg-transparent border border-ember rounded-full"
        />
        TRAIL LOST ...
      </span>
      <p className="mt-2 text-xs text-cloud leading-relaxed">
        <span className="text-whiteout">This is not where the chain began.</span>{' '}
        {originStatement(lost)}
      </p>
      <dl className={DL}>
        <dt className={DT}>Hops before loss</dt>
        <dd className={`${DD} font-mono tabular-nums`}>
          at least {lost.hopsBeforeLoss} — a floor, because the chain continues past here by an
          unknown amount
        </dd>
        <dt className={DT}>Why the trail stops here</dt>
        <dd className={DD}>
          <span className="font-mono text-pewter">{lost.kind}</span> —{' '}
          {LOSS_KIND_COPY[lost.kind] ?? 'The walk stopped here.'} {lost.lostBecause}
        </dd>
        <dt className={DT}>To recover the trail</dt>
        <dd className={DD}>{lost.wouldBeRecoveredBy}</dd>
      </dl>
      <span className="sr-only">
        Trail lost: is this the origin? No. The walk stopped for want of a road, which is not the
        same as a record saying nothing produced this run. The chain is unfinished, and whatever
        caused the failure may be beyond everything shown.
      </span>
    </aside>
  )
}

// ===========================================================================
// CYCLE RE-ENTRY — the walk closed, but there is no beginning to reach
// ===========================================================================

/**
 * The third frontier, and the one that is neither of the other two.
 *
 * The walk CLOSED here — nothing went unread, so the contract counts it as a
 * complete frontier alongside `RecordedOrigin`. But it is emphatically NOT an
 * origin: the recorded edges loop, so there is no earliest run and no chain
 * beginning to blame. An operator who reads it as an origin blames whichever
 * run happens to sit at the top of a ring.
 *
 * Rendered as an `<aside>` after the `</ol>`, like a lost trail, because it is
 * not a proof about a rung. Distinguished from a lost trail by its word, its
 * `(o)` glyph, its disjoint field labels, and — the structural one — by the
 * `<ol>` of the loop path it contains, which neither other terminus has. The
 * contract requires that path to be checkable against the edge set, so showing
 * it is what lets a reader verify the loop rather than assume the tool is
 * broken.
 */
export function CycleReEntryTerminus({
  cycle,
}: {
  cycle: { terminus: 'cycle_reentry'; reEnteredRunId: string; hopsToReEntry: number; cyclePath: readonly string[] }
}) {
  // A REQUIRED ARRAY'S ELEMENTS ARE AS UNTRUSTED AS A REQUIRED FIELD.
  //
  // `Array.isArray(cycle.cyclePath)` checked the CONTAINER and nothing else,
  // and it silently widened the elements to `any` on the way through — TS's
  // `Array.isArray` is `(arg: any) => arg is any[]`, so narrowing a
  // `readonly string[]` through it discards the element type. A wire payload of
  // `[null, {}, 'run_a']` then passed the guard and reached `truncateId`, which
  // slices its argument: a crash on the one screen whose entire purpose is to
  // be readable during an incident.
  //
  // AND DROPPING THE BAD ELEMENTS WOULD BE WORSE THAN CRASHING. A cycle path is
  // checkable precisely because every consecutive pair must be a recorded edge;
  // a filtered path is a SHORTER ring whose hops no longer correspond to
  // anything, which is a fabricated loop rendered as a verified one. So a path
  // that is not wholly readable is not rendered as a path at all.
  const rawPath: readonly unknown[] = Array.isArray(cycle.cyclePath) ? cycle.cyclePath : []
  const path = rawPath.filter((r): r is string => typeof r === 'string' && r.length > 0)
  const pathIsReadable = path.length === rawPath.length && path.length > 0
  return (
    <aside
      data-terminus="cycle_reentry"
      className="mt-3 border border-dashed border-graphite-light rounded-[4px] p-3"
    >
      <span className={`${MARK} rounded-[4px] border-dashed bg-transparent border-graphite-light text-pewter`}>
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 shrink-0 bg-transparent border border-pewter rounded-[4px]"
        />
        CYCLE RE-ENTRY (o)
      </span>
      <p className="mt-2 text-xs text-cloud leading-relaxed">
        <span className="text-whiteout">There is no beginning to reach.</span> The recorded edges
        loop back to{' '}
        <span className="font-mono text-whiteout">{truncateId(cycle.reEnteredRunId, 16)}</span>, so
        the walk closed rather than stopped — nothing went unread — but a ring has no earliest run.
        {/*
          Deliberately not "at least one edge": `at least` is the FLOOR's
          phrase, and it belongs to `hopsBeforeLoss` alone. A total that
          contains it anywhere in its text invites the hedge to be read onto
          the number beside it.
        */}
        Causation does not form a loop, so some edge in it records something that did not happen in
        the order it claims.
      </p>
      <dl className={DL}>
        <dt className={DT}>Hops to re-entry</dt>
        <dd className={`${DD} font-mono tabular-nums`}>
          {cycle.hopsToReEntry} — a total, because the walk closed the loop
        </dd>
        <dt className={DT}>The loop</dt>
        <dd className={DD}>
          {/*
            The one terminus that contains an ordered list, and the reason it
            does is the contract's: "a cycle a reader cannot see is a cycle
            they will assume is a bug in the tool". Every consecutive pair is
            a recorded edge in this same traversal, so it is checkable.
          */}
          {pathIsReadable ? (
            <ol className="flex flex-col gap-0.5 font-mono">
              {path.map((runId, i) => (
                <li key={`${runId}:${i}`} className="text-cloud">
                  {i + 1}. {truncateId(runId, 20)}
                </li>
              ))}
            </ol>
          ) : (
            // Not a shorter loop — no loop. A partial ring reads as a verified
            // one, and the whole value of showing the path is that a reader can
            // check each hop against the edges above.
            <span className="text-ember">
              LOOP PATH UNREADABLE — this frontier claims the walk closed, and the loop it names
              cannot be read, so nothing here can be checked against the edges above. Treat the
              chain as unfinished.
            </span>
          )}
        </dd>
      </dl>
      <span className="sr-only">
        Cycle re-entry: the walk came back to a run it had already visited. This frontier closed,
        but it is not an origin — the recorded edges form a ring, and a ring has no first run.
      </span>
    </aside>
  )
}

/**
 * The header's state word for one frontier.
 *
 * Deliberately NOT `COMPLETE` / `INCOMPLETE`: one contains the other, so a
 * text assertion for the first passes on the second, and a reader skimming at
 * 3am sees the same seven letters. These three share no word.
 */
export const TERMINUS_STATE_WORD = {
  recorded_origin: 'ENDS AT RECORDED ORIGIN',
  cycle_reentry: 'CLOSED ON A LOOP',
  trail_lost: 'TRAIL LOST',
} as const
