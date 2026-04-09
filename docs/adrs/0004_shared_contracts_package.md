# ADR 0004: Shared Contracts Package (@afr/contracts)

**Status:** Accepted
**Date:** April 2026
**Deciders:** Team A (Platform), Team B (Data), Team D (SDK)

---

## Context

Agent Flight Recorder has three TypeScript consumers that must agree on the shape of domain data:

1. **`@afr/sdk`** — The SDK serializes events into `Event` objects and sends them to the ingest endpoint. It must produce payloads that match what the API expects.
2. **`apps/web`** API routes — The ingest endpoint deserializes the SDK's payload. It must use the same types.
3. **`apps/web`** UI — Components render `Run`, `Event`, `Agent`, etc. They must use the same types as the rest of the system.
4. **`convex/`** functions — Queries return and mutations accept domain types. They must use the same types.

Without a shared type definition, each consumer defines its own version of these types. They will silently diverge. A field added to `Event` in the SDK but not in the web app's deserializer is a silent runtime bug.

We need a single, authoritative source of TypeScript types shared across all consumers.

---

## Decision

We will maintain a dedicated workspace package, `packages/contracts`, published internally as `@afr/contracts`.

**`@afr/contracts` is the leaf package.** It imports from nothing else in this repository. It exports:
- All domain entity types: `Organization`, `Project`, `Agent`, `AgentVersion`, `Run`, `Event`, `Artifact`, `Comment`
- All enum types: `RunStatus`, `EventKind`, `MemberRole`, `ArtifactKind`
- All Zod schemas for runtime validation of ingest requests and API responses
- Utility types: `CreateRunInput`, `IngestEventsRequest`, `EventPayloadByKind`
- The `assertNever` utility for exhaustive switch statement checking

All other packages import from `@afr/contracts` using the package name (never a relative path). The dependency graph is:

```
@afr/contracts (leaf, no internal deps)
  ↑
  ├── @afr/sdk
  ├── apps/web
  └── convex/ (via tsconfig paths or workspace:*)
```

---

## Alternatives Considered

### Option A: Each package defines its own types

The SDK defines `Event`. The web app defines `Event` separately. They happen to match (by convention).

**Rejected because:**
- Convention is not enforced by the type system. Divergence is inevitable and silent.
- A type change requires finding and updating every duplicate definition.
- This is how systems rot.

### Option B: Types defined in `apps/web` and imported by the SDK

The web app is the source of truth. The SDK imports from `apps/web`.

**Rejected because:**
- Creates a circular dependency: web app depends on SDK, SDK depends on web app.
- The SDK should be independently publishable and usable outside this monorepo.
- The web app is a consuming package, not a library.

### Option C: Types generated from the Convex schema (single source of truth)

Convex generates TypeScript types from the schema. All consumers import the generated types.

**Considered seriously but rejected for v1 because:**
- Convex generates types in `convex/_generated/` — these are gitignored and require running `npx convex dev` to generate. Importing them in `@afr/sdk` (which is meant to be usable without Convex) would couple the SDK to Convex's tooling.
- The Convex-generated types use Convex-specific types (`Id<"runs">`, `Doc<"events">`) that are not appropriate for the SDK's public API.
- This approach can be revisited post-v1 if type drift between contracts and Convex schema becomes a problem. A validation test (that checks contracts types are assignable to Convex types and vice versa) is the right mitigation.

### Option D (chosen): Dedicated shared contracts package

Separate package, leaf node in the dependency graph. Simple, well-precedented, and tooling-friendly.

---

## Consequences

### Positive

- **Single source of type truth:** There is exactly one definition of `Event`. All consumers are guaranteed to agree.
- **Refactoring is safe:** Renaming a field in `@afr/contracts` immediately produces TypeScript errors in every consumer. The fix is atomic.
- **SDK is self-contained:** The SDK depends on `@afr/contracts` only. It has no dependency on Convex, Next.js, or the web app.
- **Clear ownership:** Team B owns `@afr/contracts`. Changes require Team B review.
- **Zod schemas co-located with types:** The contracts package can export both the TypeScript type and the Zod schema for the same shape, ensuring runtime validation uses the same definition as the static type.

### Negative / Trade-offs

- **Additional package to maintain:** Every type change requires building `@afr/contracts` before rebuilding consumers. Turbo handles this automatically via `dependsOn: ["^build"]`, but it adds build time.
- **Contracts must be designed carefully:** Because all consumers depend on this package, a breaking change to a type in contracts breaks everything simultaneously. Semver discipline and backward-compatible additions (optional fields) are essential.
- **Convex schema may drift:** The Convex schema is defined in `convex/schema.ts` separately from the contracts types. If someone adds a field to the Convex schema without adding it to `@afr/contracts`, they are inconsistent. A validation test (or Convex's generated types being assignable to contracts types) is the mitigation.

### Invariants Established by This Decision

- `@afr/contracts` has zero internal dependencies (no `workspace:*` deps on other AFR packages).
- `@afr/contracts` may depend on external packages only: `zod` for schemas, and nothing else unless justified by ADR.
- All imports of domain types in `@afr/sdk`, `apps/web`, and `convex/` use `import type { Event } from "@afr/contracts"` (never relative paths).
- Adding a new field to an entity type: add as optional (`field?: Type`) to maintain backward compatibility.
- Removing or renaming a field: create an ADR, bump the major version of `@afr/contracts`, migrate all consumers atomically.
- New `EventKind` values must be added to the `EventKind` union in contracts before any code that produces or consumes that kind is written.
- The `assertNever` utility in contracts must be used in all switch statements that enumerate `EventKind` or `RunStatus` to ensure exhaustiveness.

### Build Configuration

`packages/contracts/package.json` exports:
```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

Built with `tsup` for both ESM and CJS output, enabling use in both Node.js and edge runtimes.
