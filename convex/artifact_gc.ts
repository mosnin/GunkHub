// Artifact garbage collection — scheduled job helpers.
// Detects and removes orphaned artifact records (blob uploaded but no event
// ever referenced the artifact) to prevent unbounded growth in Convex and
// Vercel Blob storage.
//
// Orphan definition: a RUN-LEVEL artifact (no eventId) whose createdAt is older
// than ORPHAN_AGE_MS, whose parent run is TERMINAL, and for which no event in
// the same run has a payload with type "_externalized" referencing this
// artifact's _id. Event-attached artifacts are permanently retained.
//
// Safety: the 24-hour age threshold ensures that artifacts created during an
// in-progress run (blob uploaded, event not yet flushed) are never deleted.
//
// ECONOMICS (sticky references + bounded scans): the naive design re-scanned
// every event of every candidate's run on every daily GC — O(artifacts×events)
// forever, and a `.collect()` on a ~50k-event run blows the query read limit.
// Two fixes:
//   1. STICKY REFERENCE — when the pointer scan (or, normally, sdkCreateEvents
//      at write time) finds that an event references an artifact, the artifact
//      is patched with `referencedByEventId`. Events are immutable, so a
//      reference can never be un-made: the artifact permanently leaves the
//      candidate set. Artifacts are metadata pointers, NOT events — patching
//      this GC bookkeeping field does not violate event-log immutability.
//   2. BOUNDED SCANS — the pointer scan pages through events (no `.collect()`),
//      caps events examined per candidate, and the action caps TOTAL events
//      examined per invocation; unresolved candidates carry over to the next
//      scheduled run (they remain in the candidate set until resolved).

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import {
  GC_CANDIDATE_PAGE_SIZE,
  GC_EVENT_SCAN_PAGE_SIZE,
  GC_MAX_EVENTS_PER_CANDIDATE,
  GC_MAX_EVENTS_PER_INVOCATION,
} from "./helpers/pagination.js";

import type { Id } from "./_generated/dataModel.js";


/** 24 hours in milliseconds. Artifacts younger than this are never considered orphans. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

// Internal function references — used by cleanOrphanedArtifacts action.
// We use makeFunctionReference because Convex _generated/api is not committed.
const _getOrphanCandidates = makeFunctionReference<"query">("artifact_gc:getOrphanCandidates");
const _checkArtifactReference = makeFunctionReference<"query">("artifact_gc:checkArtifactReference");
const _markArtifactReferenced = makeFunctionReference<"mutation">("artifact_gc:markArtifactReferenced");
const _deleteArtifactRecord = makeFunctionReference<"mutation">("artifact_gc:deleteArtifactRecord");

/**
 * Returns one page of artifact records whose createdAt is older than ORPHAN_AGE_MS,
 * ordered oldest-first via the by_created_at index. At most GC_CANDIDATE_PAGE_SIZE
 * candidates are returned per call. Pass the returned nextCursor to page forward.
 *
 * Artifacts with a sticky `referencedByEventId` are excluded — a reference to an
 * immutable event can never be un-made, so they are permanently non-orphans.
 *
 * These are candidates for orphan detection — not guaranteed to be orphaned yet.
 */
export const getOrphanCandidates = internalQuery({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - ORPHAN_AGE_MS;

    const page = await ctx.db
      .query("artifacts")
      .withIndex("by_created_at", (q) => q.lt("createdAt", cutoff))
      .filter((q) => q.eq(q.field("referencedByEventId"), undefined))
      .paginate({
        numItems: GC_CANDIDATE_PAGE_SIZE,
        cursor: args.cursor ?? null,
      });

    return {
      candidates: page.page,
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
  },
});

// Terminal run statuses — a run in one of these states can never gain new events,
// so its artifact reference set is final and safe to evaluate.
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Verdict of a bounded reference check for one candidate artifact. */
export interface ReferenceCheckResult {
  /**
   * "referenced"    → must NOT be deleted (sticky-stampable if referencingEventId set)
   * "orphan"        → safe to reclaim
   * "indeterminate" → scan budget exhausted before a verdict; keep, retry later
   */
  verdict: "referenced" | "orphan" | "indeterminate";
  /** Set when the pointer scan found the referencing event (for sticky stamping). */
  referencingEventId?: Id<"events">;
  /** Events examined by this check (counted against the invocation budget). */
  eventsScanned: number;
}

/**
 * Bounded reference check for one candidate artifact.
 *
 * Semantics:
 * - Event-attached artifacts (eventId set, event exists) are permanently
 *   retained — they are recorded data hanging off the immutable event log.
 * - Run-level artifacts (eventId === undefined) — the actual orphan case, e.g.
 *   the SDK uploaded a blob but the externalized event never flushed — are
 *   collectable ONLY when ALL of:
 *     (a) the parent run is TERMINAL (no new events can arrive),
 *     (b) the artifact is older than the 24 h safety threshold (guaranteed by
 *         getOrphanCandidates' createdAt cutoff), and
 *     (c) no event payload's `_externalized` pointer references its id
 *         (pointer shape: payload._artifact.artifactId — see contracts
 *         ExternalizedPayload).
 *
 * The pointer scan is PAGED (never `.collect()`) and stops after
 * min(maxEventsToScan, GC_MAX_EVENTS_PER_CANDIDATE) events. If the budget runs
 * out before the run's events are exhausted, the verdict is "indeterminate" and
 * the artifact is kept for a later invocation — deletion requires a full scan.
 */
