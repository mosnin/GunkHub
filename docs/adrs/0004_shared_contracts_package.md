# ADR-0004: Shared Contracts Package as the Single Type Authority

**Status:** Accepted
**Date:** 2026-04-09
**Deciders:** Initial foundation team (Prompt 1)

---

## Context

Agent Flight Recorder has three consumers of entity types and API shapes:

1. `apps/web` — Next.js web application (renders entity data, sends API requests)
2. `packages/sdk` — Client recording SDK (emits events, creates runs, sends API requests)
3. `convex/` — Backend schema and mutations (stores and serves data, validates input)

Without a shared source of truth for these types, **type drift** occurs silently. The SDK emits an `LlmRequestPayload` with a `messages` field; the API route expects a `prompts` field after a rename. The SDK compiles. The API compiles. Nothing breaks at build time. The failure is a runtime `400 Bad Request` that is hard to trace back to the type mismatch. This class of bug is preventable.

### The problem with duplicate types

If each package defines its own version of `Run`, `Event`, or `CreateEventRequest`, those definitions will diverge. This is not speculation — it is the observed behavior in every codebase that does this. Developers add fields to one copy without updating the others, rename fields inconsistently, or add different optional/required markers. The result is a system where TypeScript reports no errors but the runtime behavior is undefined.

### The problem with generated types

Code generation from OpenAPI specs or GraphQL schemas solves the divergence problem, but introduces a spec-writing step and a code generation pipeline. In a monorepo where TypeScript is already the shared language, generating TypeScript from a different source (YAML, GraphQL SDL) adds complexity and a new failure mode (out-of-date generated files).

---

## Decision

**`packages/contracts` is the single source of truth for all shared TypeScript types in Agent Flight Recorder.**

The rules that follow:

1. All entity interfaces (`Organization`, `Project`, `Agent`, `AgentVersion`, `Run`, `Event`, `Artifact`, `Comment`) live in `packages/contracts/src/entities.ts`. No other file may define these.

2. All event types (`EventType` union) and event payload shapes (`LlmRequestPayload`, `ToolCallPayload`, etc.) live in `packages/contracts/src/events.ts`. No other file may define these.

3. All API request and response shapes (`CreateRunRequest`, `CreateEventRequest`, `ListRunsResponse`, etc.) live in `packages/contracts/src/api.ts`. No other file may define these.

4. Derived projection types (`ReplayProjection`, `RunDiff`, etc.) live in `packages/contracts/src/replay.ts` and `packages/contracts/src/diff.ts`.

5. `packages/contracts` has **zero runtime dependencies**. It is pure TypeScript. If Zod validators are added for request validation, they must be tree-shakeable and must not pull in framework dependencies.

6. `packages/contracts` must never import from `apps/web`, `packages/sdk`, or `convex/`. The dependency arrow points only inward (contracts is a leaf node in the dependency graph).

7. Convex schema validator types (`v.string()`, `Id<"runs">`, etc.) are separate from contracts types. The shapes must stay aligned. When a contracts type changes, the Convex schema must be updated in the same PR.

8. When a field is added to, removed from, or renamed in any contracts type, the packages/contracts version must be bumped and all consumers must be updated in the same PR.

---

## Rationale

**Compile-time contract verification.** When the SDK imports `CreateEventRequest` from `@agent-flight-recorder/contracts`, any change to that type immediately produces a TypeScript error at the SDK's call sites. The developer knows immediately that their change has downstream impact. This catches contract mismatches before code ever runs.

**Single place to version.** When the API contract changes, bumping `packages/contracts`'s version number communicates the breaking change to all consumers simultaneously. There is one version to track, one changelog to update.

**No framework coupling.** `packages/contracts` has no Next.js, Convex, or React imports. It is plain TypeScript. This is important for the SDK: SDK consumers must not transitively import web framework code when they import the contracts. A React dependency in contracts would pull React into every SDK consumer's bundle.

**Prevents duplication and drift.** One canonical `Run` interface means there is no question about which definition is authoritative. When an engineer needs to know if `Run.endedAt` is optional, there is exactly one file to check.

**Enables SDK stability guarantees.** The SDK's public API stability is only meaningful if the underlying type contract is versioned and stable. `packages/contracts` is the versioned boundary. When it changes, the SDK version bumps. Consumers know to check the changelog.

