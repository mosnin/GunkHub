import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type {
  ListEventsResponse,
  IngestEventsRequest,
  IngestEventsResponse,
  ApiError,
} from "@afr/contracts";

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

  const { id: runId } = await params;
  const { searchParams } = new URL(request.url);
  const _cursor = searchParams.get("cursor");
  const _limit = searchParams.get("limit");

  // TODO: call Convex query to list events for this run
  // const events = await convex.query(api.events.listByRun, { runId, orgId, cursor, limit });

  const response: ListEventsResponse = {
    events: [],
    nextCursor: undefined,
    hasMore: false,
  };

  return NextResponse.json(response);
}

export async function POST(
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

  const { id: runId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiError>(
      { error: "Invalid JSON body", code: "INVALID_BODY" },
      { status: 400 }
    );
  }

  const data = body as Partial<IngestEventsRequest>;

  if (!data.events || !Array.isArray(data.events)) {
    return NextResponse.json<ApiError>(
      { error: "Missing required field: events (array)", code: "MISSING_FIELD" },
      { status: 400 }
    );
  }

  for (const event of data.events) {
    if (!event.type || !event.category || event.sequence === undefined || event.timestamp === undefined) {
      return NextResponse.json<ApiError>(
        {
          error: "Each event must have: type, category, sequence, timestamp",
          code: "INVALID_EVENT",
        },
        { status: 400 }
      );
    }
  }

  // TODO: call Convex mutation to ingest events
  // const result = await convex.mutation(api.events.ingest, { runId, orgId, events: data.events });

  const response: IngestEventsResponse = {
    accepted: data.events.length,
    runId,
  };

  return NextResponse.json(response, { status: 202 });
}
