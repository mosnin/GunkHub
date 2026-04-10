import type { Artifact } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'
import { getStorageAdapter } from '@/lib/storage'

function mapArtifact(doc: Record<string, unknown>): Artifact {
  return {
    id: (doc['_id'] ?? doc['id']) as string,
    runId: doc['runId'] as string,
    orgId: doc['orgId'] as string,
    name: doc['name'] as string,
    mimeType: doc['mimeType'] as string,
    size: doc['size'] as number,
    storageKey: doc['storageKey'] as string,
    storageBucket: doc['storageBucket'] as string,
    checksum: doc['checksum'] as string,
    createdAt: doc['createdAt'] as number,
    ...(doc['eventId'] !== undefined && { eventId: doc['eventId'] as string }),
  }
}

/**
 * List all artifacts for a run.
 * Returns an empty array if the run has no artifacts.
 */
export async function listArtifacts(runId: string): Promise<{ artifacts: Artifact[] }> {
  const client = await getAuthedClient()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const docs = await client.query(convex.artifacts.listArtifacts, { runId })
  const artifacts = (docs as Record<string, unknown>[]).map(mapArtifact)
  return { artifacts }
}

/**
 * Resolve a storage key to a fetchable URL.
 * Returns an empty string when the blob storage adapter cannot locate the key
 * (e.g. in stub mode when no artifact has been uploaded).
 */
export async function getArtifactUrl(storageKey: string): Promise<string> {
  const adapter = getStorageAdapter()
  try {
    return await adapter.getUrl(storageKey)
  } catch {
    return ''
  }
}