---

## Consequences

**Breaking changes to contracts affect all consumers simultaneously.** This is a feature, not a bug. Type mismatches between the SDK and the API surface as build errors before deployment, not as runtime failures in production. The cost is that all consumers must be updated in the same PR — this is enforced by the pnpm workspace build order.

**Convex types are parallel, not derived.** Convex generates its own TypeScript types from `convex/schema.ts` (the `Id<"runs">` types, the `Doc<"events">` types). These are separate from the contracts types. A `Doc<"runs">` is a Convex internal type; a `contracts.Run` is the public-facing entity type. They must be kept aligned manually. A future linting step could compare the two and fail the build on divergence — this is a Prompt 3+ improvement.

**Build order must be correct.** Turborepo must build `packages/contracts` before `apps/web` and `packages/sdk`. This is configured in `turbo.json` via the `dependsOn` field. If the build order is wrong, consumers compile against stale type artifacts. Verify `turbo.json` in Prompt 2.

**No circular dependencies.** `packages/contracts` is a leaf node. It must never import from any other workspace package. ESLint's `import/no-cycle` rule should catch circular imports, but the simpler enforcement is: if you find yourself wanting to import from `apps/web` inside `packages/contracts`, you have a design problem, not a code problem.

---

## Enforcement Mechanisms

1. **Workspace dependency:** `"@agent-flight-recorder/contracts": "workspace:*"` in `apps/web/package.json` and `packages/sdk/package.json`. The `workspace:*` protocol ensures the live local version is always used, never a published version from npm.

2. **CLAUDE.md rule:** "All shared entity types live in packages/contracts only. Never duplicate entity types across packages. If you need a type in two places, put it in contracts and import it."

3. **ESLint `import type` rule:** All imports from `@agent-flight-recorder/contracts` must use `import type { ... }`, enforced by `@typescript-eslint/consistent-type-imports`. This prevents contracts from being imported as a runtime value, which would add it to the bundle even when only type information is needed.

4. **ESLint `no-restricted-imports` rule:** Relative imports that escape the package root (e.g., `../../other-package`) are forbidden. All cross-package imports must use the workspace package name. This makes dependency direction explicit and auditable.

5. **Turborepo pipeline:** `turbo.json` declares that `apps/web#build` and `packages/sdk#build` depend on `packages/contracts#build`. Turborepo enforces this ordering and caches the results.

6. **Version bump requirement:** The CLAUDE.md rule explicitly states: "Do not change a type in packages/contracts without bumping the package version. After bumping, update all consumers in the same PR."

---

## Alternatives Considered

### Option A: Types duplicated in each package

Each package defines its own version of `Run`, `Event`, `CreateEventRequest`, etc. Packages stay in sync by convention.

Rejected because: experience across many codebases shows that duplicated types always diverge. Convention is not a reliable enforcement mechanism at the speed of AI-assisted development. Type drift causes silent runtime failures that are expensive to debug.

### Option B: Code generation from OpenAPI spec

Define the API contract in OpenAPI YAML and generate TypeScript types for each consumer. The spec is the single source of truth; the generated types are derived.

Rejected because: OpenAPI adds a spec-writing step and a code generation pipeline. The generated files require careful gitignore/commit management. For a TypeScript monorepo with a small team, writing TypeScript directly in `packages/contracts` is faster, more readable, and directly checkable by TypeScript. OpenAPI generation can be added in v2 if a public HTTP API documentation requirement emerges.

### Option C: Shared types in Convex generated files

Use Convex's generated types (`convex/_generated/`) as the shared type source. The SDK and web app import from the Convex generated types.

Rejected because: Convex-generated types are tightly coupled to Convex's internal model (`Id<"runs">`, `Doc<"runs">`, mutation function references). Importing these into the SDK would make the SDK dependent on Convex internals, which must never leak into customer code. The contracts package provides a clean, implementation-agnostic layer.

### Option D: GraphQL schema as the contract

Define the entity model in GraphQL SDL and generate TypeScript types from it. Use the GraphQL schema as the single source of truth.

Rejected because: GraphQL adds significant tooling overhead (schema SDL, code generation, potentially a GraphQL server) that is not in the required stack and provides no clear benefit over TypeScript types at v1 scale. Not reconsidered until there is a specific need for a public, schema-driven API.
