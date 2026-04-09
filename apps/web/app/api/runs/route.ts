import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type {
  CreateRunRequest,
  CreateRunResponse,
  ListRunsResponse,
  ApiError,
} from "@afr/contracts";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { userId, orgId } = await auth();

  if (!userId || !orgId) {
    return NextResponse.json<ApiError>(
      { error: "Unauthorized", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  // TODO: call Convex query to list runs for orgId
  // const runs = await convex.query(api.runs.list, { orgId, ...filters });

  const { searchParams } = new URL(request.url);
  const _status = searchParams.get("status");
  const _agentId = searchParams.get("agentId");
  const _projectId = searchParams.get("projectId");
  const _cursor = searchParams.get("cursor");

  const response: ListRunsResponse = {
    runs: [],
    nextCursor: undefined,
    total: 0,
  };

  return NextResponse.json(response);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { userId, orgId } = await auth();

  if (!userId || !orgId) {
    return NextResponse.json<ApiError>(
      { error: "Unauthorized", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiError>(
      { error: "Invalid JSON body", code: "INVALID_BODY" },
      { status: 400 }
    );
  }

  const data = body as Partial<CreateRunRequest>;

  if (!data.agentId) {
    return NextResponse.json<ApiError>(
      { error: "Missing required field: agentId", code: "MISSING_FIELD" },
      { status: 400 }
    );
  }

  if (!data.projectId) {
    return NextResponse.json<ApiError>(
      { error: "Missing required field: projectId", code: "MISSING_FIELD" },
      { status: 400 }
    );
  }

  // TODO: call Convex mutation to create a run
  // const runId = await convex.mutation(api.runs.create, { orgId, ...data });

  const stubRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const response: CreateRunResponse = {
    runId: stubRunId,
  };

  return NextResponse.json(response, { status: 201 });
}
