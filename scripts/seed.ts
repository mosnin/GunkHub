/**
 * seed.ts — Local development fixture data for Agent Flight Recorder.
 *
 * This file exports typed mock objects for use in local development, Storybook,
 * and integration test harnesses. It does NOT connect to any database.
 *
 * Usage:
 *   import { seedData } from "./seed";
 */

import type {
  Organization,
  Project,
  Agent,
  AgentVersion,
  Run,
  RunStatus,
  Event,
  EventKind,
  Artifact,
  Comment,
} from "@afr/contracts";

// ── Timestamps ────────────────────────────────────────────────────────────────

const T = (offsetMs: number): number => Date.now() - offsetMs;

// ── Organizations ─────────────────────────────────────────────────────────────

export const organizations: Organization[] = [
  {
    id: "org_acme",
    clerkOrgId: "org_2abc123XYZ",
    name: "Acme AI",
    slug: "acme-ai",
    createdAt: T(30 * 24 * 60 * 60 * 1000),
    updatedAt: T(2 * 24 * 60 * 60 * 1000),
  },
  {
    id: "org_skynet",
    clerkOrgId: "org_2def456ABC",
    name: "Skynet Research",
    slug: "skynet-research",
    createdAt: T(60 * 24 * 60 * 60 * 1000),
    updatedAt: T(5 * 24 * 60 * 60 * 1000),
  },
];

// ── Projects ──────────────────────────────────────────────────────────────────

export const projects: Project[] = [
  {
    id: "proj_acme_cs",
    orgId: "org_acme",
    name: "Customer Support Agent",
    slug: "customer-support",
    description: "Handles tier-1 support tickets via LLM routing and tool use.",
    createdAt: T(25 * 24 * 60 * 60 * 1000),
    updatedAt: T(1 * 24 * 60 * 60 * 1000),
  },
  {
    id: "proj_acme_data",
    orgId: "org_acme",
    name: "Data Pipeline Agent",
    slug: "data-pipeline",
    description: "Extracts, transforms, and loads data from external APIs into the warehouse.",
    createdAt: T(20 * 24 * 60 * 60 * 1000),
    updatedAt: T(3 * 24 * 60 * 60 * 1000),
  },
  {
    id: "proj_skynet_research",
    orgId: "org_skynet",
    name: "Research Summarizer",
    slug: "research-summarizer",
    description: "Fetches arXiv papers and generates structured summaries.",
    createdAt: T(45 * 24 * 60 * 60 * 1000),
    updatedAt: T(6 * 24 * 60 * 60 * 1000),
  },
];

// ── Agents ────────────────────────────────────────────────────────────────────

export const agents: Agent[] = [
  {
    id: "agent_cs_router",
    orgId: "org_acme",
    projectId: "proj_acme_cs",
    name: "SupportRouter",
    description: "Routes incoming tickets to the appropriate specialist agent.",
    createdAt: T(24 * 24 * 60 * 60 * 1000),
    updatedAt: T(2 * 24 * 60 * 60 * 1000),
  },
  {
    id: "agent_cs_resolver",
    orgId: "org_acme",
    projectId: "proj_acme_cs",
    name: "SupportResolver",
    description: "Attempts autonomous resolution of routed tickets.",
    createdAt: T(24 * 24 * 60 * 60 * 1000),
    updatedAt: T(2 * 24 * 60 * 60 * 1000),
  },
  {
    id: "agent_etl",
    orgId: "org_acme",
    projectId: "proj_acme_data",
    name: "ETLOrchestrator",
    description: "Orchestrates multi-step extract-transform-load pipelines.",
    createdAt: T(18 * 24 * 60 * 60 * 1000),
    updatedAt: T(4 * 24 * 60 * 60 * 1000),
  },
  {
    id: "agent_arxiv",
    orgId: "org_skynet",
    projectId: "proj_skynet_research",
    name: "ArxivSummarizer",
    description: "Fetches and summarizes recent machine learning papers.",
    createdAt: T(40 * 24 * 60 * 60 * 1000),
    updatedAt: T(7 * 24 * 60 * 60 * 1000),
  },
];

