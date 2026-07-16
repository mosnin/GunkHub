/* eslint-disable */
/**
 * Generated API utilities.
 *
 * Hand-authored to mirror `npx convex codegen` output (Convex 1.x). A real Convex
 * deployment regenerates this via `convex dev` / `convex deploy` with fully-typed
 * per-module references; the `anyApi` form used here resolves function references
 * by name (`internal.<module>.<fn>`) so the backend typechecks in CI without a live
 * deployment. Keep in sync with the codegen template — do not add project logic here.
 */
import { anyApi } from "convex/server";
import type { AnyApi } from "convex/server";

/** References to this app's public functions, addressed as `api.<module>.<fn>`. */
export const api: AnyApi = anyApi;
/** References to this app's internal functions, addressed as `internal.<module>.<fn>`. */
export const internal: AnyApi = anyApi;
