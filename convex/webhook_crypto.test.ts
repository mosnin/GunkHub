/**
 * webhook_crypto.test.ts — proves the Web Crypto / pure-TS replacements in
 * `convex/helpers/delivery.ts` and `convex/helpers/random.ts` are EXACTLY
 * equivalent to the `node:crypto` / `node:net` code they replaced.
 *
 * Background: Convex's default runtime is a V8 isolate without Node builtins,
 * and `"use node"` is only legal in action-only modules. `helpers/delivery.ts`
 * is imported by mutation modules (`webhooks.ts`, `alerts.ts`), so it had to
 * lose `node:crypto`/`node:net` outright. Two properties are load-bearing and
 * are pinned here:
 *
 *   1. SIGNATURE BYTES. The `x-afr-signature` header is already consumed by
 *      shipped webhook receivers (see examples/webhook-consumer and
 *      tests/unit/webhook_consumer_example.test.ts). If Web Crypto produced
 *      different bytes for any input, every deployed consumer would start
 *      rejecting deliveries. Tested two ways: against hard-coded golden hex
 *      vectors, and differentially against a live `node:crypto` HMAC.
 *
 *   2. SSRF GUARD STRENGTH. `assertSafeWebhookUrl` only applies its
 *      private/reserved-range checks to hosts it recognises as IP literals.
 *      A pure `ipVersion` that returned 0 where `node:net.isIP` returned 4/6
 *      would silently let a private-IP target through — a weakened guard is
 *      worse than the loud deploy failure this refactor fixes. Tested
 *      differentially against the real `node:net.isIP`.
 *
 * `node:crypto` / `node:net` are imported HERE only, as the oracle. Test files
 * are never deployed: Convex's bundler skips any entry point whose basename
 * contains more than one dot (`convex/node_modules/convex/src/bundler/index.ts`,
 * "`*.test.ts` `*.spec.ts` are common in developer code"), so this import
 * cannot reintroduce the deploy blocker.
 */
import { createHmac } from 'node:crypto'
import { isIP as nodeIsIP } from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  UnsafeWebhookUrlError,
  assertSafeWebhookUrl,
  ipVersion,
  signWebhookPayload,
} from './helpers/delivery'
import { bytesToHex, randomHex } from './helpers/random'

// ---------------------------------------------------------------------------
// 1. HMAC-SHA256 equivalence
// ---------------------------------------------------------------------------

/** [secret, body, timestamp, expected hex] — generated with node:crypto BEFORE the refactor. */
const GOLDEN: [string, string, number, string][] = [
  [
    'whsec_test_secret_123',
    '{"a":1}',
    1737300000,
    '3893b9e234af41aa871d7e212c927becf47816f747d1190c663876ae9101e2d3',
  ],
  ['', '', 0, 'b849d5a581847b281957065739df36df2463d1977ea8d6e1e4e6cf33fadc68c3'],
  ['s', '{}', 1, 'b253639bcd705ed1cda3073f66104f16988bd40272584dea7d0d345ae93e61cc'],
  // Non-ASCII secret AND body: pins that Web Crypto's TextEncoder (UTF-8) and
  // node:crypto's default string encoding (UTF-8) agree, including astral-plane
  // characters that occupy a surrogate pair in JS.
  [
    'whsec_ünïcødé_🔑',
    '{"emoji":"😀","n":"ünïcødé"}',
    1700000000,
    '86d2a918bcd0c44657bd114e046cdf384e3ef5abd8430ce67d9e4de4029d1899',
  ],
  // Key longer than SHA-256's 64-byte block (exercises HMAC key hashing) plus a
  // body larger than any realistic envelope.
  [
    'a'.repeat(200),
    'x'.repeat(5000),
    1234567890,
    '570cc92c5e50c5834f418c0a34e7a529941b9320578a41abdbe8fcfdc4941e5d',
  ],
  [
    ' ',
    'body with \n newline \t tab',
    42,
    '6995bf9f496675913dab0b7d800aba3d1825929c3ac6a5ee3dcc9be02e3834e8',
  ],
  [
    ' ÿ',
    ' ÿ😀',
    999999999999,
    '8e8c2594d1baf527e0a88dbf518925b2fbddff915ed6e8d3ab2b633183cfd854',
  ],
  // Embedded NUL and other control characters survive UTF-8 encoding identically.
  [
    '\u0020key\u0000',
    'body\u0000with nul',
    7,
    '762e0e623f2d71f3556ff36d1da282d3c2ee3c856467f216c1df9b77433732da',
  ],
]