// ── Agent Versions ────────────────────────────────────────────────────────────

export const agentVersions: AgentVersion[] = [
  {
    id: "av_cs_router_v1",
    agentId: "agent_cs_router",
    orgId: "org_acme",
    version: "1.0.0",
    modelId: "gpt-4o",
    systemPrompt:
      "You are a support routing specialist. Classify the ticket and route to: billing, technical, or general.",
    tools: ["classify_ticket", "route_to_team", "fetch_customer_profile"],
    parameters: { temperature: 0.2, maxTokens: 512 },
    createdAt: T(22 * 24 * 60 * 60 * 1000),
  },
  {
    id: "av_cs_router_v2",
    agentId: "agent_cs_router",
    orgId: "org_acme",
    version: "1.1.0",
    modelId: "gpt-4o",
    systemPrompt:
      "You are a support routing specialist. Classify the ticket and route to: billing, technical, general, or escalation. Always check SLA tier before routing.",
    tools: ["classify_ticket", "route_to_team", "fetch_customer_profile", "check_sla_tier"],
    parameters: { temperature: 0.1, maxTokens: 512 },
    createdAt: T(10 * 24 * 60 * 60 * 1000),
  },
  {
    id: "av_etl_v1",
    agentId: "agent_etl",
    orgId: "org_acme",
    version: "2.3.1",
    modelId: "claude-3-5-sonnet-20241022",
    systemPrompt:
      "You orchestrate data pipelines. Identify source schemas, transform to target schema, validate, and load. Halt on any validation failure.",
    tools: ["fetch_schema", "transform_record", "validate_record", "load_to_warehouse", "send_alert"],
    parameters: { temperature: 0.0, maxTokens: 4096 },
    createdAt: T(14 * 24 * 60 * 60 * 1000),
  },
];

// ── Runs ──────────────────────────────────────────────────────────────────────

