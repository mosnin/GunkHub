export interface PaginationOptions {
  limit: number;
  cursor?: string;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Maximum number of events to include in a single replay projection.
 * Runs exceeding this limit will have their projection truncated and
 * the ReplayProjection.truncated flag set to true.
 */
export const MAX_EVENTS_PER_REPLAY = 10_000;

/**
 * Maximum number of artifact orphan candidates to process in a single GC run.
 * Limits the number of blob DELETE calls and Convex mutations per daily cron invocation.
 * Older candidates (lowest createdAt) are processed first via the by_created_at index.
 */
export const GC_CANDIDATE_PAGE_SIZE = 100;
