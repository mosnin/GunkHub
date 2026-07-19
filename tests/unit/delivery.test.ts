import { createHmac } from 'node:crypto'

import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  UnsafeWebhookUrlError,
  assertSafeWebhookUrl,
  computeBackoff,
  deliverWebhook,
  renderAlertEmailText,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../apps/web/src/lib/delivery.js'

// ---------------------------------------------------------------------------
// Signature vectors
// ---------------------------------------------------------------------------

describe('signWebhookPayload', () => {
  const SECRET = 'whsec_test_secret_123'
  const BODY = '{"event":"run.failed","runId":"run-1"}'
  const TS = 1_700_000_000

  it('produces the exact expected HMAC for a fixed secret/body/timestamp', () => {
    const expectedHex = createHmac('sha256', SECRET).update(`${String(TS)}.${BODY}`).digest('hex')
    const header = signWebhookPayload(SECRET, BODY, TS)
    expect(header).toBe(`t=${String(TS)},v1=${expectedHex}`)
  })

  it('is a pure function of (secret, body, timestamp) — same input, same output', () => {
    const a = signWebhookPayload(SECRET, BODY, TS)
    const b = signWebhookPayload(SECRET, BODY, TS)
    expect(a).toBe(b)
  })

  it('changes when the body changes', () => {
    const a = signWebhookPayload(SECRET, BODY, TS)
    const b = signWebhookPayload(SECRET, `${BODY}x`, TS)
    expect(a).not.toBe(b)
  })

  it('changes when the secret changes', () => {
    const a = signWebhookPayload(SECRET, BODY, TS)
    const b = signWebhookPayload('different-secret', BODY, TS)
    expect(a).not.toBe(b)
  })

  it('changes when the timestamp changes', () => {
    const a = signWebhookPayload(SECRET, BODY, TS)
    const b = signWebhookPayload(SECRET, BODY, TS + 1)
    expect(a).not.toBe(b)
  })

  it('round-trips through verifyWebhookSignature', () => {
    const header = signWebhookPayload(SECRET, BODY, Math.floor(Date.now() / 1000))
    expect(verifyWebhookSignature(SECRET, BODY, header)).toBe(true)
  })

  it('fails verification with the wrong secret', () => {
    const header = signWebhookPayload(SECRET, BODY, Math.floor(Date.now() / 1000))
    expect(verifyWebhookSignature('wrong-secret', BODY, header)).toBe(false)
  })

  it('fails verification when the body was tampered with', () => {
    const header = signWebhookPayload(SECRET, BODY, Math.floor(Date.now() / 1000))
    expect(verifyWebhookSignature(SECRET, `${BODY}tampered`, header)).toBe(false)
  })

  it('fails verification for a stale timestamp beyond tolerance', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 10_000
    const header = signWebhookPayload(SECRET, BODY, staleTs)
    expect(verifyWebhookSignature(SECRET, BODY, header, 300)).toBe(false)
  })

  it('fails verification for a malformed header', () => {
    expect(verifyWebhookSignature(SECRET, BODY, 'garbage')).toBe(false)
    expect(verifyWebhookSignature(SECRET, BODY, 't=abc,v1=zz')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SSRF guard matrix
// ---------------------------------------------------------------------------

describe('assertSafeWebhookUrl', () => {
  const blocked: Array<[string, string]> = [
    ['non-https scheme', 'http://example.com/webhook'],
    ['10/8', 'https://10.0.0.5/hook'],
    ['10/8 upper bound', 'https://10.255.255.255/hook'],
    ['172.16/12 lower bound', 'https://172.16.0.1/hook'],
    ['172.16/12 upper bound', 'https://172.31.255.255/hook'],
    ['192.168/16', 'https://192.168.1.1/hook'],
    ['127/8 loopback', 'https://127.0.0.1/hook'],
    ['169.254/16 link-local', 'https://169.254.169.254/hook'],
    ['0.0.0.0', 'https://0.0.0.0/hook'],
    ['::1 loopback', 'https://[::1]/hook'],
    ['fc00::/7 unique-local', 'https://[fc00::1]/hook'],
    ['fd00 within fc00::/7', 'https://[fd12:3456::1]/hook'],
    ['fe80::/10 link-local', 'https://[fe80::1]/hook'],
    ['localhost hostname', 'https://localhost/hook'],
    ['localhost mixed case', 'https://LOCALHOST/hook'],
    ['.internal suffix', 'https://svc.internal/hook'],
    ['.local suffix', 'https://printer.local/hook'],
    ['not a URL at all', 'not-a-url'],
  ]

  for (const [label, url] of blocked) {
    it(`blocks ${label} (${url})`, () => {
      expect(() => assertSafeWebhookUrl(url)).toThrow(UnsafeWebhookUrlError)
    })
  }

  const allowed = [
    'https://example.com/webhook',
    'https://hooks.example.org/afr/deliver',
    'https://8.8.8.8/hook', // public IPv4
    'https://api.internal-sounding-but-not.com/hook', // contains "internal" but not as a hostname suffix
    'https://[2001:4860:4860::8888]/hook', // public IPv6 (Google DNS)
  ]

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(() => assertSafeWebhookUrl(url)).not.toThrow()
    })
  }
})

// ---------------------------------------------------------------------------
// Backoff bounds
// ---------------------------------------------------------------------------

describe('computeBackoff', () => {
  it('never exceeds maxBackoffMs regardless of attempt', () => {
    for (const attempt of [0, 1, 2, 5, 10, 20]) {
      const delay = computeBackoff(attempt, { maxBackoffMs: 30_000 })
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(30_000)
    }
  })

  it('grows the cap exponentially before hitting maxBackoffMs', () => {
    // At attempt 0 the cap (pre-jitter) is backoffMs itself.
    const originalRandom = Math.random
    Math.random = () => 1 // full jitter at its max — delay equals the cap
    try {
      expect(computeBackoff(0, { backoffMs: 500, maxBackoffMs: 30_000 })).toBe(500)
      expect(computeBackoff(1, { backoffMs: 500, maxBackoffMs: 30_000 })).toBe(1000)
      expect(computeBackoff(2, { backoffMs: 500, maxBackoffMs: 30_000 })).toBe(2000)
      // Large attempt counts are capped, not left to grow unbounded.
      expect(computeBackoff(10, { backoffMs: 500, maxBackoffMs: 30_000 })).toBe(30_000)
    } finally {
      Math.random = originalRandom
    }
  })

  it('returns 0 when Math.random() returns 0 (full jitter floor)', () => {
    const originalRandom = Math.random
    Math.random = () => 0
    try {
      expect(computeBackoff(3)).toBe(0)
    } finally {
      Math.random = originalRandom
    }
  })
})

// ---------------------------------------------------------------------------
// deliverWebhook — retryable classification
// ---------------------------------------------------------------------------

describe('deliverWebhook', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects an unsafe URL before attempting a fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(
      deliverWebhook({
        url: 'http://10.0.0.1/hook',
        secret: 's',
        event: 'run.failed',
        payload: {},
        deliveryId: 'd1',
      }),
    ).rejects.toThrow(UnsafeWebhookUrlError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('classifies 2xx as ok, not retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    )
    const result = await deliverWebhook({
      url: 'https://example.com/hook',
      secret: 's',
      event: 'run.failed',
      payload: { a: 1 },
      deliveryId: 'd1',
    })
    expect(result).toEqual({ ok: true, status: 200, retryable: false })
  })

  it('classifies 4xx as not ok, not retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 422 })))
    const result = await deliverWebhook({
      url: 'https://example.com/hook',
      secret: 's',
      event: 'run.failed',
      payload: {},
      deliveryId: 'd1',
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.retryable).toBe(false)
  })

  it('classifies 5xx as not ok, retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oops', { status: 503 })))
    const result = await deliverWebhook({
      url: 'https://example.com/hook',
      secret: 's',
      event: 'run.failed',
      payload: {},
      deliveryId: 'd1',
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.retryable).toBe(true)
  })

  it('classifies a network error as not ok, retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const result = await deliverWebhook({
      url: 'https://example.com/hook',
      secret: 's',
      event: 'run.failed',
      payload: {},
      deliveryId: 'd1',
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBeNull()
    expect(result.retryable).toBe(true)
  })

  it('sends the signature, event, and delivery-id headers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await deliverWebhook({
      url: 'https://example.com/hook',
      secret: 'topsecret',
      event: 'run.failed',
      payload: { runId: 'run-1' },
      deliveryId: 'delivery-42',
    })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-afr-event']).toBe('run.failed')
    expect(headers['x-afr-delivery-id']).toBe('delivery-42')
    expect(headers['x-afr-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// renderAlertEmailText
// ---------------------------------------------------------------------------

describe('renderAlertEmailText', () => {
  it('includes all key fields in the rendered body', () => {
    const text = renderAlertEmailText({
      alertName: 'High failure rate',
      orgName: 'Acme Corp',
      runId: 'run-123',
      runStatus: 'failed',
      agentName: 'billing-agent',
      firedAt: 1_700_000_000_000,
      condition: 'run.failed',
      runUrl: 'https://app.example.com/runs/run-123',
    })
    expect(text).toContain('High failure rate')
    expect(text).toContain('Acme Corp')
    expect(text).toContain('run-123')
    expect(text).toContain('failed')
    expect(text).toContain('billing-agent')
    expect(text).toContain('run.failed')
    expect(text).toContain('https://app.example.com/runs/run-123')
  })
})
