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

  const status =
    session.status === "completed"
      ? "closed"
      : session.status === "paused"
        ? "paused"
        : "ready";

  return NextResponse.json(
    {
      data: {
        id: `terminal-${session.id}`,
        codingSessionId: session.id,
        status,
        sandbox: {
          id: session.sandboxId,
          status: session.status === "completed" ? "offline" : "ready",
        },
        supervisor: {
          sessionId: session.supervisorSessionId,
          status:
            session.status === "completed"
              ? "ended"
              : session.status === "paused"
                ? "paused"
                : session.status === "waiting"
                  ? "waiting"
                  : "connected",
        },
        shell: {
          name: "bash",
          path: "/bin/bash",
          cwd: "/workspace",
          cols: 120,
          rows: 28,
        },
        transport: {
          kind: "mock",
          protocol: "local-command-response",
          connectUrl: null,
          reconnectable: false,
        },
        capabilities: {
          input: true,
          resize: true,
          reconnect: false,
        },
      },
      meta: {
        mode: "mock",
        note: "Commands and output are simulated in the client; no PTY is attached.",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
