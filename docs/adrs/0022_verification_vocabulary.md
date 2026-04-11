# ADR-0022: Verification State Vocabulary

**Status:** Accepted  
**Date:** 2026-04-11  
**Context:** Prompt 24 — Verification actionability

---

## Context

The verification system gained surface-level discoverability in Prompt 23 (Integrity column, filter pills, dashboard section). However, the vocabulary was inconsistent:

- `IntegrityBadge` showed: `unverified`, `seq verified`, `verified`, `check failed`
- Filter pills showed: `all`, `verified`, `seq_verified`, `failed`, `unverified`
- Filter label abbreviated `seq_verified` as `seq`
- `VerificationPanel` used "Sequence-only" for the same concept

This created two competing label systems engineers had to learn: the badge vocabulary and the filter vocabulary. The mapping was correct but not obvious.

---

## Decision

Adopt a single 4-term vocabulary shared across all product surfaces:

| State | Meaning |
|-------|---------|
| `unverified` | No verification has been run for this run |
| `partial` | Sequence integrity checked and passed; full derivation (replay + failureSummary) not run |
| `verified` | Full derivation verified: sequence + replay + failureSummary all passed |
| `failed` | Any check failed: sequence gap, duplicate, replay failure, or failureSummary failure |

**Mapping to underlying `VerificationStatus` fields:**
- `unverified`: `status.verified === false`
- `partial`: `status.isValid === true && !status.checksRan.includes('replay')`
- `verified`: `status.isValid === true && status.checksRan.includes('replay')`
- `failed`: `status.isValid === false` (regardless of which check failed)

**Changes applied:**
1. `IntegrityBadge`: `seq verified` → `partial`, `check failed` → `failed`
2. `runs/page.tsx` filter: `seq_verified` URL param value → `partial`, filter label `seq` → `partial`
3. `VerificationPanel`: "Sequence-only — full derivation check requires..." → "Partial — sequence checked only. Full derivation requires..."

---

## Consequences

### Positive
- One vocabulary for operators to learn
- Filter values match badge labels exactly (1:1 relationship)
- `partial` is shorter, clearer, and technically accurate than `seq verified`
- `failed` matches common operator terminology better than `check failed`
- Filter URL params are stable and predictable going forward

### Negative
- **Breaking change to filter URL parameter**: `?verify=seq_verified` becomes `?verify=partial`. Any existing bookmarks, shared links, or external scripts using `seq_verified` will silently degrade to `all` (safe but invisible to the operator).
- `partial` is less precise than `seq_verified` in terms of technical specifics, but the title attribute on the badge retains the technical detail: "Sequence-only verified (partial — full derivation not run)".

### Rationale for choosing 'partial' over alternatives
- `seq_verified` is implementation-specific (references "sequence" which is the check name, not the state)
- `partial` conveys the completeness level without requiring knowledge of the internal check structure
- It maps directly to the common meaning: "we checked part of it, not all of it"
- Engineers who want the technical detail can read the title tooltip or the VerificationPanel CheckPill row

---

## Hard-to-reverse nature

This decision is hard to reverse because:
1. The URL parameter is now `partial` — changing it back would re-break bookmarks
2. The badge label change affects any screenshot documentation, runbooks, or external tooling that matches on the badge text
3. The 4-term vocabulary becomes the contract for future work (Prompt 25+)

If a future prompt needs a 5th state (e.g., `errored` for infrastructure failures), it should be added without renaming the existing 4.

---

## Alternatives considered

**Keep `seq_verified`:** Preserves URL compatibility but maintains the two-vocabulary problem. Rejected.

**Use `sequence_ok` or `seq_ok`:** Technically precise but uses check names as state names — tight coupling to implementation. Rejected.

**Use `passing` / `failing`:** Loses the distinction between "full derivation passed" and "sequence-only passed". Rejected.