describe('signWebhookPayload — byte-for-byte compatible with the node:crypto implementation', () => {
  it.each(GOLDEN)(
    'matches the golden vector for secret=%j body-len=%j ts=%j',
    async (secret, body, timestamp, expectedHex) => {
      await expect(signWebhookPayload(secret, body, timestamp)).resolves.toBe(
        `t=${String(timestamp)},v1=${expectedHex}`,
      )
    },
  )

  it('agrees with a live node:crypto HMAC across a generated corpus', async () => {
    const secrets = ['', 's', 'whsec_' + 'a'.repeat(58), 'ünïcødé', 'a'.repeat(64), 'a'.repeat(65)]
    const bodies = [
      '',
      '{}',
      '{"run":{"id":"abc"},"pattern":null}',
      JSON.stringify({ nested: { deep: [1, 2, 3] }, s: 'ünïcødé 😀' }),
      'x'.repeat(1024),
    ]
    for (const secret of secrets) {
      for (const body of bodies) {
        for (const timestamp of [0, 1, 1737300000, 999999999999]) {
          const expected = createHmac('sha256', secret)
            .update(`${String(timestamp)}.${body}`)
            .digest('hex')
          await expect(signWebhookPayload(secret, body, timestamp)).resolves.toBe(
            `t=${String(timestamp)},v1=${expected}`,
          )
        }
      }
    }
  })

  it('produces the documented t=<ts>,v1=<64 lowercase hex> wire format', async () => {
    const header = await signWebhookPayload('secret', '{"a":1}', 1737300000)
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })

  it('is deterministic, and sensitive to secret, body and timestamp', async () => {
    const base = await signWebhookPayload('s', 'b', 10)
    expect(await signWebhookPayload('s', 'b', 10)).toBe(base)
    expect(await signWebhookPayload('s2', 'b', 10)).not.toBe(base)
    expect(await signWebhookPayload('s', 'b2', 10)).not.toBe(base)
    expect(await signWebhookPayload('s', 'b', 11)).not.toBe(base)
  })
})

// ---------------------------------------------------------------------------
// 2. ipVersion vs node:net.isIP — the SSRF guard's recogniser
// ---------------------------------------------------------------------------

