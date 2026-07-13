import { NextResponse } from "next/server";

import { buildSessionForkPlan } from "@/lib/environment-blueprint";
import {
  createMockSession,
  mockEnvironments,
  mockSessions,
  mockTeamMemberships,
  mockTeams,
  mockViewer,
} from "@/lib/mock-data";
import { canStartMembershipExecution } from "@/lib/team";

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
 * Production admits the first Turn against the acting Team Membership's Plan assignment while
 * the Team remains the payer and resource owner. Every later Turn writes the same teamId plus
 * its actorMembershipId to Sandpi's usage ledger, outside the native harness event stream.
 * Model access and usage continue to come from the native coding-agent account.
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
  const membership = mockTeamMemberships.find(
    (item) =>
      item.teamId === team.id &&
      item.user.id === mockViewer.id &&
      item.status === "active",
  );
  if (!membership) {
    return NextResponse.json(
      {
        error: {
          code: "team_membership_required",
          message: "An active Team Membership is required.",
        },
      },
      { status: 403 },
    );
  }
  if (!canStartMembershipExecution(membership, team)) {
    return NextResponse.json(
      {
        error: {
          code: "membership_execution_unavailable",
          message:
            "This Team Membership cannot start more execution in the current Plan window.",
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
        billingTeamId: team.id,
        membershipId: membership.id,
        planId: membership.planAssignment.planId,
        quota: {
          status: "admitted",
          kind: "weekly_execution_minutes",
          resetsAt:
            membership.planAssignment.quotas.weeklyExecution.resetsAt,
        },
        provisioningPlan: plan,
      },
    },
    { status: 201 },
  );
}
