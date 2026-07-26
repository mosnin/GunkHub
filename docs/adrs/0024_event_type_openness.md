# ADR-0024: Event `type` is intentionally open

**Status:** Accepted
**Date:** 2026-07-16
**Context:** Audit finding — "schema `Event.type` (v.string()) and `payload`
(v.any()) do not align exactly with the closed `EventType` union in contracts."

---

## Context

The audit flagged that `convex/schema.ts` declares `events.type` as `v.string()`
and `payload` as `v.any()`, while `packages/contracts` declares a closed
`EventType` discriminated union (`run.started | run.completed | run.failed | …`).
The finding read this as drift ("shapes must align exactly").

They do not need to align exactly, and closing them would be a regression. The SDK
deliberately supports **custom event types**: `RunRecorder.recordEvent(type, payload)`
accepts any string, and `Recorder.recordEvent` accepts arbitrary payloads. Agents
record domain-specific events (`tool.call`, `llm.request`, `retrieval.hit`, and
user-defined types) that are not — and should not be — enumerated in the shared
contract. Externalized payloads (`type: "_externalized"`) are also a runtime-only
shape not present in the public entity contract.

---

## Decision

- `events.type` stays `v.string()` (open) and `events.payload` stays `v.any()`.
- The `EventType` union in contracts enumerates only the **lifecycle** types that
  carry semantics the backend and UI reason about (first/terminal events). It is a
  convenience for typed SDK helpers and UI rendering, **not** a closed whitelist of
  everything that may be recorded.
- The invariants the backend DOES enforce on `type` are behavioural, not
  structural, and are enforced in code (not the validator): `run.completed` /
  `run.failed` are terminal (Rule 5), and the SDK emits `run.started` first. These
  are covered by `convex/backend.test.ts`.

This resolves the finding: the two are aligned on the lifecycle types by intent,
and the divergence on custom types is a designed feature, not drift. The
schema-drift checker (`scripts/check-schema-drift.ts`) continues to validate the
entity field shapes that MUST match.

---

## Consequences

- Custom event types keep working; no breaking change to the SDK surface.
- A typo'd lifecycle type (e.g. `run.complete`) is not rejected by the validator,
  but the projection verifier and terminal-event checks catch the meaningful cases.
  If stricter lifecycle-type validation is wanted later, add an allowlist check in
  `sdkCreateEvents` for the `run.*` namespace only — without closing the whole field.
