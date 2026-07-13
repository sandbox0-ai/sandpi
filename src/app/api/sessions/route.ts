import { NextResponse } from "next/server";

import { buildSessionForkPlan } from "@/lib/environment-blueprint";
import {
  createMockSession,
  mockEnvironments,
  mockSessions,
  mockTeams,
} from "@/lib/mock-data";
import { canStartTeamExecution } from "@/lib/team";

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
 * Production checks the Team's Sandpi subscription and weekly execution allowance before
 * provisioning the first Turn. The allowance covers Sandpi-managed runtime only; model access
 * and model usage continue to come from the user's native coding-agent account.
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

  const team = mockTeams.find((item) => item.id === environment.teamId);
  if (!team) {
    return NextResponse.json(
      { error: { code: "team_not_found", message: "Environment Team not found." } },
      { status: 409 },
    );
  }
  if (!canStartTeamExecution(team.subscription)) {
    return NextResponse.json(
      {
        error: {
          code: "team_quota_exhausted",
          message: "The Team cannot start more execution in this quota window.",
        },
      },
      { status: 429 },
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
        teamId: team.id,
        quota: {
          status: "admitted",
          kind: "weekly_execution_minutes",
          resetsAt: team.subscription.quotas.weeklyExecution.resetsAt,
        },
        provisioningPlan: plan,
      },
    },
    { status: 201 },
  );
}