export const runs: Run[] = [
  {
    id: "run_001",
    orgId: "org_acme",
    projectId: "proj_acme_cs",
    agentId: "agent_cs_router",
    agentVersionId: "av_cs_router_v2",
    status: "completed" as RunStatus,
    triggeredBy: "user_clerk_abc123",
    triggerKind: "manual",
    input: {
      ticketId: "TKT-9821",
      subject: "Cannot log into my account after password reset",
      body: "I reset my password but still cannot log in. I keep getting error code AUTH-403.",
      customerId: "cust_44521",
    },
    output: {
      routing: "technical",
      confidence: 0.97,
      assignedQueue: "auth-team",
      slaHours: 4,
    },
    durationMs: 3_240,
    eventCount: 12,
    startedAt: T(2 * 60 * 60 * 1000),
    completedAt: T(2 * 60 * 60 * 1000 - 3_240),
    createdAt: T(2 * 60 * 60 * 1000),
    updatedAt: T(2 * 60 * 60 * 1000 - 3_240),
    metadata: { environment: "production", region: "us-east-1" },
  },
  {
    id: "run_002",
    orgId: "org_acme",
    projectId: "proj_acme_data",
    agentId: "agent_etl",
    agentVersionId: "av_etl_v1",
    status: "failed" as RunStatus,
    triggeredBy: "scheduler",
    triggerKind: "scheduled",
    input: {
      source: "salesforce",
      targetTable: "dim_accounts",
      batchSize: 500,
      dateRange: { from: "2026-04-08", to: "2026-04-09" },
    },
    output: null,
    durationMs: 42_100,
    eventCount: 31,
    startedAt: T(6 * 60 * 60 * 1000),
    completedAt: T(6 * 60 * 60 * 1000 - 42_100),
    createdAt: T(6 * 60 * 60 * 1000),
    updatedAt: T(6 * 60 * 60 * 1000 - 42_100),
    error: {
      code: "SCHEMA_MISMATCH",
      message:
        "Field 'annual_revenue' expected type number but received string at record index 47.",
      recordIndex: 47,
    },
    metadata: { environment: "production", region: "us-east-1", batchId: "batch_8821" },
  },
  {
    id: "run_003",
    orgId: "org_acme",
    projectId: "proj_acme_cs",
    agentId: "agent_cs_router",
    agentVersionId: "av_cs_router_v1",
    status: "completed" as RunStatus,
    triggeredBy: "user_clerk_abc123",
    triggerKind: "manual",
    input: {
      ticketId: "TKT-9804",
      subject: "Billing charge I don't recognize",
      body: "There is a $49 charge on my card from last month that I did not authorize.",
      customerId: "cust_33901",
    },
    output: {
      routing: "billing",
      confidence: 0.99,
      assignedQueue: "billing-disputes",
      slaHours: 8,
    },
    durationMs: 2_890,
    eventCount: 10,
    startedAt: T(26 * 60 * 60 * 1000),
    completedAt: T(26 * 60 * 60 * 1000 - 2_890),
    createdAt: T(26 * 60 * 60 * 1000),
    updatedAt: T(26 * 60 * 60 * 1000 - 2_890),
    metadata: { environment: "production", region: "us-east-1" },
  },
  {
    id: "run_004",
    orgId: "org_acme",
    projectId: "proj_acme_data",
    agentId: "agent_etl",
    agentVersionId: "av_etl_v1",
    status: "running" as RunStatus,
    triggeredBy: "scheduler",
    triggerKind: "scheduled",
    input: {
      source: "hubspot",
      targetTable: "dim_contacts",
      batchSize: 1000,
      dateRange: { from: "2026-04-09", to: "2026-04-09" },
    },
    output: null,
    durationMs: null,
    eventCount: 8,
    startedAt: T(15 * 60 * 1000),
    completedAt: null,
    createdAt: T(15 * 60 * 1000),
    updatedAt: T(5 * 60 * 1000),
    metadata: { environment: "production", region: "us-east-1", batchId: "batch_8840" },
  },
];

// ── Events ────────────────────────────────────────────────────────────────────