const IP_EDGE_CASES = [
  // IPv4 — accepted
  '0.0.0.0',
  '1.2.3.4',
  '10.0.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '192.168.1.1',
  '255.255.255.255',
  // IPv4 — rejected by Node (leading zeros, wrong arity, out of range, whitespace)
  '010.0.0.1',
  '01.2.3.4',
  '1.2.3.04',
  '1.2.3',
  '1.2.3.4.5',
  '256.0.0.1',
  ' 1.2.3.4',
  '1.2.3.4 ',
  '1.2.3.4:80',
  '0x7f.0.0.1',
  '2130706433',
  '127.1',
  '1.2.3.-4',
  '1.2.3.+4',
  // IPv6 — accepted
  '::',
  '::1',
  '::0',
  '0::0',
  'fe80::1',
  'FE80::1',
  'fE80::AbCd',
  '1:2:3:4:5:6:7:8',
  '0000:0000:0000:0000:0000:0000:0000:0001',
  '1::',
  '1:2:3:4:5:6:7::',
  '::1:2:3:4:5:6:7',
  '1234::5678',
  '::ffff:127.0.0.1',
  '::ffff:1.2.3.4',
  '::1.2.3.4',
  '1::1.2.3.4',
  '1:2:3:4:5:6:1.2.3.4',
  '1:2:3:4:5::1.2.3.4',
  '::0.0.0.0',
  '::ffff:0:1.2.3.4',
  // IPv6 zone ids — Node accepts these
  'fe80::1%eth0',
  '1:2:3:4:5:6:7:8%1',
  '::%1',
  '::1%eth-0.1',
  '::ffff:1.2.3.4%eth0',
  // IPv6 — rejected
  '1:2:3:4:5:6:7:8:9',
  '1::2::3',
  '1:2:3:4:5:6:7::8',
  '::1:2:3:4:5:6:7:8',
  '1::2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7:1.2.3.4',
  '::ffff:1.2.3.4.5',
  '1.2.3.4::',
  '12345::',
  '00000::1',
  'g::1',
  '1:',
  '::1:',
  '1:::2',
  ':1:2:3:4:5:6:7:8',
  ':',
  '[::1]',
  'fe80::1%',
  'fe80::1%_',
  'fe80::1%a b',
  '::%%',
  '1.2.3.4%1',
  '%1',
  '',
  'example.com',
  'localhost',
]

