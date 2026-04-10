/**
 * BlobStorageAdapter — interface for externalized large-payload storage.
 *
 * The artifact externalization policy (ADR-0006) requires any event payload
 * exceeding 10 KB to be stored in blob storage before the event is shipped.
 * This interface is injected at the call site so the concrete implementation
 * can be swapped (Vercel Blob in production, in-memory stub in tests).
 *
 * Do NOT call blob storage directly from Convex functions — the adapter lives
 * in the Next.js API layer and is called from the /api/artifacts/upload route.
 */
export interface BlobStorageAdapter {
  /**
   * Store a blob and return a permanent storage key.
   * @param key - Caller-supplied storage key (path within the bucket).
   * @param data - Raw UTF-8 encoded data (JSON string for event payloads).
   * @param mimeType - MIME type to attach to the stored object.
   * @returns The canonical storage key (may differ from input if normalized).
   */
  upload(key: string, data: string, mimeType: string): Promise<string>;

  /**
   * Resolve a storage key to a URL the client can fetch.
   * May be a signed URL with limited TTL depending on the provider.
   */
  getUrl(key: string): Promise<string>;
}

/**
 * ArtifactPointer — minimal reference stored on the Convex event record.
 * The full content lives at `storageKey` in `storageBucket`.
 */
export interface ArtifactPointer {
  storageKey: string;
  storageBucket: string;
  /** SHA-256 hex digest of the raw content for integrity verification. */
  checksum: string;
  size: number;
}

/**
 * Compute a SHA-256 hex digest for integrity verification.
 * Uses the Web Crypto API which is available in both Node 18+ and Edge runtimes.
 */
export async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { PAYLOAD_EXTERNALIZATION_THRESHOLD } from "@agent-flight-recorder/contracts";
