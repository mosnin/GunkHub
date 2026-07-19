// Type declarations for server.mjs, so tests/unit/webhook_consumer_example.test.ts
// (compiled under strict TypeScript) can import it without an implicit `any`.
// This example is intentionally plain JavaScript (no build step, runnable
// with a bare `node`), so these types are hand-written rather than emitted.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export function parseSignatureHeader(header: string | undefined): { t: string; v1: string } | null

export interface VerifyResult {
  valid: boolean
  reason?: string
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
  toleranceSeconds?: number,
): VerifyResult

export interface CreateHandlerOptions {
  log?: (message: string) => void
}

export function createHandler(
  secret: string,
  options?: CreateHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void>

export type { Server }
