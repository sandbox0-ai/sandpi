import { NextResponse } from "next/server";

import {
  createMockEnvironment,
  mockEnvironments,
  mockTeamMemberships,
  mockTeams,
  mockViewer,
} from "@/lib/mock-data";

interface CreateEnvironmentRequest {
  teamId?: string;
  name?: string;
}

export async function GET() {
  return NextResponse.json({ data: structuredClone(mockEnvironments) });
}

export async function POST(request: Request) {
  const body = (await request.json()) as CreateEnvironmentRequest;
  const name = body.name?.trim();
  const team = mockTeams.find((item) => item.id === body.teamId);

  if (!team) {
    return NextResponse.json(
      { error: { code: "team_not_found", message: "Team not found." } },
      { status: 404 },
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

  if (!name) {
    return NextResponse.json(
      { error: { code: "name_required", message: "Give the Environment a name." } },
      { status: 400 },
    );
  }

  const environment = createMockEnvironment({
    teamId: team.id,
    name,
  });

  return NextResponse.json(
    { data: environment, meta: { mode: "mock", codingAgentMutable: false } },
    { status: 201 },
  );
}
