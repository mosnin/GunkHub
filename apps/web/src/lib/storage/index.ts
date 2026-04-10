/**
 * Blob storage barrel export.
 * Consumers import from '@/lib/storage' to get the adapter interface,
 * threshold constant, and the active adapter for the current environment.
 *
 * Returns the active BlobStorageAdapter for the current runtime environment.
 *
 * Resolution order:
 * 1. BLOB_STORAGE_PROVIDER === "vercel" → VercelBlobAdapter (not yet implemented)
 * 2. Fallback → StubBlobStorageAdapter (in-memory, for local dev and CI)
 *
 * When a production adapter is added, import it here and wire it up.
 */
import { stubAdapter } from "./stub";

import type { BlobStorageAdapter } from "./adapter";

export type { BlobStorageAdapter, ArtifactPointer } from "./adapter";
export { PAYLOAD_EXTERNALIZATION_THRESHOLD, sha256Hex } from "./adapter";
export { StubBlobStorageAdapter, stubAdapter } from "./stub";

export function getStorageAdapter(): BlobStorageAdapter {
  const provider = process.env["BLOB_STORAGE_PROVIDER"];
  if (provider === "vercel") {
    // Vercel Blob adapter — implement in v1.1 when BLOB_READ_WRITE_TOKEN is available.
    // See docs/adrs/0006_artifact_externalization.md for the implementation spec.
    throw new Error(
      "Vercel Blob adapter is not yet implemented. Set BLOB_STORAGE_PROVIDER to a supported value or leave unset for the stub adapter.",
    );
  }
  // Default: stub adapter for local dev and CI.
  return stubAdapter;
}
