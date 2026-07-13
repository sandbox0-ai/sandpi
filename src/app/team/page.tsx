import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TeamSettingsPage } from "@/components/team-settings-page";
import {
  mockEnvironments,
  mockTeamMembers,
  mockTeams,
  mockViewer,
} from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Team settings · Sandpi",
  description: "Manage a Sandpi Team, members, subscription and usage.",
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

  return (
    <TeamSettingsPage
      team={structuredClone(team)}
      viewer={structuredClone(mockViewer)}
      members={structuredClone(
        mockTeamMembers.filter((member) => member.teamId === team.id),
      )}
      environmentCount={mockEnvironments.filter(
        (environment) => environment.teamId === team.id,
      ).length}
    />
  );
}
