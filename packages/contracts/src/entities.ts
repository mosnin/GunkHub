import type { EventPayload } from "./events.js";

/**
 * Branded Id type for type-safe entity references.
 * Prevents mixing up ids of different entity types at compile time.
 */
export type Id<T extends string> = string & { readonly __brand: T };

/** Organization plan tier */
export type OrgPlan = "free" | "pro" | "enterprise";

/** An Organization is the top-level tenancy boundary. All data is scoped to an org. */
export interface Organization {
  readonly id: Id<"Organization">;
  readonly name: string;
  readonly slug: string;
  readonly clerkOrgId: string;
  readonly plan: OrgPlan;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Role of a user within an organization */
export type UserRole = "owner" | "admin" | "member";

/** A User is a member of an Organization, authenticated via Clerk. */
export interface User {
  readonly id: Id<"User">;
  readonly orgId: Id<"Organization">;
  readonly clerkUserId: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly role: UserRole;
  readonly createdAt: number;
}

/** A Project groups Agents within an Organization. */
export interface Project {
  readonly id: Id<"Project">;
  readonly orgId: Id<"Organization">;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** An Agent is a named AI agent within a Project. */
export interface Agent {
  readonly id: Id<"Agent">;
  readonly projectId: Id<"Project">;
  readonly orgId: Id<"Organization">;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** An AgentVersion captures a snapshot of an Agent's configuration/metadata at a point in time. */
export interface AgentVersion {
  readonly id: Id<"AgentVersion">;
  readonly agentId: Id<"Agent">;
  readonly orgId: Id<"Organization">;
  readonly version: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
}

/** Lifecycle status of a Run */
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** A Run represents a single execution of an Agent. */
export interface Run {
  readonly id: Id<"Run">;
  readonly agentId: Id<"Agent">;
  readonly agentVersionId?: Id<"AgentVersion">;
  readonly projectId: Id<"Project">;
  readonly orgId: Id<"Organization">;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
  readonly metadata: Record<string, unknown>;
  readonly tags: string[];
  readonly errorMessage?: string;
  readonly errorCode?: string;
}

/**
 * An Event is a structured log entry within a Run's event stream.
 *
 * IMMUTABILITY CONTRACT: Events are append-only. Once written, never mutated or deleted.
 */
export interface Event {
  readonly id: Id<"Event">;
  readonly runId: Id<"Run">;
  readonly orgId: Id<"Organization">;
  readonly type: string;
  readonly category: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly payload: EventPayload | null;
  readonly artifactId?: Id<"Artifact">;
  readonly parentEventId?: Id<"Event">;
  readonly metadata: Record<string, unknown>;
}

/**
 * An Artifact is a pointer to a large blob stored externally (e.g., Vercel Blob).
 * The storageKey is an opaque reference to the external blob location.
 */
export interface Artifact {
  readonly id: Id<"Artifact">;
  readonly orgId: Id<"Organization">;
  readonly runId: Id<"Run">;
  readonly eventId?: Id<"Event">;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly createdAt: number;
}

/** A Comment is a user-authored annotation on a Run or specific Event. */
export interface Comment {
  readonly id: Id<"Comment">;
  readonly orgId: Id<"Organization">;
  readonly runId: Id<"Run">;
  readonly eventId?: Id<"Event">;
  readonly authorId: Id<"User">;
  readonly content: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
