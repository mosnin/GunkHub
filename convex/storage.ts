// Storage abstraction for large payload externalization.
//
// Architecture note: In v1, large payloads (> AFR_PAYLOAD_SIZE_THRESHOLD_BYTES)
// are uploaded to blob storage (Vercel Blob in production) and referenced via
// Artifact records in the database. The actual upload happens in API route handlers,
// not in Convex functions (Convex functions cannot make arbitrary HTTP calls without actions).
//
// Future evolution: If we move to a dedicated ingest service, the upload logic
// moves there. The Artifact schema and pointer pattern stays the same.

export const PAYLOAD_SIZE_THRESHOLD_BYTES = 8 * 1024; // 8 KB

export interface BlobStorageAdapter {
  upload(key: string, data: Buffer | Uint8Array, mimeType: string): Promise<string>; // returns storageKey
  download(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
  getUrl(storageKey: string): string;
}

// Placeholder - real implementation wired in API routes
export function createStorageKey(orgId: string, runId: string, filename: string): string {
  return `orgs/${orgId}/runs/${runId}/${Date.now()}-${filename}`;
}
