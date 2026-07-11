import { NextResponse } from "next/server";

import { createMockEnvironment, mockEnvironments } from "@/lib/mock-data";

interface CreateEnvironmentRequest {
  name?: string;
  repository?: string;
  branch?: string;
  sandbox0ConnectionId?: string;
}

export async function GET() {
  return NextResponse.json({ data: structuredClone(mockEnvironments) });
}

export async function POST(request: Request) {
  const body = (await request.json()) as CreateEnvironmentRequest;
  const name = body.name?.trim();

  if (!name) {
    return NextResponse.json(
      { error: { code: "name_required", message: "Give the Environment a name." } },
      { status: 400 },
    );
  }

  const environment = createMockEnvironment({
    name,
    repository: body.repository?.trim() || "",
    branch: body.branch?.trim() || "main",
    sandbox0ConnectionId:
      body.sandbox0ConnectionId?.trim() || "connection-sandbox0-cloud",
  });

  return NextResponse.json(
    { data: environment, meta: { mode: "mock", codingAgentMutable: false } },
    { status: 201 },
  );
}
