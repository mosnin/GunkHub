#!/usr/bin/env tsx
/**
 * rebuild-projection.ts
 *
 * Verifies a run's projection from its canonical events.
 * This script does NOT materialize projections — it fetches events (from
 * a fixture or a JSON file), runs verification, and reports the result.
 *
 * Usage:
 *   pnpm tsx scripts/rebuild-projection.ts --demo
 *   pnpm tsx scripts/rebuild-projection.ts --events-file ./export.json
 *
 * Output:
 *   ✓ Run verify-demo-001: 5 events, no gaps, projection valid
 *   Frames: 5, Duration: 4000ms, isComplete: true, isFailed: false
 *
 * For real runs: export events from the Convex dashboard as JSON and pass
 * them via --events-file. The JSON file must contain:
 *   { "run": <Run object>, "events": <Event[]> }
 *
 * The "rebuild" operation is purely computational — it re-runs the pure
 * projection function on the canonical events. There is no stored state to
 * invalidate. See ADR-0008.
 */

import { readFileSync } from "fs";
import { verifyProjectionIntegrity } from "../apps/web/src/lib/replay/verify.js";
import { successfulRun, successfulRunEvents } from "../tests/fixtures/events.js";
import type { Event, Run } from "@agent-flight-recorder/contracts";

// ---------------------------------------------------------------------------
// ANSI colour helpers (no third-party deps)
// ---------------------------------------------------------------------------

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";

function ok(msg: string):     void { console.log(`${GREEN}  ✓${RESET}  ${msg}`); }
function fail(msg: string):   void { console.log(`${RED}  ✗${RESET}  ${msg}`); }
function info(msg: string):   void { console.log(`${YELLOW}  →${RESET}  ${msg}`); }
function detail(msg: string): void { console.log(`${DIM}     ${msg}${RESET}`); }
function header(msg: string): void { console.log(`\n${BOLD}${msg}${RESET}`); }

// ---------------------------------------------------------------------------
// CLI flag parsing (no external deps)
// ---------------------------------------------------------------------------

interface CliArgs {
  demo: boolean;
  eventsFile: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { demo: false, eventsFile: null };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--demo") {
      args.demo = true;
    } else if (arg === "--events-file") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`${RED}Error: --events-file requires a path argument${RESET}`);
        process.exit(1);
      }
      args.eventsFile = next;
      i++; // consume the next token
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Load events from a JSON file
// ---------------------------------------------------------------------------

interface EventsFileShape {
  run: Run;
  events: Event[];
}

function loadEventsFile(filePath: string): EventsFileShape {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`${RED}Error reading file "${filePath}": ${String(err)}${RESET}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`${RED}Error parsing JSON in "${filePath}": ${String(err)}${RESET}`);
    process.exit(1);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("run" in parsed) ||
    !("events" in parsed)
  ) {
    console.error(
      `${RED}Invalid file format. Expected { "run": <Run>, "events": <Event[]> }${RESET}`
    );
    process.exit(1);
  }

  return parsed as EventsFileShape;
}

// ---------------------------------------------------------------------------
// Print a formatted verification report
// ---------------------------------------------------------------------------

function printReport(runLabel: string, run: Run, events: Event[]): boolean {
  info(`Verifying run "${runLabel}" (${events.length} events) …`);

  const result = verifyProjectionIntegrity(run, events);

  if (result.isValid) {
    ok(`Run ${runLabel}: ${result.summary}`);
  } else {
    fail(`Run ${runLabel}: ${result.summary}`);
  }

  if (result.projection !== null) {
    const p = result.projection;
    detail(
      `Frames: ${p.frames.length}, Duration: ${p.duration_ms}ms, isComplete: ${String(p.isComplete)}, isFailed: ${String(p.isFailed)}`
    );
  }

  if (result.failureSummary !== null) {
    const fs = result.failureSummary;
    if (fs.hasFailure) {
      detail(
        `Failure summary: hasFailure=true, primaryFailure=${fs.primaryFailure?.type ?? "none"}`
      );
    }
  }

  if (result.sequenceGaps.length > 0) {
    detail(`Sequence gaps: [${result.sequenceGaps.join(", ")}]`);
  }

  if (result.duplicateSequenceNumbers.length > 0) {
    detail(`Duplicate sequence numbers: [${result.duplicateSequenceNumbers.join(", ")}]`);
  }

  for (const err of result.errors) {
    detail(`Error: ${err}`);
  }

  return result.isValid;
}

// ---------------------------------------------------------------------------
// Built-in demo fixture (demonstrates the rebuild pattern without a live Convex)
// ---------------------------------------------------------------------------

function runDemo(): boolean {
  header("Demo mode — running on built-in fixture data");

  // Use the successfulRun fixture from tests/fixtures/events.ts.
  // This is the canonical demo dataset: 6 contiguous events, fully valid.
  const demoRun: Run = {
    ...successfulRun,
    id: "verify-demo-001",
  };

  const demoEvents: Event[] = successfulRunEvents.map((e) => ({
    ...e,
    runId: "verify-demo-001",
  }));

  return printReport("verify-demo-001", demoRun, demoEvents);
}

// ---------------------------------------------------------------------------
// File-based run (reads events exported from Convex dashboard)
// ---------------------------------------------------------------------------

function runFromFile(filePath: string): boolean {
  header(`File mode — loading events from "${filePath}"`);
  const { run, events } = loadEventsFile(filePath);
  const label = run.id;
  return printReport(label, run, events);
}

// ---------------------------------------------------------------------------
// Usage help
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
${BOLD}Agent Flight Recorder — Projection Rebuild / Verify Tool${RESET}

Usage:
  pnpm tsx scripts/rebuild-projection.ts --demo
  pnpm tsx scripts/rebuild-projection.ts --events-file <path>

Flags:
  --demo              Run on built-in fixture data (no Convex connection needed)
  --events-file PATH  Read run + events from a JSON file exported from Convex

File format for --events-file:
  {
    "run":    { <Run object> },
    "events": [ <Event[]> ]
  }

Semantics:
  "Rebuilding" a projection means re-running the pure buildReplayProjection()
  function on the canonical event log. There is no stored projection to
  invalidate. See ADR-0008 for the full rationale.

Exit codes:
  0  All checks passed (projection is valid)
  1  Verification failed or an error occurred
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv);

  console.log(`${BOLD}Agent Flight Recorder — Projection Rebuild Tool${RESET}`);

  if (!args.demo && args.eventsFile === null) {
    printUsage();
    process.exit(1);
  }

  let passed = false;

  if (args.demo) {
    passed = runDemo();
  } else if (args.eventsFile !== null) {
    passed = runFromFile(args.eventsFile);
  }

  console.log();
  if (passed) {
    console.log(`${GREEN}${BOLD}Projection integrity verified.${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}Projection integrity check failed.${RESET}`);
    process.exit(1);
  }
}

main();
