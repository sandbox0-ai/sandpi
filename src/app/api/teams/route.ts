import { NextResponse } from "next/server";

import {
  mockSandpiPlans,
  mockTeamMemberships,
  mockTeams,
  mockViewer,
} from "@/lib/mock-data";

export async function GET() {
  const viewerMemberships = mockTeamMemberships.filter(
    (membership) => membership.user.id === mockViewer.id,
  );
  const viewerTeamIds = new Set(
    viewerMemberships.map((membership) => membership.teamId),
  );
  return NextResponse.json({
    data: {
      teams: structuredClone(
        mockTeams.filter((team) => viewerTeamIds.has(team.id)),
      ),
      viewerMemberships: structuredClone(viewerMemberships),
      plans: structuredClone(mockSandpiPlans),
    },
    meta: {
      mode: "mock",
      viewerId: mockViewer.id,
      ownership: "sandpi",
    },
  });
}
