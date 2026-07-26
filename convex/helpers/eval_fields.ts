// ADR-002 — pure validation for the evals table, shared by the Clerk-gated
// convex/evals.ts (recordEval) and the API-key path convex/sdk_ingest.ts
// (sdkRecordEval, which must not import auth.ts). Same rationale as
// helpers/run_fields.ts.

import { afrError } from "./errors.js";
import { MAX_EVAL_DETAILS_BYTES, MAX_EVAL_NAME_LENGTH } from "./pagination.js";

export function validateEvalFields(args: {
  name: string;
  score?: number;
  details?: string;
}): void {
  if (args.name.length === 0 || args.name.length > MAX_EVAL_NAME_LENGTH) {
    throw afrError(
      "INVALID_ARGUMENT",
      `Eval name must be 1-${MAX_EVAL_NAME_LENGTH} characters`,
    );
  }
  if (args.score !== undefined && (args.score < 0 || args.score > 1)) {
    throw afrError("INVALID_ARGUMENT", "Eval score must be between 0 and 1");
  }
  if (args.details !== undefined) {
    const bytes = new TextEncoder().encode(args.details).length;
    if (bytes > MAX_EVAL_DETAILS_BYTES) {
      throw afrError(
        "INVALID_ARGUMENT",
        `Eval details is ${bytes} bytes, exceeding the ${MAX_EVAL_DETAILS_BYTES}-byte limit`,
      );
    }
  }
}
