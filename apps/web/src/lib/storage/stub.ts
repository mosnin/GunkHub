/**
 * StubBlobStorageAdapter — in-memory implementation for development and tests.
 *
 * Stores blobs in a Map keyed by storage key. Content is never persisted to disk.
 * This adapter is used when BLOB_STORAGE_PROVIDER is not set (local dev and CI).
 *
 * NOT suitable for production — data is lost on process restart.
 * Replace with a concrete provider (e.g. VercelBlobAdapter) when deploying.
 */
import type { BlobStorageAdapter } from "./adapter";

export class StubBlobStorageAdapter implements BlobStorageAdapter {
  private readonly store = new Map<string, { data: string; mimeType: string }>();

  upload(key: string, data: string, mimeType: string): Promise<string> {
    this.store.set(key, { data, mimeType });
    return Promise.resolve(key);
  }

  getUrl(key: string): Promise<string> {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return Promise.reject(new Error(`StubBlobStorage: key not found: ${key}`));
    }
    // Return a data URL so the content is directly readable without a real HTTP server.
    const encoded = Buffer.from(entry.data).toString("base64");
    return Promise.resolve(`data:${entry.mimeType};base64,${encoded}`);
  }

  /** Expose raw stored content for assertions in tests. */
  getRaw(key: string): string | undefined {
    return this.store.get(key)?.data;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  size(): number {
    return this.store.size;
  }
}

/** Singleton stub instance used by the upload route in non-production environments. */
export const stubAdapter = new StubBlobStorageAdapter();
