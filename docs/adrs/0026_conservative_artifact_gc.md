# ADR-0026: Artifact GC is deliberately conservative

**Status:** Accepted
**Date:** 2026-07-16
**Context:** Re-audit finding — "Artifact GC never reclaims the orphans it was built
for" (isArtifactReferenced keeps every run-level / no-eventId artifact forever).

---

## Context

The Phase 2 remediation changed `isArtifactReferenced` (convex/artifact_gc.ts) to
keep any artifact that (a) has no `eventId` (run-level), (b) has an `eventId`
whose event exists, or (c) is referenced by an `_externalized` payload. Only a
dangling `eventId` (set, but the event is missing) is reclaimable.

The re-audit correctly observes that, because events are immutable and never
deleted (Event Log Rule 1), the "dangling eventId" case is nearly unreachable — so
GC now reclaims almost nothing, and the original target orphan ("blob uploaded but
no event ever referenced it") is a run-level artifact that GC now keeps forever.

This is a real behavioural change and it is intentional. It is recorded here so the
tradeoff is a decision, not an accident.

## Decision

**Prefer leaking a small number of orphan blobs over ever destroying recorded
data.** The product's first-order guarantee is that a recorded run is complete and
trustworthy. A run-level artifact that carries no `eventId` and no `_externalized`
back-reference is *indistinguishable* from a legitimate supplementary artifact that
"hangs off the Run" (which CLAUDE.md explicitly permits). Since the two cannot be
told apart from stored state, deleting them risks destroying real recorded data —
which is strictly worse than the storage cost of keeping them.

GC therefore reclaims only unambiguous garbage (dangling `eventId` pointers) plus
whatever the paging sweep can safely identify, and is otherwise a no-op.

## Consequences

- **Positive:** GC can never delete a legitimate artifact. The Phase-2 data-loss
  finding stays closed.
- **Negative:** true dedup-race orphans (record created, its linking event never
  written) are not reclaimed and leak blob storage slowly.
- **Follow-up (Phase 5 — retention/tiering, ADR-0025 item 4):** the correct way to
  bound artifact storage at scale is a retention/tiering policy over the artifacts
  table (age + explicit lifecycle), NOT heuristic orphan-guessing. Until that lands,
  conservative GC is the safe default. If earlier reclamation is needed, add an
  explicit `orphanConfirmedAt` marker written by the ingest path when it *knows* a
  record was created without a linking event, and only GC records carrying it.
