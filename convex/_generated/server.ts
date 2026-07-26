/* eslint-disable */
/**
 * Generated server utilities for implementing Convex functions.
 *
 * Hand-authored to mirror `npx convex codegen` output (Convex 1.x). A real Convex
 * deployment regenerates this via `convex dev` / `convex deploy`; it is committed
 * so the `convex/` boundary is typechecked in CI (where no live deployment exists).
 * Keep in sync with the codegen template — do not add project logic here.
 */
import {
  actionGeneric,
  httpActionGeneric,
  queryGeneric,
  mutationGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  type ActionBuilder,
  type HttpActionBuilder,
  type MutationBuilder,
  type QueryBuilder,
  type GenericActionCtx,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type GenericDatabaseReader,
  type GenericDatabaseWriter,
} from "convex/server";
import type { DataModel } from "./dataModel.js";

/** Define a query that is part of this app's public API. */
export const query = queryGeneric as unknown as QueryBuilder<DataModel, "public">;
/** Define a query that is only accessible from other Convex functions. */
export const internalQuery = internalQueryGeneric as unknown as QueryBuilder<
  DataModel,
  "internal"
>;
/** Define a mutation that is part of this app's public API. */
export const mutation = mutationGeneric as unknown as MutationBuilder<DataModel, "public">;
/** Define a mutation that is only accessible from other Convex functions. */
export const internalMutation = internalMutationGeneric as unknown as MutationBuilder<
  DataModel,
  "internal"
>;
/** Define an action that is part of this app's public API. */
export const action = actionGeneric as unknown as ActionBuilder<DataModel, "public">;
/** Define an action that is only accessible from other Convex functions. */
export const internalAction = internalActionGeneric as unknown as ActionBuilder<
  DataModel,
  "internal"
>;
/** Define an HTTP action. */
export const httpAction = httpActionGeneric as unknown as HttpActionBuilder;

/** A set of services for use within Convex query functions. */
export type QueryCtx = GenericQueryCtx<DataModel>;
/** A set of services for use within Convex mutation functions. */
export type MutationCtx = GenericMutationCtx<DataModel>;
/** A set of services for use within Convex action functions. */
export type ActionCtx = GenericActionCtx<DataModel>;
/** Reader interface for the Convex database within queries. */
export type DatabaseReader = GenericDatabaseReader<DataModel>;
/** Writer interface for the Convex database within mutations. */
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
