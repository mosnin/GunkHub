/**
 * PAYLOAD_EXTERNALIZATION_THRESHOLD — 10 KB in bytes (JSON-serialized length).
 * Payloads whose JSON.stringify length exceeds this value must be externalized
 * to blob storage. The event record stores an ExternalizedPayload pointer instead.
 */
export const PAYLOAD_EXTERNALIZATION_THRESHOLD = 10 * 1024; // 10 KB

export interface ArtifactPointer {
  storageKey: string;
  storageBucket: string;
  size: number;
  mimeType: string;
  checksum: string;
}

export interface BlobStorageConfig {
  provider: "vercel-blob" | "r2" | "local";
  bucket: string;
  baseUrl: string;
}

export interface ArtifactUploadRequest {
  runId: string;
  eventId?: string;
  name: string;
  mimeType: string;
  /** Full payload to externalize (JSON-stringified server-side). */
  payload: unknown;
}

export interface ArtifactUploadResponse {
  artifactId: string;
  storageKey: string;
  storageBucket: string;
  checksum: string;
  size: number;
}

/** @deprecated Use ArtifactUploadRequest */
export type UploadRequest = ArtifactUploadRequest;

/** @deprecated Use ArtifactUploadResponse */
export type UploadResponse = ArtifactUploadResponse;
