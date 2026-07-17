export interface Organization {
  id: string;
  clerkOrgId: string;
  name: string;
  slug: string;
  plan: "free" | "pro" | "enterprise";
  createdAt: number;
  updatedAt: number;
  /**
   * Optional retention window in days (ADR 001). When set, terminal runs older
   * than the window are deleted by the daily retention cron. Unset = retain
   * forever.
   */
  retentionDays?: number;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Agent {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  slug: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  orgId: string;
  /** Semver string, e.g. "1.2.3" */
  version: string;
  changelog?: string;
  configSnapshot?: Record<string, unknown>;
  createdAt: number;
}

export interface Run {
  id: string;
  orgId: string;
  projectId: string;
  agentId: string;
  agentVersionId?: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  metadata: Record<string, unknown>;
  tags: string[];
  triggeredBy?: string;
  sdkVersion?: string;
}

export interface Event {
  id: string;
  runId: string;
  orgId: string;
  type: EventType;
  sequenceNumber: number;
  timestamp: number;
  payload: EventPayload;
  parentEventId?: string;
}

export interface Artifact {
  id: string;
  runId: string;
  orgId: string;
  eventId?: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  storageBucket: string;
  checksum: string;
  createdAt: number;
}

export interface Comment {
  id: string;
  orgId: string;
  targetId: string;
  targetType: "run" | "event";
  authorId: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

// Forward references resolved by importing from events.ts and status.ts
import type { EventType, EventPayload } from "./events.js";
import type { RunStatus } from "./status.js";
