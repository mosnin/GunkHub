import type { Artifact } from "./entities.js";

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

export interface UploadRequest {
  runId: string;
  eventId?: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface UploadResponse {
  uploadUrl: string;
  artifact: Artifact;
}
