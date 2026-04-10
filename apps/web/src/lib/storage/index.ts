/**
 * Blob storage barrel export.
 * Consumers import from '@/lib/storage' to get the adapter interface,
 * threshold constant, and the active adapter for the current environment.
 *
 * Returns the active BlobStorageAdapter for the current runtime environment.
 *
 * Resolution order:
 * 1. BLOB_STORE_TOKEN env var is set → VercelBlobAdapter (production)
 * 2. Fallback → StubBlobStorageAdapter (dev/CI, in-memory, data lost on restart)
 *
 * When a production adapter is added, import it here and wire it up.
 */
import { stubAdapter } from "./stub";
import { vercelBlobAdapter } from "./vercel";

import type { BlobStorageAdapter } from "./adapter";

export type { BlobStorageAdapter, ArtifactPointer } from "./adapter";
export { PAYLOAD_EXTERNALIZATION_THRESHOLD, sha256Hex } from "./adapter";
export { StubBlobStorageAdapter, stubAdapter } from "./stub";

export function getStorageAdapter(): BlobStorageAdapter {
  const token = process.env["BLOB_STORE_TOKEN"];
  if (token) {
    return vercelBlobAdapter;
  }
  // Default: stub adapter for local dev and CI.
  return stubAdapter;
}
