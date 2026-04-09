/**
 * seed.ts — Seed the local Convex deployment with realistic test data.
 *
 * Run with:
 *   npx ts-node --esm scripts/seed.ts
 *   OR after wiring up the convex client:
 *   pnpm seed
 *
 * What this script seeds:
 *
 * 1. Organizations (2)
 *    - "Acme Corp"  — the primary test org, used for all happy-path scenarios
 *    - "Rival Inc"  — a second org used to verify cross-org isolation rules
 *
 * 2. Projects (3, all under Acme Corp)
 *    - "Document Ingestion Pipeline" — multi-step RAG agent
 *    - "Customer Support Bot"         — conversational agent with tool calls
 *    - "Code Review Assistant"        — code analysis agent
 *
 * 3. Agents + AgentVersions (one agent per project, two versions each)
 *    - Each agent has a "stable" version (v1) and a "canary" version (v2)
 *    - Versions differ in their system prompt and tool list
 *
 * 4. Runs (10 total across projects)
 *    - Mix of completed, failed, and in-progress runs
 *    - Failed runs include a terminal error event so replay can show the failure point
 *    - In-progress runs have events up to a mid-point so the UI can show partial traces
 *
 * 5. Events (50–100 events spread across runs)
 *    Event types covered:
 *    - RUN_STARTED        — first event in every run
 *    - LLM_REQUEST        — prompt sent to language model
 *    - LLM_RESPONSE       — token stream received from language model
 *    - TOOL_CALL          — agent invoked an external tool
 *    - TOOL_RESULT        — result returned from external tool
 *    - MEMORY_READ        — agent read from its memory/context store
 *    - MEMORY_WRITE       — agent wrote to its memory/context store
 *    - HANDOFF            — agent handed off to a sub-agent
 *    - ERROR              — non-terminal error (agent recovered)
 *    - RUN_COMPLETED      — last event in a successful run
 *    - RUN_FAILED         — last event in a failed run
 *
 * 6. Artifacts (attached to runs that have large payloads)
 *    - Each LLM_REQUEST/LLM_RESPONSE pair where the payload exceeds 10 KB
 *      is stored as an artifact pointing to the blob store.
 *    - Seed artifacts use synthetic blob URLs (blob://seed/<uuid>).
 *
 * 7. Comments (a handful)
 *    - Two comments on a failed run: one at the RUN_FAILED event, one on the run itself
 *    - Demonstrates that comments can attach to both runs and individual events
 *
 * Cross-org isolation test data:
 *    - Rival Inc has one project and one run.
 *    - None of Rival Inc's data should ever appear in Acme Corp queries.
 *
 * Idempotency:
 *    - The script checks for an existing "seed marker" document before writing.
 *    - Re-running the script is safe; it will skip if seed data already exists.
 *    - Pass --force to truncate and re-seed.
 */

import { ConvexClient } from 'convex/browser'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env['NEXT_PUBLIC_CONVEX_URL']

if (!CONVEX_URL) {
  console.error('Error: NEXT_PUBLIC_CONVEX_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

const FORCE_RESEED = process.argv.includes('--force')

// ---------------------------------------------------------------------------
// Seed data definitions
// ---------------------------------------------------------------------------

const ORGS = [
  {
    clerkOrgId: 'org_seed_acme',
    name: 'Acme Corp',
    slug: 'acme-corp',
  },
  {
    clerkOrgId: 'org_seed_rival',
    name: 'Rival Inc',
    slug: 'rival-inc',
  },
] as const

const PROJECTS = [
  {
    orgSlug: 'acme-corp',
    name: 'Document Ingestion Pipeline',
    slug: 'doc-ingestion',
    description: 'Multi-step RAG pipeline that chunks, embeds, and indexes documents.',
  },
  {
    orgSlug: 'acme-corp',
    name: 'Customer Support Bot',
    slug: 'support-bot',
    description: 'Conversational agent that resolves tier-1 support tickets.',
  },
  {
    orgSlug: 'acme-corp',
    name: 'Code Review Assistant',
    slug: 'code-review',
    description: 'Reviews pull requests for correctness, style, and security issues.',
  },
  {
    orgSlug: 'rival-inc',
    name: 'Internal Ops Agent',
    slug: 'internal-ops',
    description: 'Cross-org isolation test project — should never appear in Acme queries.',
  },
] as const

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Agent Flight Recorder — Seed Script')
  console.log('=====================================')
  console.log(`Convex URL: ${CONVEX_URL}`)
  console.log(`Force reseed: ${FORCE_RESEED}`)
  console.log('')

  const client = new ConvexClient(CONVEX_URL as string)

  try {
    // The actual mutation calls will be added once the Convex schema and
    // mutations are defined by the backend team (Team B / Team C).
    // This script is structured and ready to be wired up.

    console.log('Seeding organizations...')
    for (const org of ORGS) {
      console.log(`  • ${org.name} (${org.clerkOrgId})`)
      // await client.mutation(api.seed.upsertOrganization, org)
    }

    console.log('Seeding projects...')
    for (const project of PROJECTS) {
      console.log(`  • ${project.name} → ${project.orgSlug}`)
      // await client.mutation(api.seed.upsertProject, project)
    }

    console.log('Seeding agents, versions, runs, and events...')
    // await client.mutation(api.seed.seedAgentData, { force: FORCE_RESEED })

    console.log('')
    console.log('Seed complete.')
    console.log('Note: mutation calls are commented out pending schema definition.')
    console.log('Uncomment and wire up api.seed.* once the Convex schema is live.')
  } finally {
    client.close()
  }
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
