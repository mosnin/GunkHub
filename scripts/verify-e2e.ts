/**
 * verify-e2e.ts
 *
 * End-to-end verification script for Agent Flight Recorder.
 *
 * This script:
 *  1. Checks the web app is reachable at AFR_BASE_URL
 *  2. Creates a run via the FlightRecorder SDK
 *  3. Records several events into the run
 *  4. Completes the run
 *  5. Lists events for that run via GET /api/runs/:id/events
 *  6. Prints a summary of what succeeded / failed
 *
 * Usage:
 *   AFR_API_KEY=<your-key> AFR_BASE_URL=http://localhost:3000 \
 *   AFR_AGENT_ID=<your-agent-id> \
 *   pnpm tsx scripts/verify-e2e.ts
 *
 * Environment variables:
 *   AFR_BASE_URL   Base URL of the running web app. Default: http://localhost:3000
 *   AFR_API_KEY    API key for authentication. Required for protected endpoints.
 *   AFR_AGENT_ID   Agent ID to use for test runs. Default: verify-e2e-agent
 */

const BASE_URL = (process.env['AFR_BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '')
const API_KEY  = process.env['AFR_API_KEY'] ?? ''
const AGENT_ID = process.env['AFR_AGENT_ID'] ?? 'verify-e2e-agent'

// ---------------------------------------------------------------------------
// ANSI colour helpers (no third-party deps)
// ---------------------------------------------------------------------------

const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET  = '\x1b[0m'
const BOLD   = '\x1b[1m'

function ok(msg: string)   { console.log(`${GREEN}  ✓${RESET}  ${msg}`) }
function fail(msg: string)  { console.log(`${RED}  ✗${RESET}  ${msg}`) }
function info(msg: string)  { console.log(`${YELLOW}  →${RESET}  ${msg}`) }
function header(msg: string){ console.log(`\n${BOLD}${msg}${RESET}`) }

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function get(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY

  const response = await fetch(`${BASE_URL}${path}`, { headers })
  let body: unknown
  try { body = await response.json() } catch { body = null }
  return { ok: response.ok, status: response.status, body }
}

async function post(path: string, data: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (API_KEY) headers['x-api-key'] = API_KEY

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  })
  let body: unknown
  try { body = await response.json() } catch { body = null }
  return { ok: response.ok, status: response.status, body }
}

// ---------------------------------------------------------------------------
// Verification steps
// ---------------------------------------------------------------------------

interface StepResult {
  name: string
  passed: boolean
  detail?: string
}

const results: StepResult[] = []

function record(name: string, passed: boolean, detail?: string): void {
  results.push({ name, passed, detail })
  if (passed) {
    ok(name + (detail ? `  (${detail})` : ''))
  } else {
    fail(name + (detail ? `  — ${detail}` : ''))
  }
}

async function step1_checkAppReachable(): Promise<boolean> {
  header('Step 1: Check app is reachable')
  info(`GET ${BASE_URL}/`)
  try {
    const r = await get('/')
    // The root may return HTML (200) or redirect (3xx). Either is fine — we
    // just need the server to respond.
    const reachable = r.status < 500
    record('App responds without 5xx', reachable, `HTTP ${r.status}`)
    return reachable
  } catch (err) {
    record('App responds without 5xx', false, String(err))
    return false
  }
}

async function step2_createRun(): Promise<string | null> {
  header('Step 2: Create a run via POST /api/runs')
  info(`POST ${BASE_URL}/api/runs`)

  try {
    const r = await post('/api/runs', {
      agentId: AGENT_ID,
      metadata: { source: 'verify-e2e', timestamp: Date.now() },
      tags: ['e2e', 'verification'],
      triggeredBy: 'verify-e2e script',
      sdkVersion: '0.1.0',
    })

    if (!r.ok) {
      const detail = r.status === 401
        ? 'Unauthorized — set AFR_API_KEY to a valid key'
        : `HTTP ${r.status}: ${JSON.stringify(r.body)}`
      record('POST /api/runs succeeds', false, detail)
      return null
    }

    const body = r.body as { run?: { id?: string } }
    const runId = body?.run?.id
    if (!runId) {
      record('POST /api/runs returns a run.id', false, `unexpected body: ${JSON.stringify(body)}`)
      return null
    }

    record('POST /api/runs succeeds', true, `runId=${runId}`)
    record('Response contains run.id', true, runId)
    return runId
  } catch (err) {
    record('POST /api/runs succeeds', false, String(err))
    return null
  }
}

