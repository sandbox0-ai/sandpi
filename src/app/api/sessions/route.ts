import { NextResponse } from "next/server";

import { buildSessionForkPlan } from "@/lib/environment-blueprint";
import { createMockSession, mockEnvironments, mockSessions } from "@/lib/mock-data";

interface CreateSessionRequest {
  environmentId?: string;
  title?: string;
  prompt?: string;
  modelId?: string;
}

export async function GET() {
  return NextResponse.json({ data: structuredClone(mockSessions) });
}

/**
 * The MVP is a free public beta, so Session creation has no Sandpi subscription, price or
 * allowance gate. A future managed-runtime entitlement may protect Sandbox0 resources here,
 * but model access and model usage must continue to come directly from the user's native
 * coding-agent account rather than a Sandpi plan.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as CreateSessionRequest;
  const environment = mockEnvironments.find((item) => item.id === body.environmentId);

  if (!environment) {
    return NextResponse.json(
      { error: { code: "environment_not_found", message: "Environment not found." } },
      { status: 404 },
    );
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json(
      { error: { code: "prompt_required", message: "A starting prompt is required." } },
      { status: 400 },
    );
  }

  const title = body.title?.trim() || prompt.slice(0, 56);
  const session = createMockSession(environment, {
    title,
    prompt,
    modelId: body.modelId,
  });
  const plan = buildSessionForkPlan({
    environment,
    sessionName: title,
  });

  return NextResponse.json(
    {
      data: session,
      meta: {
        mode: "mock",
        codingAgent: environment.codingAgent.harness,
        codingAgentMutable: false,
        nativeProtocol: "codex-app-server-v2",
        provisioningPlan: plan,
      },
    },
    { status: 201 },
  );
}
