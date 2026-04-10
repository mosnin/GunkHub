# ADR-0013: Diff Comparison Event Limit

**Date:** 2026-04-10
**Status:** Accepted

## Context

`getRunDiff` currently fetches all events for both runs with no upper bound before
computing the diff. A comparison of two 50,000-event runs would fetch 100,000 event
documents from Convex before the diff computation even begins. This causes the request
to block indefinitely, risks hitting Convex function timeouts, and places unbounded
memory pressure on the API route handler. There is no mechanism to warn users when a
diff is operating on a very large input.

## Decision

Cap event fetching at `MAX_EVENTS_PER_DIFF = 10_000` per run. When either run has more
events than the cap, set `RunDiff.truncated = true` in the response. Engineers see a
warning banner in the diff UI whenever `truncated` is true.

The constant is defined in `apps/web/src/lib/replay/diff.ts` alongside `buildRunDiff`
for discoverability and mirrors the naming convention of `MAX_EVENTS_PER_REPLAY`.

## Implementation

Truncation is enforced in the service layer (`fetchAllEvents` in
`apps/web/src/lib/services/diff.ts`), not inside `buildRunDiff`. This separation
keeps the pure diff function simple and independently testable — `buildRunDiff` always
receives a pre-sliced array and has no knowledge of limits.

The `fetchAllEvents` function exits the pagination loop early when `allDocs.length`
reaches `MAX_EVENTS_PER_DIFF`. The `truncated` flag is derived from whether a
`nextCursor` still exists at the point of early exit. Events are sliced to exactly
`MAX_EVENTS_PER_DIFF` before being passed to `buildRunDiff`.

`RunDiff.truncated` is an optional boolean field added to the existing interface in
`packages/contracts/src/diff.ts`. It is absent (undefined) on non-truncated diffs,
making this a non-breaking additive change. The contracts package is bumped from 0.5.0
to 0.6.0.

## Consequences

**Positive:**
- Large run comparisons complete in bounded time regardless of run length.
- Memory usage in the API route handler is bounded.
- `RunDiff.truncated` is additive and backward-compatible — existing consumers that
  do not read the field are unaffected.
- Engineers see an explicit orange warning banner when viewing a partial diff, so they
  know to check the full event log for complete analysis.
- The compared slice uses the lowest sequence-number events (oldest first), which
  represent the beginning of the run and are the most stable part of the trace.

**Negative / Known Risks:**
- An important divergence occurring at event 10,001 or beyond would be invisible in
  the diff display. Engineers must be aware that `truncated: true` means the comparison
  is incomplete.
- Engineers should manually inspect full event logs for both runs when `truncated: true`
  is shown, rather than relying solely on the diff view.
- The limit of 10,000 is a pragmatic choice for v1. If typical runs grow beyond this
  in practice, the constant can be raised and the ADR updated.
