/**
 * VercelBlobAdapter — production blob storage adapter using the Vercel Blob REST API.
 *
 * Reads BLOB_STORE_TOKEN and BLOB_STORE_URL from process.env at call time (not at
 * module load time) to satisfy Next.js server component constraints and avoid issues
 * during `next build` when environment variables are absent.
 *
 * Do NOT use the @vercel/blob npm package — this adapter uses the native fetch API
 * to keep the dependency surface minimal.
 */
import type { BlobStorageAdapter } from "./adapter";

class VercelBlobAdapter implements BlobStorageAdapter {
  /**
   * Upload a blob to Vercel Blob storage via the REST API.
   *
   * PUT https://blob.vercel-storage.com/{key}
   * Authorization: Bearer {BLOB_STORE_TOKEN}
   *
   * Returns the storage key (not the full URL — URL is derived in getUrl()).
   */
  upload(key: string, data: string, mimeType: string): Promise<string> {
    const token = process.env["BLOB_STORE_TOKEN"];
    if (!token) {
      return Promise.reject(new Error("BLOB_STORE_TOKEN is not configured"));
    }

    return fetch(`https://blob.vercel-storage.com/${key}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: data,
    }).then((response) => {
      if (!response.ok) {
        throw new Error(
          `Vercel Blob upload failed: ${response.status} ${response.statusText}`,
        );
      }
      return key;
    });
  }

  /**
   * Resolve a storage key to the full Vercel Blob URL.
   *
   * Returns `${BLOB_STORE_URL}/${key}` using BLOB_STORE_URL env var.
   */
  getUrl(key: string): Promise<string> {
    const baseUrl = process.env["BLOB_STORE_URL"];
    if (!baseUrl) {
      return Promise.reject(new Error("BLOB_STORE_URL is not configured"));
    }
    return Promise.resolve(`${baseUrl}/${key}`);
  }
}

export const vercelBlobAdapter = new VercelBlobAdapter();
