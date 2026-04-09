// Replace this stub with real Vercel Blob or R2 implementation in v1.1

export interface BlobStorageAdapter {
  /**
   * Upload a blob to the given storage key.
   * @param key - The destination storage key (path within the bucket).
   * @param data - Raw binary data to upload.
   * @param mimeType - MIME type of the content.
   * @returns The public or signed URL for the uploaded object.
   */
  upload(key: string, data: ArrayBuffer, mimeType: string): Promise<string>;

  /**
   * Get a URL for accessing the stored object at the given key.
   * May return a signed/expiring URL depending on the provider.
   */
  getUrl(key: string): Promise<string>;

  /**
   * Delete the stored object at the given key.
   */
  delete(key: string): Promise<void>;
}
