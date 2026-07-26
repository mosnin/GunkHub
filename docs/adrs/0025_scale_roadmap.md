# ADR-0025: Scaling beyond v1 — sequenced scope changes

**Status:** Proposed (awaiting ratification per feature)
**Date:** 2026-07-16
**Context:** Product direction — "a world-class system that can enable autonomous
AI agents at scale." Several capabilities that direction implies are on the
CLAUDE.md "Not in v1" freeze. This ADR is the mechanism the constitution requires
("do not implement … until v1 ships and the decision is revisited") to revisit
that freeze deliberately, one capability at a time, rather than lifting it wholesale.

---

## Context

After Phases 0–4 the recorder is correct, secure, tested, and deployable within
v1 scope. The remaining distance to "at scale" is a set of capabilities the freeze
currently forbids. Building them blind (without a live Convex deployment and load
testing) is how regressions ship, so each is gated behind its own ADR, its own
success metric, and a live-environment build.

## Decision — sequence and gating

Pursue in this order; each item gets a dedicated ADR (Accepted) before code:

1. **Live event streaming (replaces 5 s polling).** Move active-run views to
   Convex reactive subscriptions (`useQuery`) instead of `fetch`-based polling.
   Revisits "real-time collaboration / live streaming." *Metric:* new-event
   latency p95 < 1 s; zero duplicate rows. *Requires:* Convex React client wired
   into `apps/web`, live env to validate reactivity.

2. **High-throughput ingestion.** A batch ingest endpoint with idempotency keys,
   per-key rate limiting, and backpressure signalling to the SDK; optional queue
   in front of Convex for burst absorption. Revisits "multi-region / distributed
   ingestion" (single-region first). *Metric:* sustained N k events/s per org
   without ingest errors; bounded Convex write contention.

3. **Fleet health & aggregates.** Run-volume, failure-rate, and p95-latency views
   across many agents, computed from a maintained rollup table (not scanned at
   query time). Revisits "analytics dashboards / aggregate metrics." *Metric:*
   dashboard query < 200 ms at 10^7 runs.

4. **Retention & tiering.** Cold-storage tiering for the events table so unbounded
   growth stays cost-bounded; immutable log preserved, old events moved to blob
   with a manifest. *Metric:* Convex document-store size bounded independent of
   total historical event count.

5. **Alerting integrations.** Webhooks / notifications on run failure. Revisits
   "webhooks / external integrations." *Metric:* delivered failure alert < 30 s.

## Non-negotiables carried into every item

- Org tenancy enforced on every new function (proven by a convex-test case).
- Event log stays append-only and immutable; rollups/streams are derived, never
  the source of truth.
- Each new env var documented in `.env.example` before merge.
- Each capability lands behind its own Accepted ADR that updates the CLAUDE.md
  "Not in v1" list for exactly that item — the freeze is lifted surgically, never
  wholesale.

---

## Consequences

- Provides a ratified, ordered path from "correct v1" to "at scale" without a
  big-bang scope change.
- Nothing here is built until its ADR is Accepted AND a live deployment exists to
  validate it, keeping the "verify before ship" discipline that Phases 0–4 held.
