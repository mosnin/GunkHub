import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type { GetRunResponse, ApiError } from "@afr/contracts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { userId, orgId } = await auth();

  if (!userId || !orgId) {
    return NextResponse.json<ApiError>(
      { error: "Unauthorized", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  const { id } = await params;

  if (!id) {
    return NextResponse.json<ApiError>(
      { error: "Missing run ID", code: "MISSING_PARAM" },
      { status: 400 }
    );
  }

  // TODO: call Convex query to fetch run by id and orgId
  // const run = await convex.query(api.runs.getById, { id, orgId });

  // Stub: return 404 since no real data source yet
  return NextResponse.json<ApiError>(
    { error: "Run not found", code: "NOT_FOUND" },
    { status: 404 }
  );

  // When real data is available, return:
  // const response: GetRunResponse = { run, eventCount };
  // return NextResponse.json(response);
}
