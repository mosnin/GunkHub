# ADR-0018 — Event Deep Link URL Contract

**Status:** Accepted  
**Date:** 2026-04-10

## Context

Engineers debugging run failures often need to share the exact event they are inspecting
with teammates. Without a stable URL, sharing requires describing the event verbally.

## Decision

The run detail URL supports a `?event=<sequenceNumber>` query parameter:
- `sequenceNumber` is the integer assigned by the SDK (stable, human-readable, 1-based).
- When `?event=N` is present, the EventInspector auto-selects the matching event on mount.
- As the user navigates events via keyboard or mouse, the URL is updated in-place using
  `history.replaceState` (no page reload, no browser history entry added).
- A "Copy link" button in the EventInspector right panel header copies the current URL
  (which already includes the updated `?event=N` parameter).

## Consequences

- URLs containing `?event=N` remain valid as long as the event sequence is intact.
- `history.replaceState` does not add history entries; the browser Back button
  returns to the previous page, not a previous event selection.
- Tab navigation (`?tab=events`) is additive — `?tab=events&event=5` is a valid URL.
