import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TeamSettingsPage } from "@/components/team-settings-page";
import {
  mockEnvironments,
  mockSandpiPlans,
  mockTeamMemberships,
  mockTeams,
  mockViewer,
} from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Team settings · Sandpi",
  description: "Manage a Sandpi Team, member Plans, billing and usage.",
};

interface TeamSettingsRouteProps {
  searchParams: Promise<{ team?: string }>;
}

export default async function TeamSettingsRoute({
  searchParams,
}: TeamSettingsRouteProps) {
  const { team: requestedTeamId } = await searchParams;
  const team =
    mockTeams.find((candidate) => candidate.id === requestedTeamId) ?? mockTeams[0];
  if (!team) {
    notFound();
  }
  const memberships = mockTeamMemberships.filter(
    (membership) => membership.teamId === team.id,
  );
  if (
    !memberships.some(
      (membership) =>
        membership.user.id === mockViewer.id && membership.status === "active",
    )
  ) {
    notFound();
  }

  return (
    <TeamSettingsPage
      team={structuredClone(team)}
      viewer={structuredClone(mockViewer)}
      memberships={structuredClone(memberships)}
      plans={structuredClone(mockSandpiPlans)}
      environmentCount={mockEnvironments.filter(
        (environment) => environment.teamId === team.id,
      ).length}
    />
  );
}
