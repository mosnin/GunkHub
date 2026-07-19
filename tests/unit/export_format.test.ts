import { describe, it, expect } from 'vitest'

import {
  EXPORT_DEFAULT_LIMIT,
  EXPORT_MAX_LIMIT,
  RUN_CSV_COLUMNS,
  buildCsvHeaderRow,
  csvEscapeField,
  isExportTruncated,
  parseExportFormat,
  parseRunExportFilters,
  resolveExportLimit,
  runBundleArtifactLine,
  runBundleCommentLine,
  runBundleEventLine,
  runBundleRunLine,
  runBundleVerificationLine,
  runToCsvRow,
  toNdjsonLine,
} from '../../apps/web/src/lib/exportFormat.js'

import type { Artifact, Comment, Event, Run } from '@agent-flight-recorder/contracts'

const RUN: Run = {
  id: 'run-1',
  orgId: 'org-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  agentVersionId: 'ver-1',
  status: 'completed',
  startedAt: 1_000,
  endedAt: 2_000,
  metadata: { key: 'value' },
  tags: ['a', 'b'],
  triggeredBy: 'user-1',
  sdkVersion: '1.0.0',
}

describe('csvEscapeField', () => {
  it('leaves plain values untouched', () => {
    expect(csvEscapeField('hello')).toBe('hello')
    expect(csvEscapeField(42)).toBe('42')
  })

  it('renders null/undefined as empty string', () => {
    expect(csvEscapeField(null)).toBe('')
    expect(csvEscapeField(undefined)).toBe('')
  })

  it('quotes values containing commas', () => {
    expect(csvEscapeField('a,b')).toBe('"a,b"')
  })

  it('quotes values containing double quotes and doubles them', () => {
    expect(csvEscapeField('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes values containing newlines', () => {
    expect(csvEscapeField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscapeField('a\rb')).toBe('"a\rb"')
  })

  it('applies the guard when a CR/tab is the leading character', () => {
    expect(csvEscapeField('\rleading-cr')).toBe('"\'\rleading-cr"')
    expect(csvEscapeField('\tleading-tab')).toBe("'\tleading-tab")
  })

  describe('formula injection guard', () => {
    const cases = ['=SUM(A1:A9)', '+1+1', '-2+3', '@cmd', '\t=1', '\revil']
    for (const raw of cases) {
      it(`prefixes a leading-quote for ${JSON.stringify(raw)}`, () => {
        const escaped = csvEscapeField(raw)
        // Strip surrounding quotes (if any) before checking the guard prefix.
        const unquoted =
          escaped.startsWith('"') && escaped.endsWith('"')
            ? escaped.slice(1, -1).replace(/""/g, '"')
            : escaped
        expect(unquoted.startsWith("'")).toBe(true)
      })
    }

    it('does not alter a value that merely contains = elsewhere', () => {
      expect(csvEscapeField('total=5')).toBe('total=5')
    })
  })
})

describe('runToCsvRow / buildCsvHeaderRow', () => {
  it('produces a header matching RUN_CSV_COLUMNS in stable order', () => {
    expect(buildCsvHeaderRow()).toBe(RUN_CSV_COLUMNS.join(','))
  })

  it('renders all fields in column order', () => {
    const row = runToCsvRow(RUN)
    const cells = row.split(',')
    expect(cells[0]).toBe('run-1')
    expect(cells[1]).toBe('org-1')
    expect(cells[5]).toBe('completed')
    expect(row).toContain('a;b') // tags joined with ;
  })

  it('renders optional fields as empty string when absent', () => {
    const minimal: Run = {
      id: 'run-2',
      orgId: 'org-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      status: 'pending',
      startedAt: 1_000,
      metadata: {},
      tags: [],
    }
    const row = runToCsvRow(minimal)
    const cells = row.split(',')
    // agentVersionId, endedAt, tags, triggeredBy, sdkVersion, metadataJson all blank
    expect(cells[3]).toBe('agent-1')
    expect(cells[4]).toBe('') // agentVersionId
    expect(cells[6]).toBe('1000') // startedAt (required)
    expect(cells[7]).toBe('') // endedAt
    expect(cells[8]).toBe('') // tags (empty array -> '')
  })

  it('quotes the metadataJson field (a JSON object always needs CSV quoting)', () => {
    const run: Run = { ...RUN, metadata: { note: '=cmd|calc' } }
    const row = runToCsvRow(run)
    // The serialized JSON value itself starts with "{", not "=", so the
    // formula-injection guard correctly does not fire here — the guard
    // matters for scalar fields, not for a JSON blob wrapped in braces.
    // What matters is that the embedded value survives CSV quoting intact
    // (inner double quotes doubled) and is not corrupted or truncated.
    expect(row).toContain('"{""note"":""=cmd|calc""}"')
  })
})

describe('ndjson framing', () => {
  it('serializes one record per line with a trailing newline', () => {
    const line = toNdjsonLine({ a: 1 })
    expect(line).toBe('{"a":1}\n')
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2) // content + trailing empty
  })

  it('tags run/event/artifact/comment/verification bundle lines with a discriminator', () => {
    const event: Event = {
      id: 'evt-1',
      runId: 'run-1',
      orgId: 'org-1',
      type: 'custom',
      sequenceNumber: 1,
      timestamp: 1_000,
      payload: { type: 'custom', data: null },
    }
    const artifact: Artifact = {
      id: 'art-1',
      runId: 'run-1',
      orgId: 'org-1',
      name: 'file.txt',
      mimeType: 'text/plain',
      size: 10,
      storageKey: 'key-1',
      storageBucket: 'bucket-1',
      checksum: 'abc123',
      createdAt: 1_000,
    }
    const comment: Comment = {
      id: 'cmt-1',
      orgId: 'org-1',
      targetId: 'run-1',
      targetType: 'run',
      authorId: 'user-1',
      content: 'hello',
      createdAt: 1_000,
    }

    expect(JSON.parse(runBundleRunLine(RUN).trimEnd())).toMatchObject({ record: 'run' })
    expect(JSON.parse(runBundleEventLine(event).trimEnd())).toMatchObject({ record: 'event' })
    expect(JSON.parse(runBundleArtifactLine(artifact).trimEnd())).toMatchObject({ record: 'artifact' })
    expect(JSON.parse(runBundleCommentLine(comment).trimEnd())).toMatchObject({ record: 'comment' })
    expect(
      JSON.parse(
        runBundleVerificationLine({
          verified: true,
          isValid: true,
          verifiedAt: 1,
          summary: 'ok',
        }).trimEnd(),
      ),
    ).toMatchObject({ record: 'verification' })
  })
})

describe('resolveExportLimit / isExportTruncated', () => {
  it('defaults when missing, empty, non-numeric, zero, or negative', () => {
    expect(resolveExportLimit(null)).toBe(EXPORT_DEFAULT_LIMIT)
    expect(resolveExportLimit('')).toBe(EXPORT_DEFAULT_LIMIT)
    expect(resolveExportLimit('abc')).toBe(EXPORT_DEFAULT_LIMIT)
    expect(resolveExportLimit('0')).toBe(EXPORT_DEFAULT_LIMIT)
    expect(resolveExportLimit('-5')).toBe(EXPORT_DEFAULT_LIMIT)
  })

  it('clamps to EXPORT_MAX_LIMIT', () => {
    expect(resolveExportLimit('999999')).toBe(EXPORT_MAX_LIMIT)
  })

  it('floors fractional values and passes through valid values', () => {
    expect(resolveExportLimit('10.9')).toBe(10)
    expect(resolveExportLimit('250')).toBe(250)
  })

  it('reports truncated only when fetched count exceeds the limit', () => {
    expect(isExportTruncated(10, 10)).toBe(false)
    expect(isExportTruncated(11, 10)).toBe(true)
    expect(isExportTruncated(5, 10)).toBe(false)
  })
})

describe('parseExportFormat / parseRunExportFilters', () => {
  it('defaults to ndjson for missing/unknown format', () => {
    expect(parseExportFormat(null)).toBe('ndjson')
    expect(parseExportFormat('xml')).toBe('ndjson')
  })

  it('accepts json and csv explicitly', () => {
    expect(parseExportFormat('json')).toBe('json')
    expect(parseExportFormat('csv')).toBe('csv')
  })

  it('passes through valid status/agentId/projectId filters', () => {
    const params = new URLSearchParams({
      format: 'csv',
      status: 'failed',
      agentId: 'agent-9',
      projectId: 'proj-9',
      limit: '50',
    })
    expect(parseRunExportFilters(params)).toEqual({
      format: 'csv',
      status: 'failed',
      agentId: 'agent-9',
      projectId: 'proj-9',
      limit: 50,
    })
  })

  it('drops an invalid status rather than passing it through', () => {
    const params = new URLSearchParams({ status: 'bogus' })
    const filters = parseRunExportFilters(params)
    expect(filters.status).toBeUndefined()
  })

  it('omits agentId/projectId when absent', () => {
    const filters = parseRunExportFilters(new URLSearchParams())
    expect(filters.agentId).toBeUndefined()
    expect(filters.projectId).toBeUndefined()
    expect(filters.format).toBe('ndjson')
    expect(filters.limit).toBe(EXPORT_DEFAULT_LIMIT)
  })
})
