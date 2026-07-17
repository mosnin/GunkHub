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

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { GC_CANDIDATE_PAGE_SIZE } from "./helpers/pagination.js";

import type { Id } from "./_generated/dataModel.js";


/** 24 hours in milliseconds. Artifacts younger than this are never considered orphans. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

// Internal function references — used by cleanOrphanedArtifacts action.
// We use makeFunctionReference because Convex _generated/api is not committed.
const _getOrphanCandidates = makeFunctionReference<"query">("artifact_gc:getOrphanCandidates");
const _isArtifactReferenced = makeFunctionReference<"query">("artifact_gc:isArtifactReferenced");
const _deleteArtifactRecord = makeFunctionReference<"mutation">("artifact_gc:deleteArtifactRecord");

/**
 * Returns one page of artifact records whose createdAt is older than ORPHAN_AGE_MS,
 * ordered oldest-first via the by_created_at index. At most GC_CANDIDATE_PAGE_SIZE
 * candidates are returned per call. Pass the returned nextCursor to page forward.
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

/**
 * Returns true if the artifact is still reachable and must NOT be deleted.
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
 */
export const isArtifactReferenced = internalQuery({
  args: {
    artifactId: v.id("artifacts"),
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    // Artifact already gone (deleted by a concurrent run) — nothing to reclaim.
    if (!artifact) return true;

    if (artifact.eventId !== undefined) {
      // Event-attached artifact: permanently retained while its event exists.
      const event = await ctx.db.get(artifact.eventId);
      if (event) return true;
      // Dangling eventId (should not happen — events are never deleted). Fall
      // through to the pointer scan before declaring it reclaimable.
    } else {
      // Run-level artifact: only collectable once the run is terminal. A missing
      // run (purged via ADR 001) leaves the artifact unreachable — collectable.
      const run = await ctx.db.get(args.runId);
      if (run && !TERMINAL_RUN_STATUSES.has(run.status)) return true;
    }

    // Pointer scan: some event's _externalized payload may reference it by id.
    const events = await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();

    const idStr = args.artifactId as string;
    for (const e of events) {
      const payload = e.payload as {
        type?: string;
        _artifact?: { artifactId?: string };
      };
      if (
        payload.type === "_externalized" &&
        payload._artifact?.artifactId === idStr
      ) {
        return true;
      }
    }

    // Older than the safety threshold, run terminal (or gone), and nothing
    // references it: a genuine orphan. Safe to reclaim.
    return false;
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
 *   1. Load all orphan candidates (artifacts older than 24 h).
 *   2. For each, check whether any event references it.
 *   3. If unreferenced, DELETE the blob from Vercel Blob storage.
 *   4. Delete the Convex artifact record.
 *   5. Log results.
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
    // first page. Referenced artifacts are permanent residents of the candidate
    // set (oldest-first), so a single-page GC starves: it re-examines the same
    // immortal head every day and never reaches real orphans behind them.
    const MAX_PAGES = 50;

    let batch = 0;
    let cleaned = 0;
    let skipped = 0;
    let blobErrors = 0;
    let checkErrors = 0;
    let recordErrors = 0;

    let cursor: string | undefined = undefined;
    let pages = 0;

    for (;;) {
      const { candidates, nextCursor }: {
        candidates: Array<{ _id: Id<"artifacts">; runId: Id<"runs">; storageKey: string }>;
        nextCursor: string | undefined;
      } = await ctx.runQuery(_getOrphanCandidates, cursor ? { cursor } : {});
      batch += candidates.length;

      for (const artifact of candidates) {
        let referenced: boolean;
        try {
          referenced = await ctx.runQuery(_isArtifactReferenced, {
            artifactId: artifact._id,
            runId: artifact.runId,
          });
        } catch (err) {
          console.error(
            `Artifact GC: could not check references for artifact ${String(artifact._id)}: ${String(err)}`,
          );
          checkErrors++;
          continue;
        }

        if (referenced) {
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

    console.log(
      `Artifact GC: batch=${batch} pages=${pages} cleaned=${cleaned} skipped=${skipped} ` +
        `blobErrors=${blobErrors} checkErrors=${checkErrors} recordErrors=${recordErrors}`,
    );
    return { batch, cleaned, skipped, blobErrors, checkErrors, recordErrors };
  },
});
