import { redactPayload } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { EventPayload } from '@agent-flight-recorder/contracts'
import type { RedactionConfig } from '@agent-flight-recorder/sdk'

const custom = (data: unknown): EventPayload => ({ type: 'custom', data }) as EventPayload

describe('redactPayload — built-in patterns', () => {
  it('redacts email hits', () => {
    const out = redactPayload(custom('contact me at jane.doe@example.com please'), 'custom', { patterns: ['email'] })
    expect(JSON.stringify(out)).not.toContain('jane.doe@example.com')
    expect(JSON.stringify(out)).toContain('[REDACTED]')
  })

  it('does not redact near-miss email-like text', () => {
    const out = redactPayload(custom('user (at) example dot com'), 'custom', { patterns: ['email'] })
    expect(JSON.stringify(out)).toContain('user (at) example dot com')
  })

  it('redacts known api_key prefixes', () => {
    const out = redactPayload(custom('key=rk_notARealKeyRedactionFixture01'), 'custom', { patterns: ['api_key'] })
    expect(JSON.stringify(out)).not.toContain('rk_notARealKeyRedactionFixture01')
  })

  it('does not redact a short/unprefixed token as api_key (documented false-negative)', () => {
    const out = redactPayload(custom('token=abc123'), 'custom', { patterns: ['api_key'] })
    expect(JSON.stringify(out)).toContain('abc123')
  })

  it('redacts a JWT-shaped string', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_abc123XYZ'
    const out = redactPayload(custom(`Authorization: Bearer ${jwt}`), 'custom', { patterns: ['jwt'] })
    expect(JSON.stringify(out)).not.toContain(jwt)
  })

  it('redacts a valid credit card number (passes Luhn)', () => {
    const out = redactPayload(custom('card 4111 1111 1111 1111'), 'custom', { patterns: ['credit_card'] })
    expect(JSON.stringify(out)).not.toContain('4111 1111 1111 1111')
  })

  it('does not redact a random 16-digit number that fails Luhn', () => {
    const out = redactPayload(custom('order id 1234567890123456'), 'custom', { patterns: ['credit_card'] })
    expect(JSON.stringify(out)).toContain('1234567890123456')
  })

  it('redacts a dashed SSN', () => {
    const out = redactPayload(custom('ssn: 123-45-6789'), 'custom', { patterns: ['ssn'] })
    expect(JSON.stringify(out)).not.toContain('123-45-6789')
  })

  it('does not redact a 9-digit number without dashes (documented false-negative)', () => {
    const out = redactPayload(custom('id: 123456789'), 'custom', { patterns: ['ssn'] })
    expect(JSON.stringify(out)).toContain('123456789')
  })

  it('redacts a US phone number', () => {
    const out = redactPayload(custom('call me at (555) 123-4567'), 'custom', { patterns: ['phone'] })
    expect(JSON.stringify(out)).not.toContain('123-4567')
  })

  it('accepts a caller-supplied RegExp pattern', () => {
    const out = redactPayload(custom('secret: TOPSECRET'), 'custom', { patterns: [/TOPSECRET/] })
    expect(JSON.stringify(out)).not.toContain('TOPSECRET')
  })

  it('uses a custom replacement string', () => {
    const out = redactPayload(custom('jane@example.com'), 'custom', { patterns: ['email'], replacement: '***' })
    expect(JSON.stringify(out)).toContain('***')
    expect(JSON.stringify(out)).not.toContain('[REDACTED]')
  })
})

