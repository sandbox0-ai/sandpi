import { NextResponse } from "next/server";

import { mockSessions } from "@/lib/mock-data";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  const session = mockSessions.find((item) => item.id === sessionId);

  if (!session) {
    return NextResponse.json(
      { error: { code: "session_not_found", message: "Session not found." } },
      { status: 404 },
    );
  }

  return NextResponse.json({
    data: session.auditEvents,
    meta: {
      mode: "mock",
      recovery: { cursor: session.auditEvents[0]?.id, transport: "sse" },
    },
  });
}