async function step3_recordEvents(runId: string): Promise<string[]> {
  header('Step 3: Record events via POST /api/events')

  const events = [
    { type: 'RUN_STARTED',   sequenceNumber: 1, payload: { source: 'verify-e2e' } },
    { type: 'LLM_REQUEST',   sequenceNumber: 2, payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Ping' }] } },
    { type: 'LLM_RESPONSE',  sequenceNumber: 3, payload: { model: 'gpt-4o', content: 'Pong', usage: { promptTokens: 5, completionTokens: 2 } } },
    { type: 'RUN_COMPLETED', sequenceNumber: 4, payload: { duration_ms: 42 } },
  ]

  const eventIds: string[] = []

  for (const evt of events) {
    info(`POST /api/events  type=${evt.type}`)
    try {
      const r = await post('/api/events', {
        runId,
        ...evt,
        timestamp: Date.now(),
      })

      if (!r.ok) {
        record(`Record ${evt.type}`, false, `HTTP ${r.status}: ${JSON.stringify(r.body)}`)
        continue
      }

      const body = r.body as { eventId?: string; event?: { id?: string }; id?: string }
      const eventId = body?.eventId ?? body?.event?.id ?? body?.id ?? ''
      record(`Record ${evt.type}`, true, eventId ? `eventId=${eventId}` : 'no eventId in response')
      if (eventId) eventIds.push(eventId)
    } catch (err) {
      record(`Record ${evt.type}`, false, String(err))
    }
  }

  return eventIds
}

async function step4_completeRun(runId: string): Promise<boolean> {
  header('Step 4: Complete run via PATCH /api/runs/:id/status')
  info(`PATCH ${BASE_URL}/api/runs/${runId}/status`)

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (API_KEY) headers['x-api-key'] = API_KEY

    const response = await fetch(`${BASE_URL}/api/runs/${runId}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'completed', endedAt: Date.now() }),
    })

    const passed = response.ok
    record(
      'PATCH /api/runs/:id/status succeeds',
      passed,
      passed ? `HTTP ${response.status}` : `HTTP ${response.status}`
    )
    return passed
  } catch (err) {
    record('PATCH /api/runs/:id/status succeeds', false, String(err))
    return false
  }
}

async function step5_listEvents(runId: string): Promise<void> {
  header('Step 5: List events via GET /api/runs/:id/events')
  info(`GET ${BASE_URL}/api/runs/${runId}/events`)

  try {
    const r = await get(`/api/runs/${runId}/events`)

    if (!r.ok) {
      if (r.status === 401) {
        record(
          'GET /api/runs/:id/events returns events',
          false,
          'Unauthorized — endpoint requires Clerk auth (expected in production)'
        )
      } else if (r.status === 404) {
        record('GET /api/runs/:id/events returns events', false, 'Run not found (route may not be implemented yet)')
      } else {
        record('GET /api/runs/:id/events returns events', false, `HTTP ${r.status}`)
      }
      return
    }

    const body = r.body as { events?: unknown[] }
    const events = body?.events
    if (Array.isArray(events)) {
      record('GET /api/runs/:id/events returns events', true, `count=${events.length}`)
    } else {
      record('GET /api/runs/:id/events returns events', false, `unexpected body: ${JSON.stringify(body)}`)
    }
  } catch (err) {
    record('GET /api/runs/:id/events returns events', false, String(err))
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(): void {
  header('Summary')
  const passed = results.filter(r => r.passed).length
  const total  = results.length
  const allPass = passed === total

  console.log()
  for (const r of results) {
    const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    console.log(`  ${icon}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
  }

  console.log()
  if (allPass) {
    console.log(`${GREEN}${BOLD}All ${total} checks passed.${RESET}`)
    console.log(`\nRun dashboard: ${BASE_URL}`)
  } else {
    console.log(`${RED}${BOLD}${passed}/${total} checks passed.${RESET}`)
    console.log(`\nSome checks failed. Check the output above for details.`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`${BOLD}Agent Flight Recorder — E2E Verification${RESET}`)
  console.log(`Base URL : ${BASE_URL}`)
  console.log(`Agent ID : ${AGENT_ID}`)
  console.log(`API Key  : ${API_KEY ? `${API_KEY.slice(0, 4)}****` : '(none — protected endpoints may fail)'}`)

  const appReachable = await step1_checkAppReachable()
  if (!appReachable) {
    console.log(`\n${RED}App is not reachable at ${BASE_URL}. Aborting further checks.${RESET}`)
    printSummary()
    return
  }

  const runId = await step2_createRun()
  if (!runId) {
    console.log(`\n${YELLOW}Could not create a run. Skipping event and status steps.${RESET}`)
    printSummary()
    return
  }

  await step3_recordEvents(runId)
  await step4_completeRun(runId)
  await step5_listEvents(runId)

  printSummary()
}

main().catch(err => {
  console.error(`${RED}Unhandled error:${RESET}`, err)
  process.exit(1)
})
