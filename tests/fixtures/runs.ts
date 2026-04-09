import type {
  Organization,
  Project,
  Agent,
  AgentVersion,
  Run,
  Event,
  Artifact,
  Comment,
} from '@agent-flight-recorder/contracts'

export const mockOrganization: Organization = {
  id: 'org_acmecorp',
  clerkOrgId: 'org_2abc123def456',
  name: 'Acme Corp',
  slug: 'acme-corp',
  plan: 'pro',
  createdAt: 1712000000000,
  updatedAt: 1712000000000,
}

export const mockProject: Project = {
  id: 'proj_support_bot',
  orgId: 'org_acmecorp',
  name: 'Support Bot',
  slug: 'support-bot',
  description: 'Customer support automation project',
  createdAt: 1712000100000,
  updatedAt: 1712000100000,
}

export const mockAgent: Agent = {
  id: 'agent_support',
  orgId: 'org_acmecorp',
  projectId: 'proj_support_bot',
  name: 'Support Agent',
  slug: 'support-agent',
  description: 'Handles customer support tickets via LLM + tools',
  createdAt: 1712000200000,
  updatedAt: 1712000200000,
}

export const mockAgentVersion: AgentVersion = {
  id: 'ver_1_0_0',
  agentId: 'agent_support',
  orgId: 'org_acmecorp',
  version: '1.0.0',
  changelog: 'Initial release',
  createdAt: 1712000300000,
}

export const mockRun: Run = {
  id: 'run_abc123xyz',
  orgId: 'org_acmecorp',
  projectId: 'proj_support_bot',
  agentId: 'agent_support',
  agentVersionId: 'ver_1_0_0',
  status: 'completed',
  startedAt: 1712500000000,
  endedAt: 1712500045000,
  metadata: { env: 'production', region: 'us-east-1' },
  tags: ['production', 'support'],
  triggeredBy: 'webhook',
  sdkVersion: '0.1.0',
}

export const mockFailedRun: Run = {
  id: 'run_def456uvw',
  orgId: 'org_acmecorp',
  projectId: 'proj_support_bot',
  agentId: 'agent_support',
  agentVersionId: 'ver_1_0_0',
  status: 'failed',
  startedAt: 1712600000000,
  endedAt: 1712600012000,
  metadata: { env: 'production', region: 'us-east-1' },
  tags: ['production', 'support'],
  triggeredBy: 'api',
  sdkVersion: '0.1.0',
}

export const mockPendingRun: Run = {
  id: 'run_ghi789rst',
  orgId: 'org_acmecorp',
  projectId: 'proj_support_bot',
  agentId: 'agent_support',
  status: 'pending',
  startedAt: 1712700000000,
  metadata: {},
  tags: [],
}

export const mockLlmRequestEvent: Event = {
  id: 'evt_llm_req_001',
  runId: 'run_abc123xyz',
  orgId: 'org_acmecorp',
  type: 'llm.request',
  sequenceNumber: 1,
  timestamp: 1712500001000,
  payload: {
    type: 'llm.request',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Help me with my order' }],
    temperature: 0.7,
    max_tokens: 1024,
  },
}

export const mockLlmResponseEvent: Event = {
  id: 'evt_llm_res_002',
  runId: 'run_abc123xyz',
  orgId: 'org_acmecorp',
  type: 'llm.response',
  sequenceNumber: 2,
  timestamp: 1712500002500,
  payload: {
    type: 'llm.response',
    model: 'gpt-4o',
    content: "I'll look up your order right away.",
    usage: {
      prompt_tokens: 38,
      completion_tokens: 12,
      total_tokens: 50,
    },
    finish_reason: 'stop',
  },
}

export const mockToolCallEvent: Event = {
  id: 'evt_tool_call_003',
  runId: 'run_abc123xyz',
  orgId: 'org_acmecorp',
  type: 'tool.call',
  sequenceNumber: 3,
  timestamp: 1712500003000,
  parentEventId: 'evt_llm_res_002',
  payload: {
    type: 'tool.call',
    name: 'lookup_order',
    input: { order_id: '98765' },
    call_id: 'call_abc001',
  },
}

export const mockToolResultEvent: Event = {
  id: 'evt_tool_res_004',
  runId: 'run_abc123xyz',
  orgId: 'org_acmecorp',
  type: 'tool.result',
  sequenceNumber: 4,
  timestamp: 1712500003150,
  parentEventId: 'evt_tool_call_003',
  payload: {
    type: 'tool.result',
    call_id: 'call_abc001',
    output: { order_id: '98765', status: 'shipped', eta: '2024-04-10' },
    duration_ms: 120,
  },
}

export const mockRunStartedEvent: Event = {
  id: 'evt_run_start_000',
  runId: 'run_abc123xyz',
  orgId: 'org_acmecorp',
  type: 'run.started',
  sequenceNumber: 0,
  timestamp: 1712500000050,
  payload: {
    type: 'run.started',
    input: { query: 'Help me with my order' },
    config: { env: 'production' },
  },
}

export const mockRunCompletedEvent: Event = {
  id: 'evt_run_done_005',
  runId: 'run_abc123xyz',
  orgId: 'org_acmecorp',
  type: 'run.completed',
  sequenceNumber: 5,
  timestamp: 1712500045000,
  payload: {
    type: 'run.completed',
    output: { reply: 'Your order has shipped and arrives April 10th.' },
    duration_ms: 44950,
  },
}

export const mockArtifact: Artifact = {
  id: 'art_001',
  runId: 'run_abc123xyz',
  orgId: 'org_acmecorp',
  name: 'execution-trace.json',
  mimeType: 'application/json',
  size: 4096,
  storageKey: 'orgs/acme-corp/runs/run_abc123xyz/execution-trace.json',
  storageBucket: 'afr-artifacts',
  checksum: 'sha256:abc123def456',
  createdAt: 1712500046000,
}

export const mockComment: Comment = {
  id: 'cmt_001xyz',
  orgId: 'org_acmecorp',
  targetId: 'run_abc123xyz',
  targetType: 'run',
  authorId: 'user_reviewer_01',
  content: 'The LLM response latency here looks high — worth investigating the prompt size.',
  createdAt: 1712510000000,
  updatedAt: 1712510300000,
}

export const mockEventComment: Comment = {
  id: 'cmt_002uvw',
  orgId: 'org_acmecorp',
  targetId: 'evt_llm_req_001',
  targetType: 'event',
  authorId: 'user_reviewer_01',
  content: 'Temperature 0.7 seems high for a deterministic lookup task.',
  createdAt: 1712511000000,
}

/** All events for mockRun in sequence order */
export const mockRunEvents: Event[] = [
  mockRunStartedEvent,
  mockLlmRequestEvent,
  mockLlmResponseEvent,
  mockToolCallEvent,
  mockToolResultEvent,
  mockRunCompletedEvent,
]
