import { describe, it, expect, beforeEach } from 'vitest'
import {
  PAYLOAD_EXTERNALIZATION_THRESHOLD,
  sha256Hex,
} from '../../apps/web/src/lib/storage/adapter.js'
import { StubBlobStorageAdapter } from '../../apps/web/src/lib/storage/stub.js'
import { getStorageAdapter } from '../../apps/web/src/lib/storage/index.js'

// ---------------------------------------------------------------------------
// PAYLOAD_EXTERNALIZATION_THRESHOLD
// ---------------------------------------------------------------------------

describe('PAYLOAD_EXTERNALIZATION_THRESHOLD', () => {
  it('is exactly 10240 bytes (10 * 1024)', () => {
    expect(PAYLOAD_EXTERNALIZATION_THRESHOLD).toBe(10 * 1024)
    expect(PAYLOAD_EXTERNALIZATION_THRESHOLD).toBe(10240)
  })

  it('a payload JSON string of 10240 chars meets or exceeds the threshold', () => {
    // "too large" means length >= threshold (threshold is NOT exclusive on the upper bound;
    // a payload at exactly the threshold must also be externalized — it is not below it)
    const atThreshold = 'x'.repeat(PAYLOAD_EXTERNALIZATION_THRESHOLD)
    expect(atThreshold.length >= PAYLOAD_EXTERNALIZATION_THRESHOLD).toBe(true)
  })

  it('a payload JSON string of 10239 chars is strictly below the threshold', () => {
    const belowThreshold = 'x'.repeat(PAYLOAD_EXTERNALIZATION_THRESHOLD - 1)
    expect(belowThreshold.length < PAYLOAD_EXTERNALIZATION_THRESHOLD).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe('sha256Hex', () => {
  it('returns a 64-character hex string', async () => {
    const hash = await sha256Hex('hello world')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic — same input produces same output on repeated calls', async () => {
    const input = 'deterministic input string'
    const first = await sha256Hex(input)
    const second = await sha256Hex(input)
    expect(first).toBe(second)
  })

  it('different inputs produce different hashes', async () => {
    const hashA = await sha256Hex('input-a')
    const hashB = await sha256Hex('input-b')
    expect(hashA).not.toBe(hashB)
  })

  it('empty string produces the known SHA-256 digest', async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = await sha256Hex('')
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('empty string hash starts with the expected prefix e3b0c4', async () => {
    const hash = await sha256Hex('')
    expect(hash.startsWith('e3b0c4')).toBe(true)
  })

  it('"hello" produces the known SHA-256 digest', async () => {
    // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const hash = await sha256Hex('hello')
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('output contains only lowercase hex characters', async () => {
    const hash = await sha256Hex('any content here')
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })
})

// ---------------------------------------------------------------------------
// StubBlobStorageAdapter
// ---------------------------------------------------------------------------

describe('StubBlobStorageAdapter', () => {
  let adapter: StubBlobStorageAdapter

  beforeEach(() => {
    // Fresh instance per test — no shared state
    adapter = new StubBlobStorageAdapter()
  })

  it('upload() stores data and returns the same key', async () => {
    const returnedKey = await adapter.upload('my/key.json', '{"x":1}', 'application/json')
    expect(returnedKey).toBe('my/key.json')
  })

  it('getUrl() returns a data URL containing the base64-encoded content', async () => {
    const content = 'hello storage'
    await adapter.upload('test/data.txt', content, 'text/plain')
    const url = await adapter.getUrl('test/data.txt')
    const expectedBase64 = Buffer.from(content).toString('base64')
    expect(url).toContain(expectedBase64)
  })

  it('getUrl() returns a data URL with the correct MIME type prefix for application/json', async () => {
    await adapter.upload('events/payload.json', '{"type":"test"}', 'application/json')
    const url = await adapter.getUrl('events/payload.json')
    expect(url.startsWith('data:application/json;base64,')).toBe(true)
  })

  it('getUrl() throws when key is not found', async () => {
    await expect(adapter.getUrl('does/not/exist.json')).rejects.toThrow()
  })

  it('getUrl() error message mentions the missing key', async () => {
    const missingKey = 'missing/key.json'
    await expect(adapter.getUrl(missingKey)).rejects.toThrow(missingKey)
  })

  it('has() returns true for a stored key', async () => {
    await adapter.upload('stored/key.bin', 'data', 'application/octet-stream')
    expect(adapter.has('stored/key.bin')).toBe(true)
  })

  it('has() returns false for a key that was never uploaded', async () => {
    expect(adapter.has('never/uploaded.json')).toBe(false)
  })

  it('size() returns 0 on a fresh adapter', () => {
    expect(adapter.size()).toBe(0)
  })

  it('size() returns the count of stored objects after uploads', async () => {
    await adapter.upload('a.json', '1', 'application/json')
    await adapter.upload('b.json', '2', 'application/json')
    await adapter.upload('c.json', '3', 'application/json')
    expect(adapter.size()).toBe(3)
  })

  it('two uploads with different keys are stored independently', async () => {
    await adapter.upload('key-alpha', 'alpha content', 'text/plain')
    await adapter.upload('key-beta', 'beta content', 'text/plain')

    expect(adapter.getRaw('key-alpha')).toBe('alpha content')
    expect(adapter.getRaw('key-beta')).toBe('beta content')
  })

  it('getRaw() returns the original string exactly as uploaded', async () => {
    const original = JSON.stringify({ event: 'run.started', seq: 1 })
    await adapter.upload('runs/evt-001.json', original, 'application/json')
    expect(adapter.getRaw('runs/evt-001.json')).toBe(original)
  })

  it('getRaw() returns undefined for a key that was never uploaded', () => {
    expect(adapter.getRaw('nonexistent')).toBeUndefined()
  })

  it('uploading the same key twice overwrites the previous value', async () => {
    await adapter.upload('overwrite.json', 'first', 'application/json')
    await adapter.upload('overwrite.json', 'second', 'application/json')
    expect(adapter.getRaw('overwrite.json')).toBe('second')
    // Size should not increase — same key
    expect(adapter.size()).toBe(1)
  })

  it('getUrl() data URL is directly decodable back to original content', async () => {
    const original = 'round-trip check'
    await adapter.upload('rt/test.txt', original, 'text/plain')
    const url = await adapter.getUrl('rt/test.txt')
    // Strip the data URL prefix: "data:<mime>;base64,"
    const base64Part = url.split(',')[1]!
    const decoded = Buffer.from(base64Part, 'base64').toString('utf8')
    expect(decoded).toBe(original)
  })
})

// ---------------------------------------------------------------------------
// getStorageAdapter()
// ---------------------------------------------------------------------------

describe('getStorageAdapter()', () => {
  it('returns an adapter when BLOB_STORE_TOKEN is unset (stub adapter for local dev)', () => {
    const original = process.env['BLOB_STORE_TOKEN']
    delete process.env['BLOB_STORE_TOKEN']
    try {
      const adapter = getStorageAdapter()
      expect(adapter).toBeDefined()
      // The stub adapter has upload and getUrl methods
      expect(typeof adapter.upload).toBe('function')
      expect(typeof adapter.getUrl).toBe('function')
    } finally {
      if (original !== undefined) {
        process.env['BLOB_STORE_TOKEN'] = original
      }
    }
  })

  it('returns an adapter with upload and getUrl when BLOB_STORE_TOKEN is unset', () => {
    const original = process.env['BLOB_STORE_TOKEN']
    delete process.env['BLOB_STORE_TOKEN']
    try {
      const adapter = getStorageAdapter()
      expect(typeof adapter.upload).toBe('function')
      expect(typeof adapter.getUrl).toBe('function')
    } finally {
      if (original !== undefined) {
        process.env['BLOB_STORE_TOKEN'] = original
      }
    }
  })

  it('returns an adapter with upload and getUrl when BLOB_STORE_TOKEN is set (Vercel Blob path)', () => {
    const original = process.env['BLOB_STORE_TOKEN']
    process.env['BLOB_STORE_TOKEN'] = 'vercel_blob_rw_test_token'
    try {
      const adapter = getStorageAdapter()
      expect(adapter).toBeDefined()
      expect(typeof adapter.upload).toBe('function')
      expect(typeof adapter.getUrl).toBe('function')
    } finally {
      if (original !== undefined) {
        process.env['BLOB_STORE_TOKEN'] = original
      } else {
        delete process.env['BLOB_STORE_TOKEN']
      }
    }
  })

  it('does not throw synchronously regardless of BLOB_STORE_TOKEN value', () => {
    const original = process.env['BLOB_STORE_TOKEN']
    // Both set and unset should not throw synchronously — adapter is always returned
    process.env['BLOB_STORE_TOKEN'] = 'some-token'
    try {
      expect(() => getStorageAdapter()).not.toThrow()
    } finally {
      if (original !== undefined) {
        process.env['BLOB_STORE_TOKEN'] = original
      } else {
        delete process.env['BLOB_STORE_TOKEN']
      }
    }
  })
})