export const checkArtifactReference = internalQuery({
  args: {
    artifactId: v.id("artifacts"),
    runId: v.id("runs"),
    maxEventsToScan: v.number(),
  },
  handler: async (ctx, args): Promise<ReferenceCheckResult> => {
    const artifact = await ctx.db.get(args.artifactId);
    // Artifact already gone (deleted by a concurrent run) — nothing to reclaim.
    if (!artifact) return { verdict: "referenced", eventsScanned: 0 };

    // Sticky reference already stamped — permanently retained.
    if (artifact.referencedByEventId !== undefined) {
      return { verdict: "referenced", eventsScanned: 0 };
    }

    if (artifact.eventId !== undefined) {
      // Event-attached artifact: permanently retained while its event exists.
      const event = await ctx.db.get(artifact.eventId);
      if (event) return { verdict: "referenced", eventsScanned: 0 };
      // Dangling eventId (should not happen — events are never deleted). Fall
      // through to the pointer scan before declaring it reclaimable.
    } else {
      // Run-level artifact: only collectable once the run is terminal. A missing
      // run (purged via ADR 001) leaves the artifact unreachable — collectable.
      const run = await ctx.db.get(args.runId);
      if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
        return { verdict: "referenced", eventsScanned: 0 };
      }
    }

    // Pointer scan: some event's _externalized payload may reference it by id.
    // Paged and budget-bounded — see module header.
    const budget = Math.max(
      0,
      Math.min(args.maxEventsToScan, GC_MAX_EVENTS_PER_CANDIDATE),
    );
    const idStr = args.artifactId as string;
    let scanned = 0;
    let cursor: string | null = null;

    while (scanned < budget) {
      const page = await ctx.db
        .query("events")
        .withIndex("by_run", (q) => q.eq("runId", args.runId))
        .paginate({
          numItems: Math.min(GC_EVENT_SCAN_PAGE_SIZE, budget - scanned),
          cursor,
        });

      for (const e of page.page) {
        scanned++;
        const payload = e.payload as {
          type?: string;
          _artifact?: { artifactId?: string };
        };
        if (
          payload.type === "_externalized" &&
          payload._artifact?.artifactId === idStr
        ) {
          return {
            verdict: "referenced",
            referencingEventId: e._id,
            eventsScanned: scanned,
          };
        }
      }

      if (page.isDone) {
        // Full scan completed: run terminal (or gone), older than the safety
        // threshold, and nothing references it — a genuine orphan.
        return { verdict: "orphan", eventsScanned: scanned };
      }
      cursor = page.continueCursor;
    }

    // Budget exhausted before the run's events were exhausted: no verdict.
    return { verdict: "indeterminate", eventsScanned: scanned };
  },
});

/**
 * Stamp an artifact with the event that references it (sticky reference), so it
 * permanently leaves the GC candidate set. Patches ARTIFACT metadata only —
 * never an event — so event-log immutability is untouched. Idempotent: an
 * already-stamped or already-deleted artifact is a no-op.
 */
export const markArtifactReferenced = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    eventId: v.id("events"),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.referencedByEventId !== undefined) return;
    await ctx.db.patch(args.artifactId, { referencedByEventId: args.eventId });
  },
});

/**
 * Hard-delete a single artifact record from Convex. Called only after the blob
 * has been deleted (or deletion was skipped because BLOB_STORE_TOKEN is not set).
 */
export const deleteArtifactRecord = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.artifactId);
  },
});

/**
 * Orchestrate the full GC flow. Runs as a Convex internalAction so it can
 * make outbound HTTP requests (blob DELETE) and call internal queries/mutations.
 *
 * Algorithm:
 *   1. Page through orphan candidates (artifacts older than 24 h without a
 *      sticky reference).
 *   2. For each, run a bounded reference check (paged pointer scan).
 *   3. Referenced with a known referencing event → stamp the sticky reference
 *      so the artifact never re-enters the candidate set.
 *   4. Orphaned → DELETE the blob from Vercel Blob storage, then the record.
 *   5. Indeterminate (scan budget exhausted) → keep; retry next invocation.
 *
 * Budgets: at most MAX_PAGES candidate pages and GC_MAX_EVENTS_PER_INVOCATION
 * events examined per invocation; the remainder carries over to the next
 * scheduled run.
 *
 * If BLOB_STORE_TOKEN is not set in Convex env vars, blob deletion is skipped
 * and a warning is logged. The Convex record is still deleted to prevent
 * orphaned metadata accumulating indefinitely.
 *
 * If the blob DELETE call fails, the artifact record is left in place and the
 * error is logged — preserving the Convex record as a pointer means the failure
 * can be retried in a future GC run.
 */