/** Events for run_002 (the failed ETL run — most interesting for debugging) */
export const eventsRun002: Event[] = [
  {
    id: "evt_002_001",
    orgId: "org_acme",
    runId: "run_002",
    seq: 1,
    kind: "run.started" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000),
    payload: {
      input: {
        source: "salesforce",
        targetTable: "dim_accounts",
        batchSize: 500,
        dateRange: { from: "2026-04-08", to: "2026-04-09" },
      },
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: null,
    spanId: "span_root",
    tags: { phase: "init" },
  },
  {
    id: "evt_002_002",
    orgId: "org_acme",
    runId: "run_002",
    seq: 2,
    kind: "llm.request" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 500),
    payload: {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "system", content: "You orchestrate data pipelines..." },
        { role: "user", content: "Fetch the Salesforce account schema for dim_accounts." },
      ],
      tools: ["fetch_schema"],
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 1,
    spanId: "span_llm_01",
    tags: { phase: "schema_fetch" },
  },
  {
    id: "evt_002_003",
    orgId: "org_acme",
    runId: "run_002",
    seq: 3,
    kind: "llm.response" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 2_100),
    payload: {
      model: "claude-3-5-sonnet-20241022",
      usage: { promptTokens: 412, completionTokens: 188 },
      toolCalls: [{ name: "fetch_schema", args: { source: "salesforce", entity: "Account" } }],
      stopReason: "tool_use",
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 2,
    spanId: "span_llm_01",
    tags: { phase: "schema_fetch" },
  },
  {
    id: "evt_002_004",
    orgId: "org_acme",
    runId: "run_002",
    seq: 4,
    kind: "tool.call" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 2_200),
    payload: {
      tool: "fetch_schema",
      args: { source: "salesforce", entity: "Account" },
      callId: "call_abc001",
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 3,
    spanId: "span_tool_01",
    tags: { phase: "schema_fetch", tool: "fetch_schema" },
  },
  {
    id: "evt_002_005",
    orgId: "org_acme",
    runId: "run_002",
    seq: 5,
    kind: "tool.result" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 4_800),
    payload: {
      tool: "fetch_schema",
      callId: "call_abc001",
      result: {
        fields: [
          { name: "Id", type: "string" },
          { name: "Name", type: "string" },
          { name: "AnnualRevenue", type: "currency" },
          { name: "Industry", type: "picklist" },
          { name: "NumberOfEmployees", type: "int" },
        ],
      },
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 4,
    spanId: "span_tool_01",
    tags: { phase: "schema_fetch", tool: "fetch_schema" },
  },
  {
    id: "evt_002_006",
    orgId: "org_acme",
    runId: "run_002",
    seq: 6,
    kind: "llm.request" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 5_000),
    payload: {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "system", content: "You orchestrate data pipelines..." },
        { role: "user", content: "Fetch and transform the first batch of 500 Account records." },
      ],
      tools: ["transform_record", "validate_record"],
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 5,
    spanId: "span_llm_02",
    tags: { phase: "transform" },
  },
  {
    id: "evt_002_007",
    orgId: "org_acme",
    runId: "run_002",
    seq: 7,
    kind: "llm.response" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 8_200),
    payload: {
      model: "claude-3-5-sonnet-20241022",
      usage: { promptTokens: 890, completionTokens: 620 },
      toolCalls: [
        { name: "transform_record", args: { recordIndex: 0, batchId: "batch_8821" } },
      ],
      stopReason: "tool_use",
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 6,
    spanId: "span_llm_02",
    tags: { phase: "transform" },
  },
  {
    id: "evt_002_028",
    orgId: "org_acme",
    runId: "run_002",
    seq: 28,
    kind: "tool.call" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 38_000),
    payload: {
      tool: "validate_record",
      args: { recordIndex: 47, batchId: "batch_8821" },
      callId: "call_abc029",
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 27,
    spanId: "span_tool_28",
    tags: { phase: "validate", tool: "validate_record" },
  },
  {
    id: "evt_002_029",
    orgId: "org_acme",
    runId: "run_002",
    seq: 29,
    kind: "tool.result" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 39_500),
    payload: {
      tool: "validate_record",
      callId: "call_abc029",
      result: {
        valid: false,
        errors: [
          {
            field: "annual_revenue",
            expected: "number",
            received: "string",
            value: "$1,200,000",
          },
        ],
      },
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 28,
    spanId: "span_tool_28",
    tags: { phase: "validate", tool: "validate_record" },
  },
  {
    id: "evt_002_030",
    orgId: "org_acme",
    runId: "run_002",
    seq: 30,
    kind: "run.error" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 40_500),
    payload: {
      code: "SCHEMA_MISMATCH",
      message:
        "Field 'annual_revenue' expected type number but received string at record index 47.",
      recordIndex: 47,
      fatal: true,
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 29,
    spanId: "span_root",
    tags: { phase: "validate", severity: "fatal" },
  },
  {
    id: "evt_002_031",
    orgId: "org_acme",
    runId: "run_002",
    seq: 31,
    kind: "run.finished" as EventKind,
    occurredAt: T(6 * 60 * 60 * 1000 - 42_100),
    payload: {
      status: "failed",
      durationMs: 42_100,
      eventCount: 31,
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 30,
    spanId: "span_root",
    tags: { phase: "teardown" },
  },
];

