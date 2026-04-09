import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type {
  IngestEventsRequest,
  IngestEventsResponse,
  ApiError,
} from "@afr/contracts";

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

  const data = body as Partial<IngestEventsRequest>;

  if (!data.runId) {
    return NextResponse.json<ApiError>(
      { error: "Missing required field: runId", code: "MISSING_FIELD" },
      { status: 400 }
    );
  }

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
          details: event,
        },
        { status: 400 }
      );
    }
  }

  // TODO: call Convex mutation to batch ingest events
  // const result = await convex.mutation(api.events.batchIngest, {
  //   runId: data.runId,
  //   orgId,
  //   events: data.events,
  // });

  const response: IngestEventsResponse = {
    accepted: data.events.length,
    runId: data.runId,
  };

  return NextResponse.json(response, { status: 202 });
}