/** Deterministic PRNG so a failure is reproducible. */
function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('ipVersion — exact drop-in for node:net.isIP (SSRF guard recogniser)', () => {
  it.each(IP_EDGE_CASES)('agrees with node:net.isIP on %j', (host) => {
    expect(ipVersion(host)).toBe(nodeIsIP(host))
  })

  it('agrees with node:net.isIP on structurally generated IPv6/IPv4 shapes', () => {
    const vectors = new Set<string>()
    for (let n = 0; n <= 9; n++) {
      const groups = Array.from({ length: n }, (_, i) => String(i + 1))
      vectors.add(groups.join(':'))
      vectors.add(`::${groups.join(':')}`)
      vectors.add(`${groups.join(':')}::`)
      for (let k = 1; k < n; k++) {
        vectors.add(`${groups.slice(0, k).join(':')}::${groups.slice(k).join(':')}`)
      }
      vectors.add(`${groups.join(':')}:1.2.3.4`)
      vectors.add(`::${groups.join(':')}:1.2.3.4`)
      vectors.add(`${groups.join(':')}::1.2.3.4`)
      vectors.add(`1.2.3.4::${groups.join(':')}`)
      vectors.add(`${groups.join(':')}%eth0`)
    }
    const octets = ['0', '1', '9', '10', '99', '100', '199', '255', '256', '300', '00', '01', '010', '', '+1', '-1', '0x1']
    for (const o of octets) {
      vectors.add(`${o}.2.3.4`)
      vectors.add(`1.${o}.3.4`)
      vectors.add(`1.2.3.${o}`)
      vectors.add(`${o}.${o}.${o}.${o}`)
    }
    const mismatches: string[] = []
    for (const host of vectors) {
      if (ipVersion(host) !== nodeIsIP(host)) mismatches.push(host)
    }
    expect(mismatches).toEqual([])
    expect(vectors.size).toBeGreaterThan(150)
  })

  it('agrees with node:net.isIP on 200k randomly generated hostname-ish strings', () => {
    const rnd = makeRng(0x9e3779b9)
    const alphabet = '0123456789abcdefABCDEFg:.%[]-+ _'
    const mismatches: string[] = []
    for (let i = 0; i < 200_000; i++) {
      const len = 1 + Math.floor(rnd() * 24)
      let host = ''
      for (let j = 0; j < len; j++) host += alphabet[Math.floor(rnd() * alphabet.length)]
      if (ipVersion(host) !== nodeIsIP(host) && mismatches.length < 20) mismatches.push(host)
    }
    expect(mismatches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. The SSRF guard itself — end-to-end behaviour must be unchanged
// ---------------------------------------------------------------------------

describe('assertSafeWebhookUrl — guard matrix preserved after dropping node:net', () => {
  const REJECTED = [
    'http://example.com/hook', // not https
    'ftp://example.com/hook',
    'https://localhost/hook',
    'https://LOCALHOST/hook',
    'https://foo.internal/hook',
    'https://foo.local/hook',
    'https://FOO.INTERNAL/hook',
    'https://10.0.0.5/hook',
    'https://10.255.255.255/hook',
    'https://127.0.0.1/hook',
    'https://127.1.2.3/hook',
    'https://172.16.0.1/hook',
    'https://172.31.255.255/hook',
    'https://192.168.1.1/hook',
    'https://169.254.169.254/latest/meta-data', // cloud metadata
    'https://0.0.0.0/hook',
    'https://[::1]/hook',
    'https://[::]/hook',
    'https://[fc00::1]/hook',
    'https://[fd12:3456::1]/hook',
    'https://[fe80::1]/hook',
    'not-a-url',
  ]
  it.each(REJECTED)('rejects %s', (url) => {
    expect(() => { assertSafeWebhookUrl(url) }).toThrow(UnsafeWebhookUrlError)
  })

  const ALLOWED = [
    'https://example.com/hook',
    'https://hooks.slack.com/services/T/B/X',
    'https://sub.domain.example.co.uk:8443/path?q=1',
    'https://8.8.8.8/hook',
    'https://172.32.0.1/hook', // just outside 172.16.0.0/12
    'https://172.15.255.255/hook',
    'https://11.0.0.1/hook',
    'https://192.169.0.1/hook',
    'https://169.253.0.1/hook',
    'https://[2606:4700::1111]/hook',
  ]
  it.each(ALLOWED)('allows %s', (url) => {
    expect(() => { assertSafeWebhookUrl(url) }).not.toThrow()
  })

  // The IPv4 normalisation the WHATWG URL parser performs BEFORE the guard sees
  // the hostname: these all collapse to a loopback/private literal and must
  // still be blocked, exactly as they were with node:net's isIP.
  const NORMALISED_LOOPBACK = [
    'https://2130706433/hook', // decimal 127.0.0.1
    'https://0x7f.0.0.1/hook', // hex-octet form
    'https://010.0.0.1/hook', // octal 8.0.0.1 -> not private; see assertion below
    'https://127.1/hook', // short form of 127.0.0.1
  ]
  it.each(NORMALISED_LOOPBACK)('sees the URL-parser-normalised hostname for %s', (url) => {
    const host = new URL(url).hostname
    // Whatever the parser produced, ipVersion must agree with node:net.isIP on it
    // — that agreement is what keeps the private-range checks reachable.
    expect(ipVersion(host)).toBe(nodeIsIP(host))
  })

  it('blocks decimal/hex/short-form spellings of loopback', () => {
    for (const url of ['https://2130706433/hook', 'https://0x7f.0.0.1/hook', 'https://127.1/hook']) {
      expect(new URL(url).hostname).toBe('127.0.0.1')
      expect(() => { assertSafeWebhookUrl(url) }).toThrow(UnsafeWebhookUrlError)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. randomHex — drop-in for randomBytes(n).toString("hex")
// ---------------------------------------------------------------------------

describe('randomHex — drop-in for node:crypto randomBytes(n).toString("hex")', () => {
  it('returns 2n lowercase hex characters', () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/)
    expect(randomHex(16)).toHaveLength(32)
    expect(randomHex(1)).toHaveLength(2)
    expect(randomHex(0)).toBe('')
  })

  it('does not repeat across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(randomHex(32))
    expect(seen.size).toBe(500)
  })

  it('bytesToHex matches Buffer.toString("hex") for every byte value', () => {
    const all = new Uint8Array(256)
    for (let i = 0; i < 256; i++) all[i] = i
    expect(bytesToHex(all)).toBe(Buffer.from(all).toString('hex'))
  })
})
