/**
 * large_payloads.ts
 *
 * Demonstrates the SDK's automatic payload externalization: per CLAUDE.md
 * Event Log Rule 3, "any event payload exceeding 10 KB must be written to
 * blob storage; the event record stores only a pointer." You do not opt into
 * this — it is automatic and applies identically to both the buffered
 * `Recorder` (via `HttpTransport`) and the un-buffered `FlightRecorder`
 * (via `RunRecorder`).
 *
 * How it actually works (see `packages/sdk/src/externalize.ts`):
 *   1. Before a batch is sent, each event's payload is JSON-serialized and
 *      measured with `TextEncoder` (a true UTF-8 byte count — plain
 *      `string.length` undercounts multi-byte characters and could let an
 *      over-threshold payload slip through).
 *   2. If the byte length exceeds `PAYLOAD_EXTERNALIZATION_THRESHOLD` (10 KB,
 *      exported from `@agent-flight-recorder/contracts`), the SDK POSTs the
 *      raw payload to `/api/artifacts/upload` and gets back an
 *      `ArtifactPointer`: `{ artifactId, storageKey, storageBucket, checksum,
 *      size }`. `checksum` is a SHA-256 of the payload, computed server-side,
 *      so the stored artifact can be integrity-checked later.
 *   3. The event actually sent to `/api/events` carries an
 *      `ExternalizedPayload` in place of the original payload:
 *      `{ type: '_externalized', originalType: <the real event type>,
 *         _artifact: <the pointer> }`. The UI resolves this pointer to fetch
 *      and render the full payload on demand — the Convex document store
 *      never holds oversized blobs.
 *   4. Payloads at or under the threshold are sent inline, unchanged.
 *
 * You never call an "externalize" function yourself — the only public,
 * documented lever is the payload you hand to `recordEvent` (or
 * `RunRecorder.recordEvent`). This example builds an intentionally oversized
 * payload and records it exactly the way you would any other event; nothing
 * about the call site changes.
 *
 * This example runs fully offline with a small transport that mirrors
 * `HttpTransport`'s size check (using the same public
 * `PAYLOAD_EXTERNALIZATION_THRESHOLD` constant) so you can see the decision
 * being made without a live server. To see the REAL upload path exercised
 * (an actual `POST /api/artifacts/upload`), construct a `Recorder` with the
 * default `HttpTransport` against a running deployment — see the `--live`
 * flag in `basic_run.ts` for that pattern; the call site here is identical.
 *
 * Run:
 *   pnpm tsx packages/sdk/examples/large_payloads.ts
 */

import { PAYLOAD_EXTERNALIZATION_THRESHOLD } from '@agent-flight-recorder/contracts'
import {
  Recorder,
  Events,
  type Transport,
  type TransportAuth,
  type TransportResponse,
} from '@agent-flight-recorder/sdk'

import type {
  CreateRunRequest,
  CreateRunResponse,
  CreateEventRequest,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// DemoTransport — mirrors (for illustration only) the size check that
// `HttpTransport` performs internally via `externalizePayloadIfLarge` before
// every `sendEvents` call. In production you use the real `HttpTransport`
// (or your own `Transport`) and this decision is made for you.
// ---------------------------------------------------------------------------

class DemoTransport implements Transport {
  async createRun(req: CreateRunRequest, _auth: TransportAuth): Promise<CreateRunResponse> {
    return {
      run: {
        id: 'run_payload_demo',
        orgId: 'org_demo',
        projectId: 'proj_demo',
        agentId: req.agentId,
        // exactOptionalPropertyTypes: only spread optional fields when defined
        ...(req.agentVersionId !== undefined && { agentVersionId: req.agentVersionId }),
        status: 'running',
        startedAt: Date.now(),
        metadata: req.metadata ?? {},
        tags: req.tags ?? [],
        ...(req.triggeredBy !== undefined && { triggeredBy: req.triggeredBy }),
        ...(req.sdkVersion !== undefined && { sdkVersion: req.sdkVersion }),
      },
    }
  }

  async sendEvents(events: CreateEventRequest[], _auth: TransportAuth): Promise<TransportResponse> {
    for (const evt of events) {
      const serialized = JSON.stringify(evt.payload)
      const bytes = new TextEncoder().encode(serialized).length
      if (bytes > PAYLOAD_EXTERNALIZATION_THRESHOLD) {
        // This is exactly what the real HttpTransport does automatically:
        // upload the payload as an artifact and ship a pointer instead.
        console.log(
          `  [seq=${evt.sequenceNumber}] payload is ${bytes} bytes (> ${PAYLOAD_EXTERNALIZATION_THRESHOLD} byte threshold) ` +
            `-> in real HttpTransport this becomes POST /api/artifacts/upload, replaced by ` +
            `{ type: '_externalized', originalType: '${evt.type}', _artifact: { artifactId, storageKey, storageBucket, checksum (sha256), size } }`
        )
      } else {
        console.log(`  [seq=${evt.sequenceNumber}] payload is ${bytes} bytes -> sent inline, unchanged`)
      }
    }
    return { success: true, eventIds: events.map((_, i) => `evt_${Date.now()}_${i}`) }
  }

  async updateRunStatus(runId: string, status: string): Promise<TransportResponse> {
    console.log(`  [status] ${runId} -> ${status}`)
    return { success: true, eventIds: [] }
  }
}

async function main(): Promise<void> {
  const recorder = new Recorder(
    {
      endpoint: 'http://localhost:3000',
      apiKey: process.env['AFR_API_KEY'] ?? 'demo_key_abc123',
      agentId: process.env['AFR_AGENT_ID'] ?? 'agent_support_bot',
    },
    new DemoTransport()
  )

  await recorder.startRun({ query: 'fetch a large document' })

  // A normal, small event — well under 10 KB, sent inline as usual.
  recorder.recordEvent(
    'tool.call',
    Events.toolCall('fetch_document', { doc_id: 'doc_42' }, 'call_small').payload
  )

  // An intentionally oversized payload — e.g. a large retrieved document, a
  // big tool result, or a bulky LLM response. Building one large enough to
  // cross the 10 KB threshold; you don't need to think about this size limit
  // in your own code — record whatever payload your agent actually produced
  // and let the SDK decide.
  const largeDocument = 'x'.repeat(PAYLOAD_EXTERNALIZATION_THRESHOLD + 2048)
  recorder.recordEvent(
    'tool.result',
    Events.toolResult('call_small', { doc_id: 'doc_42', content: largeDocument }, 340).payload
  )

  const result = await recorder.endRun({ reply: 'Document fetched.' })
  console.log('\nRun ended. FlushResult:', result)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exitCode = 1
})
