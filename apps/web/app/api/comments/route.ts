import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type {
  CreateCommentRequest,
  CreateCommentResponse,
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

  const data = body as Partial<CreateCommentRequest>;

  if (!data.runId) {
    return NextResponse.json<ApiError>(
      { error: "Missing required field: runId", code: "MISSING_FIELD" },
      { status: 400 }
    );
  }

  if (!data.content || data.content.trim().length === 0) {
    return NextResponse.json<ApiError>(
      { error: "Missing required field: content", code: "MISSING_FIELD" },
      { status: 400 }
    );
  }

  if (data.content.length > 10000) {
    return NextResponse.json<ApiError>(
      { error: "Comment content too long (max 10000 chars)", code: "CONTENT_TOO_LONG" },
      { status: 400 }
    );
  }

  // TODO: call Convex mutation to create comment
  // const comment = await convex.mutation(api.comments.create, {
  //   runId: data.runId,
  //   eventId: data.eventId,
  //   content: data.content,
  //   orgId,
  //   authorId: userId,
  // });

  // Stub response — real implementation replaces this
  const now = Date.now();
  const stubComment = {
    id: `comment_${now}_${Math.random().toString(36).slice(2, 9)}` as `${string}`,
    orgId: orgId as `${string}`,
    runId: data.runId as `${string}`,
    eventId: data.eventId as `${string}` | undefined,
    authorId: userId as `${string}`,
    content: data.content,
    createdAt: now,
    updatedAt: now,
  };

  const response: CreateCommentResponse = {
    comment: stubComment as CreateCommentResponse["comment"],
  };

  return NextResponse.json(response, { status: 201 });
}
