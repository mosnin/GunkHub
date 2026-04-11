import { describe, it, expect } from 'vitest'

import {
  parseSchemaTableFields,
  parseContractsInterfaceProperties,
} from '../../scripts/check-schema-drift.js'

// ---------------------------------------------------------------------------
// A. parseSchemaTableFields
// ---------------------------------------------------------------------------

describe('parseSchemaTableFields — schema.ts parsing', () => {
  it('parses a minimal schema with one table and one field', () => {
    const content = `
export default defineSchema({
  runs: defineTable({
    orgId: v.string(),
  }),
})`
    const result = parseSchemaTableFields(content)
    expect(result['runs']).toBeDefined()
    expect(result['runs']!.has('orgId')).toBe(true)
  })

  it('parses multiple fields from a single table', () => {
    const content = `
export default defineSchema({
  events: defineTable({
    runId: v.string(),
    eventType: v.string(),
    sequenceNumber: v.number(),
    payload: v.any(),
  }),
})`
    const result = parseSchemaTableFields(content)
    const fields = result['events']!
    expect(fields.has('runId')).toBe(true)
    expect(fields.has('eventType')).toBe(true)
    expect(fields.has('sequenceNumber')).toBe(true)
    expect(fields.has('payload')).toBe(true)
    expect(fields.size).toBe(4)
  })

  it('parses multiple tables', () => {
    const content = `
export default defineSchema({
  organizations: defineTable({
    name: v.string(),
  }),
  projects: defineTable({
    slug: v.string(),
    orgId: v.string(),
  }),
})`
    const result = parseSchemaTableFields(content)
    expect(result['organizations']).toBeDefined()
    expect(result['organizations']!.has('name')).toBe(true)
    expect(result['projects']).toBeDefined()
    expect(result['projects']!.has('slug')).toBe(true)
    expect(result['projects']!.has('orgId')).toBe(true)
  })

  it('skips _id and _creationTime (SCHEMA_FIELD_EXCLUSIONS)', () => {
    const content = `
export default defineSchema({
  runs: defineTable({
    _id: v.id("runs"),
    _creationTime: v.number(),
    orgId: v.string(),
  }),
})`
    const result = parseSchemaTableFields(content)
    const fields = result['runs']!
    expect(fields.has('_id')).toBe(false)
    expect(fields.has('_creationTime')).toBe(false)
    expect(fields.has('orgId')).toBe(true)
  })

  it('handles multi-line v.union(...) values — captures field name, not inner union lines', () => {
    const content = `
export default defineSchema({
  runs: defineTable({
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    orgId: v.string(),
  }),
})`
    const result = parseSchemaTableFields(content)
    const fields = result['runs']!
    // Field name captured from the opening line
    expect(fields.has('status')).toBe(true)
    // Inner union lines should not become spurious field names
    expect(fields.has('running')).toBe(false)
    expect(fields.has('completed')).toBe(false)
    expect(fields.has('failed')).toBe(false)
    expect(fields.has('orgId')).toBe(true)
  })

  it('returns empty Set for a table with no fields', () => {
    const content = `
export default defineSchema({
  empty_table: defineTable({
  }),
})`
    const result = parseSchemaTableFields(content)
    expect(result['empty_table']).toBeDefined()
    expect(result['empty_table']!.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// B. parseContractsInterfaceProperties
// ---------------------------------------------------------------------------

describe('parseContractsInterfaceProperties — entities.ts parsing', () => {
  it('parses a minimal interface with one property', () => {
    const content = `
export interface Run {
  orgId: string
}`
    const result = parseContractsInterfaceProperties(content)
    expect(result['Run']).toBeDefined()
    expect(result['Run']!.has('orgId')).toBe(true)
  })

  it('parses optional properties (trailing ?)', () => {
    const content = `
export interface AgentVersion {
  label: string
  configSnapshot?: Record<string, unknown>
}`
    const result = parseContractsInterfaceProperties(content)
    const props = result['AgentVersion']!
    expect(props.has('label')).toBe(true)
    expect(props.has('configSnapshot')).toBe(true)
  })

  it('parses multiple properties from one interface', () => {
    const content = `
export interface Event {
  runId: string
  eventType: string
  sequenceNumber: number
  payload: unknown
  createdAt: number
}`
    const result = parseContractsInterfaceProperties(content)
    const props = result['Event']!
    expect(props.has('runId')).toBe(true)
    expect(props.has('eventType')).toBe(true)
    expect(props.has('sequenceNumber')).toBe(true)
    expect(props.has('payload')).toBe(true)
    expect(props.has('createdAt')).toBe(true)
    expect(props.size).toBe(5)
  })

  it('skips id property (CONTRACTS_PROPERTY_EXCLUSIONS)', () => {
    const content = `
export interface Organization {
  id: string
  name: string
  clerkOrgId: string
}`
    const result = parseContractsInterfaceProperties(content)
    const props = result['Organization']!
    // id is excluded because it maps to Convex's _id auto-field
    expect(props.has('id')).toBe(false)
    expect(props.has('name')).toBe(true)
    expect(props.has('clerkOrgId')).toBe(true)
  })

  it('returns empty Set for an interface with no properties', () => {
    const content = `
export interface EmptyEntity {
}`
    const result = parseContractsInterfaceProperties(content)
    expect(result['EmptyEntity']).toBeDefined()
    expect(result['EmptyEntity']!.size).toBe(0)
  })

  it('parses multiple interfaces from one file', () => {
    const content = `
export interface Project {
  orgId: string
  slug: string
}

export interface Agent {
  projectId: string
  name: string
}`
    const result = parseContractsInterfaceProperties(content)
    expect(result['Project']).toBeDefined()
    expect(result['Project']!.has('orgId')).toBe(true)
    expect(result['Project']!.has('slug')).toBe(true)
    expect(result['Agent']).toBeDefined()
    expect(result['Agent']!.has('projectId')).toBe(true)
    expect(result['Agent']!.has('name')).toBe(true)
  })
})
