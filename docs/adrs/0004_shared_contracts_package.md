# ADR 0004: Shared Contracts Package as the Type Authority

**Status:** Accepted  
**Date:** 2026-04-09

---

## Context

Agent Flight Recorder has three consumers of entity types and API shapes:
1. `apps/web` — Next.js web application (renders and requests data)
2. `packages/sdk` — Client recording SDK (emits events, creates runs)
3. `convex/` — Backend schema and mutations (stores and serves data)

Without a shared source of truth, types drift. An SDK might emit an event payload shape that the API no longer accepts. A component might render a field that no longer exists. These bugs are silent until runtime.

---

## Decision

**`packages/contracts` is the single source of truth for all shared TypeScript types.**

Rules:
1. All entity interfaces live in `packages/contracts/src/entities.ts`
2. All event types and payload shapes live in `packages/contracts/src/events.ts`
3. All API request/response types live in `packages/contracts/src/api.ts`
4. Convex schema types are separate (Convex generates its own) but must align
5. `packages/contracts` has zero runtime dependencies except Zod (optional validators)
6. `packages/contracts` is a direct workspace dependency of `apps/web` and `packages/sdk`

---

## Rationale

1. **Compile-time contract verification**: When the SDK imports `CreateEventRequest` from `@agent-flight-recorder/contracts`, any change to that type immediately surfaces as a TypeScript error in the SDK.

2. **Single place to version**: When the API contract changes, bumping the version in `packages/contracts` communicates the change to all consumers simultaneously.

3. **No framework coupling**: `packages/contracts` has no Next.js, Convex, or React imports. It's plain TypeScript. This means SDK consumers don't transitively import web framework code.

4. **Prevents duplication**: Before this package, every project that needs to define a `Run` type would define their own version. Inevitably they diverge. One canonical source prevents this entirely.

5. **Enables SDK stability**: The SDK's stability guarantee is only meaningful if the SDK imports from a stable, versioned types package. `packages/contracts` serves that role.

---

## Consequences

- **Breaking changes to contracts affect all consumers**: This is a feature, not a bug. It means breakage is visible and deliberate.
- **Convex types are separate**: Convex generates runtime validators and types from `convex/schema.ts`. These must be kept aligned with `contracts` manually. A future linting step could verify alignment.
- **Contracts must be built before dependents**: The Turbo pipeline ensures `packages/contracts` is built before `apps/web` or `packages/sdk` in CI.
- **No circular dependencies**: `packages/contracts` must never import from `apps/web` or `packages/sdk`.

---

## Enforcement Mechanisms

1. **Workspace dependency**: `"@agent-flight-recorder/contracts": "workspace:*"` in all consumer `package.json` files.
2. **`CLAUDE.md` rule**: "All shared types live in packages/contracts only. Never duplicate entity types across packages."
3. **`.eslintrc.js`**: `consistent-type-imports` rule ensures type imports are explicit and traceable.
4. **CI**: `packages/contracts typecheck` runs before `apps/web typecheck` and `packages/sdk typecheck`.

---

## Alternatives Considered

### Option A: Types duplicated in each package
- **Rejected**: Immediate drift risk. Experience shows these always diverge.

### Option B: Code generation from OpenAPI spec
- **Rejected**: Adds a spec-writing step that doesn't provide benefit over TypeScript types at v1 scale. OpenAPI generation can be added in v2 if a public API is needed.

### Option C: Shared types in Convex generated files
- **Rejected**: Convex-generated types include database IDs and other Convex internals that shouldn't leak into the SDK.

### Option D: GraphQL schema as the contract
- **Rejected**: GraphQL adds significant tooling overhead and is not in the required stack.
