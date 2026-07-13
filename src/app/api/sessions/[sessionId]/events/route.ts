import { NextResponse } from "next/server";

import { nativeEventsForSession } from "@/harnesses/registry";
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

  const events = nativeEventsForSession(session);
  return NextResponse.json({
    data: events,
    meta: {
      mode: "mock",
      harness: session.harness,
      nativeProtocol: session.harnessState.protocol,
      recovery: {
        cursor: events.at(-1)?.sequence ?? 0,
        transport: "sse",
      },
    },
  });
}
