// ADR-002 — approximate usage metering (usage_counters) and the daily
// rollup projection (daily_rollups). Neither is an exact audit trail —
// events/audit_log remain authoritative for anything that needs to be exact.

export interface UsageCounter {
  id: string;
  orgId: string;
  /** "YYYY-MM-DD", UTC. */
  day: string;
  runsStarted: number;
  eventsIngested: number;
  bytesIngested: number;
  artifactBytes: number;
}

export interface DailyRollup {
  id: string;
  orgId: string;
  agentId: string;
  /** "YYYY-MM-DD", UTC. */
  date: string;
  runsTotal: number;
  runsFailed: number;
  runsCompleted: number;
  runsCancelled: number;
  runsTimedOut: number;
  durationMsP50?: number;
  durationMsP95?: number;
  tokensIn: number;
  tokensOut: number;
}