export const cleanOrphanedArtifacts = internalAction({
  args: {},
  handler: async (ctx) => {
    const blobToken = process.env["BLOB_STORE_TOKEN"];
    if (!blobToken) {
      console.warn(
        "Artifact GC: BLOB_STORE_TOKEN is not set in Convex environment variables. " +
          "Blob deletion will be skipped; only Convex records will be cleaned.",
      );
    }

    // Bound total pages per run so a pathological backlog cannot exceed the action
    // time budget, but page THROUGH candidates rather than only ever touching the
    // first page. Sticky references shrink the immortal head of the candidate set
    // over time; anything unprocessed carries over to the next scheduled run.
    const MAX_PAGES = 50;

    let batch = 0;
    let cleaned = 0;
    let skipped = 0;
    let stamped = 0;
    let indeterminate = 0;
    let blobErrors = 0;
    let checkErrors = 0;
    let recordErrors = 0;
    let eventsScanned = 0;

    let cursor: string | undefined = undefined;
    let pages = 0;
    let scanBudgetExhausted = false;

    outer: for (;;) {
      const { candidates, nextCursor }: {
        candidates: Array<{ _id: Id<"artifacts">; runId: Id<"runs">; storageKey: string }>;
        nextCursor: string | undefined;
      } = await ctx.runQuery(_getOrphanCandidates, cursor ? { cursor } : {});
      batch += candidates.length;

      for (const artifact of candidates) {
        const remainingScanBudget = GC_MAX_EVENTS_PER_INVOCATION - eventsScanned;
        if (remainingScanBudget <= 0) {
          scanBudgetExhausted = true;
          break outer;
        }

        let check: ReferenceCheckResult;
        try {
          check = await ctx.runQuery(_checkArtifactReference, {
            artifactId: artifact._id,
            runId: artifact.runId,
            maxEventsToScan: remainingScanBudget,
          });
        } catch (err) {
          console.error(
            `Artifact GC: could not check references for artifact ${String(artifact._id)}: ${String(err)}`,
          );
          checkErrors++;
          continue;
        }
        eventsScanned += check.eventsScanned;

        if (check.verdict === "indeterminate") {
          // No verdict within budget — keep and retry in a later invocation.
          indeterminate++;
          continue;
        }

        if (check.verdict === "referenced") {
          if (check.referencingEventId !== undefined) {
            // Sticky-stamp so this artifact permanently leaves the candidate set.
            try {
              await ctx.runMutation(_markArtifactReferenced, {
                artifactId: artifact._id,
                eventId: check.referencingEventId,
              });
              stamped++;
            } catch (err) {
              console.error(
                `Artifact GC: failed to stamp sticky reference on artifact ${String(artifact._id)}: ${String(err)}`,
              );
            }
          }
          skipped++;
          continue;
        }

        // Attempt blob deletion first. If it fails, leave the Convex record intact
        // so the next GC run can retry the blob delete.
        if (blobToken) {
          try {
            const res = await fetch(
              `https://blob.vercel-storage.com/${artifact.storageKey}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${blobToken}` },
              },
            );
            if (!res.ok && res.status !== 404) {
              throw new Error(
                `Vercel Blob DELETE returned ${res.status} ${res.statusText}`,
              );
            }
          } catch (err) {
            console.error(
              `Artifact GC: blob DELETE failed for artifact ${String(artifact._id)} (key=${artifact.storageKey}): ${String(err)}`,
            );
            console.warn(`Artifact GC: artifact ${String(artifact._id)} will be retried in the next scheduled GC run`);
            blobErrors++;
            continue; // Leave the Convex record so the next run can retry
          }
        }

        // Blob deleted (or skipped) — now remove the Convex record
        try {
          await ctx.runMutation(_deleteArtifactRecord, {
            artifactId: artifact._id,
          });
          cleaned++;
        } catch (err) {
          console.error(
            `Artifact GC: Convex record delete failed for artifact ${String(artifact._id)}: ${String(err)}`,
          );
          recordErrors++;
        }
      }

      pages++;
      if (nextCursor === undefined) break;
      if (pages >= MAX_PAGES) {
        console.log(
          `Artifact GC: reached MAX_PAGES=${MAX_PAGES}; remaining candidates will be processed in the next scheduled run.`,
        );
        break;
      }
      cursor = nextCursor;
    }

    if (scanBudgetExhausted) {
      console.log(
        `Artifact GC: event-scan budget (${GC_MAX_EVENTS_PER_INVOCATION}) exhausted; remaining candidates carry over to the next scheduled run.`,
      );
    }

    console.log(
      `Artifact GC: batch=${batch} pages=${pages} cleaned=${cleaned} skipped=${skipped} stamped=${stamped} ` +
        `indeterminate=${indeterminate} eventsScanned=${eventsScanned} ` +
        `blobErrors=${blobErrors} checkErrors=${checkErrors} recordErrors=${recordErrors}`,
    );
    return {
      batch,
      cleaned,
      skipped,
      stamped,
      indeterminate,
      eventsScanned,
      blobErrors,
      checkErrors,
      recordErrors,
    };
  },
});
