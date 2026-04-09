import type {
  ListRunsRequest,
  ListRunsResponse,
  GetRunResponse,
  CreateRunRequest,
  CreateRunResponse,
} from '@agent-flight-recorder/contracts'

/**
 * List runs for the authenticated organization.
 * TODO: Replace with Convex query/mutation call
 */
export async function listRuns(params: ListRunsRequest): Promise<ListRunsResponse> {
  void params
  return {
    runs: [],
    total: 0,
    nextCursor: undefined,
  }
}

/**
 * Get a single run by ID.
 * TODO: Replace with Convex query/mutation call
 */
export async function getRun(id: string): Promise<GetRunResponse> {
  void id
  return {
    run: {
      id,
      orgId: '',
      projectId: '',
      agentId: '',
      status: 'pending',
      startedAt: Date.now(),
      metadata: {},
      tags: [],
    },
    eventCount: 0,
    artifactCount: 0,
  }
}

/**
 * Create a new run.
 * TODO: Replace with Convex query/mutation call
 */
export async function createRun(req: CreateRunRequest): Promise<CreateRunResponse> {
  void req
  return {
    run: {
      id: `run_${Date.now()}`,
      orgId: '',
      projectId: '',
      agentId: req.agentId,
      agentVersionId: req.agentVersionId,
      status: 'pending',
      startedAt: Date.now(),
      metadata: req.metadata ?? {},
      tags: req.tags ?? [],
      triggeredBy: req.triggeredBy,
      sdkVersion: req.sdkVersion,
    },
  }
}
