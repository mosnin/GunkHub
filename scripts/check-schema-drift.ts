#!/usr/bin/env tsx
/**
 * check-schema-drift.ts
 *
 * Compares field names defined in convex/schema.ts against property names
 * defined in packages/contracts/src/entities.ts for each entity that has
 * a corresponding contract type.
 *
 * Exits with code 1 if any mismatch is found.
 * Run: pnpm tsx scripts/check-schema-drift.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.join(__dirname, '..')

// Convex table name → contracts interface name.
// Only tables with a corresponding public contract type are listed here.
// Internal-only tables (user_memberships, api_keys) are intentionally excluded.
const TABLE_TO_INTERFACE: Record<string, string> = {
  organizations: 'Organization',
  projects: 'Project',
  agents: 'Agent',
  agent_versions: 'AgentVersion',
  runs: 'Run',
  events: 'Event',
  artifacts: 'Artifact',
  comments: 'Comment',
}

// Convex auto-fields — present on every stored document but never declared
// in schema.ts defineTable({...}) bodies.
const SCHEMA_FIELD_EXCLUSIONS = new Set(['_id', '_creationTime'])

// Contracts properties that map to Convex's _id auto-field and are therefore
// not declared in schema.ts.
const CONTRACTS_PROPERTY_EXCLUSIONS = new Set(['id'])

/**
 * Parse convex/schema.ts and return a map of tableName → Set<fieldName>.
 * Only fields declared inside defineTable({...}) bodies are returned.
 * Convex auto-fields (_id, _creationTime) are excluded via SCHEMA_FIELD_EXCLUSIONS.
 */
export function parseSchemaTableFields(content: string): Record<string, Set<string>> {
  const tables: Record<string, Set<string>> = {}
  let depth = 0
  let currentTable: string | null = null
  let tableStartDepth = -1

  for (const line of content.split('\n')) {
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length

    // At depth 1 (inside defineSchema({...})), look for table declarations.
    // Pattern: "  tableName: defineTable({"
    if (depth === 1 && currentTable === null) {
      const m = line.match(/^\s+(\w+)\s*:\s*defineTable\s*\(\s*\{/)
      if (m) {
        currentTable = m[1]
        tables[currentTable] = new Set()
        tableStartDepth = depth
      }
    }

    depth += opens - closes

    // At depth tableStartDepth+1 (inside the defineTable object), extract field names.
    // Pattern: "    fieldName: v.something"
    if (currentTable !== null && depth === tableStartDepth + 1) {
      const m = line.match(/^\s+(\w+)\s*:\s*v\./)
      if (m && !SCHEMA_FIELD_EXCLUSIONS.has(m[1])) {
        tables[currentTable].add(m[1])
      }
    }

    // When depth drops back to tableStartDepth, we have left the table body.
    if (currentTable !== null && depth <= tableStartDepth) {
      currentTable = null
      tableStartDepth = -1
    }
  }

  return tables
}

/**
 * Parse packages/contracts/src/entities.ts and return a map of
 * interfaceName → Set<propertyName>.
 * Only top-level export interfaces are parsed.
 */
export function parseContractsInterfaceProperties(content: string): Record<string, Set<string>> {
  const interfaces: Record<string, Set<string>> = {}
  let currentInterface: string | null = null

  for (const line of content.split('\n')) {
    if (currentInterface === null) {
      // Look for: "export interface InterfaceName {"
      const m = line.match(/^export interface (\w+)\s*\{/)
      if (m) {
        currentInterface = m[1]
        interfaces[currentInterface] = new Set()
      }
      continue
    }

    // End of interface block
    if (line.trimEnd() === '}') {
      currentInterface = null
      continue
    }

    // Property declaration: "  name: type;" or "  name?: type;"
    const m = line.match(/^\s{2}(\w+)\??\s*:/)
    if (m && !CONTRACTS_PROPERTY_EXCLUSIONS.has(m[1])) {
      interfaces[currentInterface].add(m[1])
    }
  }

  return interfaces
}

function main(): void {
  const schemaPath = path.join(REPO_ROOT, 'convex', 'schema.ts')
  const contractsPath = path.join(REPO_ROOT, 'packages', 'contracts', 'src', 'entities.ts')

  const schemaContent = fs.readFileSync(schemaPath, 'utf8')
  const contractsContent = fs.readFileSync(contractsPath, 'utf8')

  const schemaFields = parseSchemaTableFields(schemaContent)
  const contractsProperties = parseContractsInterfaceProperties(contractsContent)

  let hasErrors = false
  const lines: string[] = []

  lines.push('')
  lines.push('Agent Flight Recorder — Schema Drift Check')
  lines.push('─'.repeat(50))

  for (const [tableName, interfaceName] of Object.entries(TABLE_TO_INTERFACE)) {
    const schemaSet = schemaFields[tableName]
    const contractsSet = contractsProperties[interfaceName]

    if (!schemaSet) {
      lines.push(`  ERROR  Table "${tableName}" not found in convex/schema.ts`)
      hasErrors = true
      continue
    }

    if (!contractsSet) {
      lines.push(`  ERROR  Interface "${interfaceName}" not found in packages/contracts/src/entities.ts`)
      hasErrors = true
      continue
    }

    const missingFromContracts = [...schemaSet].filter((f) => !contractsSet.has(f))
    const missingFromSchema = [...contractsSet].filter((f) => !schemaSet.has(f))

    if (missingFromContracts.length === 0 && missingFromSchema.length === 0) {
      lines.push(`  ✓  ${tableName} ↔ ${interfaceName}`)
    } else {
      lines.push(`  ✗  ${tableName} ↔ ${interfaceName}`)
      for (const f of missingFromContracts) {
        lines.push(`       "${f}" is in convex/schema.ts but missing from contracts`)
      }
      for (const f of missingFromSchema) {
        lines.push(`       "${f}" is in contracts but missing from convex/schema.ts`)
      }
      hasErrors = true
    }
  }

  lines.push('')

  if (hasErrors) {
    lines.push('Schema drift detected.')
    lines.push('')
    lines.push('To fix:')
    lines.push('  1. Added a field to convex/schema.ts?')
    lines.push('     → Add the matching property to packages/contracts/src/entities.ts')
    lines.push('  2. Added a property to packages/contracts/src/entities.ts?')
    lines.push('     → Add the matching field to convex/schema.ts')
    lines.push('  3. Field is intentionally internal (not exposed by the app)?')
    lines.push('     → Add it to SCHEMA_FIELD_EXCLUSIONS in scripts/check-schema-drift.ts')
    lines.push('')
    console.error(lines.join('\n'))
    process.exit(1)
  } else {
    lines.push('No drift detected. Schema and contracts are in sync.')
    lines.push('')
    console.log(lines.join('\n'))
  }
}

main()
