/* eslint-disable */
/**
 * Generated data model types.
 *
 * Hand-authored to mirror `npx convex codegen` output (Convex 1.x). A real Convex
 * deployment regenerates this via `convex dev` / `convex deploy`; it is committed
 * so the `convex/` boundary is typechecked in CI (where no live deployment exists).
 * Keep in sync with the codegen template — do not add project logic here.
 */
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

/** The data model derived from the schema in `convex/schema.ts`. */
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;

/** A document from a given table. */
export type Doc<TableName extends TableNamesInDataModel<DataModel>> =
  DocumentByName<DataModel, TableName>;

/** An identifier for a document in a given table (or a system table). */
export type Id<
  TableName extends TableNamesInDataModel<DataModel> | SystemTableNames,
> = GenericId<TableName>;