/** Events for run_001 (the successful routing run) */
export const eventsRun001: Event[] = [
  {
    id: "evt_001_001",
    orgId: "org_acme",
    runId: "run_001",
    seq: 1,
    kind: "run.started" as EventKind,
    occurredAt: T(2 * 60 * 60 * 1000),
    payload: {
      input: {
        ticketId: "TKT-9821",
        subject: "Cannot log into my account after password reset",
        customerId: "cust_44521",
      },
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: null,
    spanId: "span_root",
    tags: { phase: "init" },
  },
  {
    id: "evt_001_002",
    orgId: "org_acme",
    runId: "run_001",
    seq: 2,
    kind: "tool.call" as EventKind,
    occurredAt: T(2 * 60 * 60 * 1000 - 200),
    payload: {
      tool: "fetch_customer_profile",
      args: { customerId: "cust_44521" },
      callId: "call_r1_001",
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 1,
    spanId: "span_tool_01",
    tags: { phase: "enrich", tool: "fetch_customer_profile" },
  },
  {
    id: "evt_001_003",
    orgId: "org_acme",
    runId: "run_001",
    seq: 3,
    kind: "tool.result" as EventKind,
    occurredAt: T(2 * 60 * 60 * 1000 - 850),
    payload: {
      tool: "fetch_customer_profile",
      callId: "call_r1_001",
      result: {
        customerId: "cust_44521",
        plan: "enterprise",
        slaHours: 4,
        accountManager: "jane@acme.ai",
      },
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 2,
    spanId: "span_tool_01",
    tags: { phase: "enrich" },
  },
  {
    id: "evt_001_012",
    orgId: "org_acme",
    runId: "run_001",
    seq: 12,
    kind: "run.finished" as EventKind,
    occurredAt: T(2 * 60 * 60 * 1000 - 3_240),
    payload: {
      status: "completed",
      durationMs: 3_240,
      output: {
        routing: "technical",
        confidence: 0.97,
        assignedQueue: "auth-team",
        slaHours: 4,
      },
    },
    payloadExternalized: false,
    artifactId: null,
    parentSeq: 11,
    spanId: "span_root",
    tags: { phase: "teardown" },
  },
];

// ── Artifacts ─────────────────────────────────────────────────────────────────

export const artifacts: Artifact[] = [
  {
    id: "artifact_001",
    orgId: "org_acme",
    runId: "run_002",
    eventId: "evt_002_007",
    kind: "payload",
    blobUrl:
      "https://example-blob.vercel-storage.com/afr/org_acme/run_002/evt_002_007-payload.json",
    sizeBytes: 42_880,
    contentType: "application/json",
    createdAt: T(6 * 60 * 60 * 1000 - 8_200),
  },
];

// ── Comments ──────────────────────────────────────────────────────────────────

export const comments: Comment[] = [
  {
    id: "comment_001",
    orgId: "org_acme",
    runId: "run_002",
    eventId: "evt_002_030",
    authorId: "user_clerk_abc123",
    body: "Root cause: Salesforce returns AnnualRevenue as a formatted currency string when the field is null-overridden. Need to add a sanitization step in transform_record before validation.",
    createdAt: T(5 * 60 * 60 * 1000),
    updatedAt: T(5 * 60 * 60 * 1000),
    resolved: false,
  },
  {
    id: "comment_002",
    orgId: "org_acme",
    runId: "run_002",
    eventId: null,
    authorId: "user_clerk_xyz789",
    body: "Confirmed in staging. The fix is to coerce currency strings to float in the ETL transform layer. PR incoming.",
    createdAt: T(4 * 60 * 60 * 1000),
    updatedAt: T(4 * 60 * 60 * 1000),
    resolved: false,
  },
];

// ── Aggregate export ──────────────────────────────────────────────────────────

export const seedData = {
  organizations,
  projects,
  agents,
  agentVersions,
  runs,
  events: {
    run_001: eventsRun001,
    run_002: eventsRun002,
  },
  artifacts,
  comments,
} as const;

export type SeedData = typeof seedData;
