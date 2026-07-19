// Tests for convex/helpers/notifier.ts (Cycle 3 — completes the deferred
// alert-email delivery path). Covers the pure/unit-testable surface:
// ConsoleEmailNotifier's always-ok contract, getConfiguredEmailNotifier's
// graceful fallback when unconfigured, and the renderAlertEmailText mirror
// (must match apps/web/src/lib/delivery.ts's renderAlertEmailText —
// tests/unit/delivery.test.ts covers that original).
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ConsoleEmailNotifier,
  getConfiguredEmailNotifier,
  renderAlertEmailText,
  ResendEmailNotifier,
} from '../../convex/helpers/notifier'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ConsoleEmailNotifier', () => {
  it('always reports ok and logs the envelope', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const notifier = new ConsoleEmailNotifier()
    const result = await notifier.send('dev@example.com', 'Subject', 'Body text')
    expect(result.ok).toBe(true)
    expect(logSpy).toHaveBeenCalledOnce()
    expect(logSpy.mock.calls[0]![0]).toContain('dev@example.com')
    expect(logSpy.mock.calls[0]![0]).toContain('Body text')
  })
})

describe('getConfiguredEmailNotifier — graceful fallback', () => {
  it('returns ConsoleEmailNotifier when AFR_EMAIL_PROVIDER is unset', () => {
    delete process.env['AFR_EMAIL_PROVIDER']
    expect(getConfiguredEmailNotifier()).toBeInstanceOf(ConsoleEmailNotifier)
  })

  it('returns ConsoleEmailNotifier when AFR_EMAIL_PROVIDER is an unrecognized value', () => {
    process.env['AFR_EMAIL_PROVIDER'] = 'carrier-pigeon'
    expect(getConfiguredEmailNotifier()).toBeInstanceOf(ConsoleEmailNotifier)
  })

  it('falls back to ConsoleEmailNotifier when provider=resend but RESEND_API_KEY/AFR_EMAIL_FROM are unset (never crashes)', () => {
    process.env['AFR_EMAIL_PROVIDER'] = 'resend'
    delete process.env['RESEND_API_KEY']
    delete process.env['AFR_EMAIL_FROM']
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(getConfiguredEmailNotifier()).toBeInstanceOf(ConsoleEmailNotifier)
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('returns a ResendEmailNotifier when provider=resend and both env vars are set', () => {
    process.env['AFR_EMAIL_PROVIDER'] = 'resend'
    process.env['RESEND_API_KEY'] = 'fake_test_key_not_real'
    process.env['AFR_EMAIL_FROM'] = 'alerts@example.com'
    expect(getConfiguredEmailNotifier()).toBeInstanceOf(ResendEmailNotifier)
  })
})

describe('ResendEmailNotifier — never throws, reports ok/error', () => {
  it('reports ok on a 2xx fetch response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    const notifier = new ResendEmailNotifier('fake_test_key_not_real', 'alerts@example.com')
    const result = await notifier.send('dev@example.com', 'Subject', 'Body')
    expect(result.ok).toBe(true)
  })

  it('reports a non-throwing error on a non-2xx fetch response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const notifier = new ResendEmailNotifier('fake_test_key_not_real', 'alerts@example.com')
    const result = await notifier.send('dev@example.com', 'Subject', 'Body')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })

  it('reports a non-throwing error on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const notifier = new ResendEmailNotifier('fake_test_key_not_real', 'alerts@example.com')
    const result = await notifier.send('dev@example.com', 'Subject', 'Body')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('network down')
  })
})

describe('renderAlertEmailText (Convex-side mirror)', () => {
  it('includes all key fields, matching apps/web/src/lib/delivery.ts\'s renderer', () => {
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
