import { unavailableEmpty, unavailableError } from './serviceResult'

import type { ServiceResult } from './serviceResult'
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
 *
 * This used to return `Promise<string>` and `catch { return '' }`, which
 * collapsed two adapter rejections that mean opposite things:
 *
 *   - StubBlobStorage rejects with "key not found" — the artifact was never
 *     uploaded. Benign, expected in stub mode, genuinely nothing to fetch.
 *   - VercelBlobStorage rejects with "BLOB_STORE_URL is not configured" — the
 *     entire blob store is misconfigured, so EVERY artifact in the product is
 *     unreachable.
 *
 * Both produced `''`, so a total storage outage was indistinguishable from a
 * run that happens to have no artifact bodies. That is the same defect as the
 * verification widget, one artifact at a time.
 *
 * Note the stub's rejection message embeds the storage key, which is exactly
 * the sort of internal detail `unavailableError` keeps out of `message` — the
 * key goes to the structured log, not to the page.
 *
 * `status: 'empty'` is not reachable here: the adapter contract is
 * resolve-with-a-URL or reject, so there is no "succeeded with no URL" case.
 * A caller that gets a non-'ok' result is always looking at a failure, and the
 * distinction it must draw is which one — hence the message.
 */
export async function getArtifactUrl(storageKey: string): Promise<ServiceResult<{ url: string }>> {
  const adapter = getStorageAdapter()
  try {
    const url = await adapter.getUrl(storageKey)
    if (!url) {
      // Defensive: an adapter that resolves with an empty string has told us
      // nothing is stored there, which is a real (if unexpected) empty.
      return unavailableEmpty('This artifact has no stored content.')
    }
    return { status: 'ok', url }
  } catch (err) {
    return unavailableError('this artifact', err, {
      service: 'artifacts',
      fn: 'getArtifactUrl',
      storageKey,
    })
  }
}