describe('redactPayload — wildcard paths', () => {
  it('redacts a nested field via dot path', () => {
    const payload = custom({ user: { email: 'a@b.com', name: 'Ada' } })
    const out = redactPayload(payload, 'custom', { paths: ['data.user.email'] })
    const data = (out as { data: { user: { email: string; name: string } } }).data
    expect(data.user.email).toBe('[REDACTED]')
    expect(data.user.name).toBe('Ada')
  })

  it('redacts through a wildcard over an array', () => {
    const payload = custom({ messages: [{ content: 'hi', role: 'user' }, { content: 'yo', role: 'assistant' }] })
    const out = redactPayload(payload, 'custom', { paths: ['data.messages.*.content'] })
    const data = (out as { data: { messages: { content: string; role: string }[] } }).data
    expect(data.messages[0]?.content).toBe('[REDACTED]')
    expect(data.messages[1]?.content).toBe('[REDACTED]')
    expect(data.messages[0]?.role).toBe('user')
  })

  it('redacts through nested arrays', () => {
    const payload = custom({ groups: [{ items: [{ secret: 'x' }, { secret: 'y' }] }] })
    const out = redactPayload(payload, 'custom', { paths: ['data.groups.*.items.*.secret'] })
    const data = (out as { data: { groups: { items: { secret: string }[] }[] } }).data
    expect(data.groups[0]?.items[0]?.secret).toBe('[REDACTED]')
    expect(data.groups[0]?.items[1]?.secret).toBe('[REDACTED]')
  })

  it('does not mutate the caller-supplied original object', () => {
    const payload = custom({ email: 'a@b.com' })
    redactPayload(payload, 'custom', { paths: ['data.email'] })
    expect((payload as { data: { email: string } }).data.email).toBe('a@b.com')
  })

  it('is safe against a proto-pollution attempt via path segments', () => {
    const payload = custom({ ok: true })
    expect(() =>
      redactPayload(payload, 'custom', { paths: ['data.__proto__.polluted', 'data.constructor.prototype.polluted'] })
    ).not.toThrow()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('redactPayload — bounded traversal', () => {
  it('does not hang or crash on a deep-nesting depth bomb', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 200; i++) {
      deep = { nested: deep }
    }
    const payload = custom(deep)
    expect(() => redactPayload(payload, 'custom', { patterns: ['email'] })).not.toThrow()
  })

  it('does not hang or crash on a wide node-count bomb', () => {
    const wide: Record<string, string> = {}
    for (let i = 0; i < 50_000; i++) {
      wide[`k${i}`] = 'x'
    }
    const payload = custom(wide)
    expect(() => redactPayload(payload, 'custom', { patterns: ['email'] })).not.toThrow()
  })
})

describe('redactPayload — custom function', () => {
  it('applies the custom transform after paths/patterns', () => {
    const out = redactPayload(custom({ a: 1 }), 'custom', {
      custom: (payload) => ({ ...payload, tagged: true }) as unknown as EventPayload,
    })
    expect((out as unknown as { tagged: boolean }).tagged).toBe(true)
  })

  it('falls back to built-in redaction and sets _redactionDegraded when custom throws', () => {
    const onRedactionError = vi.fn()
    const out = redactPayload(
      custom('jane@example.com'),
      'custom',
      {
        patterns: ['email'],
        custom: () => {
          throw new Error('boom')
        },
      },
      onRedactionError
    )
    expect(onRedactionError).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect((out as { _redactionDegraded?: boolean })._redactionDegraded).toBe(true)
    expect(JSON.stringify(out)).not.toContain('jane@example.com')
  })

  it('never passes an unredacted payload through on custom-fn throw', () => {
    const config: RedactionConfig = {
      patterns: ['email'],
      custom: () => {
        throw new Error('always fails')
      },
    }
    const out = redactPayload(custom('leak@example.com'), 'custom', config)
    expect(JSON.stringify(out)).not.toContain('leak@example.com')
  })

  it('reports an invalid pattern via onRedactionError without throwing', () => {
    const onRedactionError = vi.fn()
    expect(() =>
      redactPayload(custom('x'), 'custom', { patterns: ['not_a_real_pattern' as never] }, onRedactionError)
    ).not.toThrow()
    expect(onRedactionError).toHaveBeenCalled()
  })
})
