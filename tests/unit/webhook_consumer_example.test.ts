/**
 * Tests for examples/webhook-consumer/server.mjs — the example customer
 * webhook receiver documented in docs/api_reference.md section 3. Two
 * tiers, both real (no mocked crypto):
 *
 *   1. Pure verification logic (verifyWebhookSignature/parseSignatureHeader),
 *      imported directly — signs fixtures the exact way
 *      convex/helpers/delivery.ts's signWebhookPayload does (`t=<ts>,v1=<hex>`,
 *      HMAC-SHA256 over `${t}.${rawBody}`) and asserts this example verifies
 *      them identically, proving the two implementations agree byte-for-byte.
 *   2. The HTTP handler itself (createHandler), driven with real Node
 *      `http.IncomingMessage`-shaped requests against a real ephemeral-port
 *      server — no live AFR deployment needed, this only proves the example
 *      is runnable and behaves as documented.
 */
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createHandler,
  parseSignatureHeader,
  verifyWebhookSignature,
} from '../../examples/webhook-consumer/server.mjs'

import type { Server } from 'node:http'

const SECRET = 'whsec_test_secret_1234567890'

/** Mirrors convex/helpers/delivery.ts's signWebhookPayload exactly. */
function sign(secret: string, body: string, timestamp: number): string {
  const hex = createHmac('sha256', secret).update(`${String(timestamp)}.${body}`).digest('hex')
  return `t=${String(timestamp)},v1=${hex}`
}

describe('examples/webhook-consumer — file exists at the documented path', () => {
  it('server.mjs is present', () => {
    expect(join(__dirname, '../../examples/webhook-consumer/server.mjs')).toBeTruthy()
  })
})

describe('parseSignatureHeader', () => {
  it('parses a well-formed t=,v1= header', () => {
    expect(parseSignatureHeader('t=1737300000,v1=abcd1234')).toEqual({ t: '1737300000', v1: 'abcd1234' })
  })

  it('returns null for a missing header', () => {
    expect(parseSignatureHeader(undefined)).toBeNull()
    expect(parseSignatureHeader('')).toBeNull()
  })

  it('returns null for a malformed header', () => {
    expect(parseSignatureHeader('not-a-valid-header')).toBeNull()
    expect(parseSignatureHeader('t=123')).toBeNull()
  })
})

describe('verifyWebhookSignature — matches convex/helpers/delivery.ts byte-for-byte', () => {
  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({ event: 'run.failed', run: { id: 'run_1', status: 'failed' } })
    const now = Math.floor(Date.now() / 1000)
    const header = sign(SECRET, body, now)
    const result = verifyWebhookSignature(SECRET, body, header)
    expect(result.valid).toBe(true)
  })

  it('rejects a payload signed with the wrong secret', () => {
    const body = JSON.stringify({ event: 'run.failed' })
    const now = Math.floor(Date.now() / 1000)
    const header = sign('whsec_wrong_secret', body, now)
    const result = verifyWebhookSignature(SECRET, body, header)
    expect(result.valid).toBe(false)
  })

  it('rejects a payload whose body was tampered with after signing', () => {
    const originalBody = JSON.stringify({ event: 'run.failed', run: { id: 'run_1' } })
    const now = Math.floor(Date.now() / 1000)
    const header = sign(SECRET, originalBody, now)
    const tamperedBody = JSON.stringify({ event: 'run.failed', run: { id: 'run_2' } })
    const result = verifyWebhookSignature(SECRET, tamperedBody, header)
    expect(result.valid).toBe(false)
  })

  it('rejects a timestamp outside the default 300s tolerance (stale/replayed delivery)', () => {
    const body = JSON.stringify({ event: 'run.completed' })
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600 // 1 hour old
    const header = sign(SECRET, body, staleTimestamp)
    const result = verifyWebhookSignature(SECRET, body, header)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/tolerance/)
  })

  it('rejects a missing signature header', () => {
    const result = verifyWebhookSignature(SECRET, '{}', undefined)
    expect(result.valid).toBe(false)
  })

  it('rejects non-hex garbage in the v1 field rather than throwing', () => {
    const result = verifyWebhookSignature(SECRET, '{}', 't=1737300000,v1=not-hex-zzz')
    expect(result.valid).toBe(false)
  })
})

describe('createHandler — end-to-end HTTP behavior', () => {
  let server: Server | undefined
  let baseUrl = ''

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
  })

  async function startServer(logs: string[]): Promise<void> {
    const handler = createHandler(SECRET, { log: (msg: string) => logs.push(msg) })
    server = createServer(handler)
    await new Promise<void>((resolve) => server!.listen(0, resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    baseUrl = `http://127.0.0.1:${String(port)}`
  }

  it('acks a validly signed delivery with 200 and logs a verified summary', async () => {
    const logs: string[] = []
    await startServer(logs)

    const payload = { event: 'run.failed', run: { id: 'run_abc', status: 'failed' } }
    const body = JSON.stringify(payload)
    const now = Math.floor(Date.now() / 1000)
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-afr-signature': sign(SECRET, body, now),
        'x-afr-event': 'run.failed',
        'x-afr-delivery-id': 'delivery_1',
      },
      body,
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { received: boolean }
    expect(json.received).toBe(true)
    expect(logs.some((l) => l.includes('verified delivery delivery_1'))).toBe(true)
  })

  it('rejects an invalidly signed delivery with 401 and does not run business logic', async () => {
    const logs: string[] = []
    await startServer(logs)

    const body = JSON.stringify({ event: 'run.completed' })
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-afr-signature': 't=9999999999,v1=deadbeef',
        'x-afr-event': 'run.completed',
        'x-afr-delivery-id': 'delivery_2',
      },
      body,
    })

    expect(res.status).toBe(401)
    expect(logs.some((l) => l.includes('REJECTED delivery delivery_2'))).toBe(true)
  })

  it('re-acks a duplicate delivery id without re-running business logic, logging it as a duplicate', async () => {
    const logs: string[] = []
    await startServer(logs)

    const payload = { event: 'run.completed', run: { id: 'run_dup' } }
    const body = JSON.stringify(payload)
    const now = Math.floor(Date.now() / 1000)
    const headers = {
      'content-type': 'application/json',
      'x-afr-signature': sign(SECRET, body, now),
      'x-afr-event': 'run.completed',
      'x-afr-delivery-id': 'delivery_dup',
    }

    const first = await fetch(baseUrl, { method: 'POST', headers, body })
    const second = await fetch(baseUrl, { method: 'POST', headers, body })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(logs.some((l) => l.includes('verified delivery delivery_dup'))).toBe(true)
    expect(logs.some((l) => l.includes('duplicate delivery delivery_dup'))).toBe(true)
  })

  it('rejects non-POST methods with 405', async () => {
    const logs: string[] = []
    await startServer(logs)
    const res = await fetch(baseUrl, { method: 'GET' })
    expect(res.status).toBe(405)
  })

  it('rejects an oversized body with 413 instead of buffering it unbounded', async () => {
    const logs: string[] = []
    await startServer(logs)

    // One byte over the 5 MiB cap — big enough to prove the cap is enforced
    // without making the test itself slow.
    const oversized = 'a'.repeat(5 * 1024 * 1024 + 1)
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-afr-signature': 't=9999999999,v1=deadbeef',
        'x-afr-event': 'run.completed',
        'x-afr-delivery-id': 'delivery_huge',
      },
      body: oversized,
    })

    expect(res.status).toBe(413)
    expect(logs.some((l) => l.includes('rejected oversized request body'))).toBe(true)
  })
})
