import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PreferencesPage } from "@/components/preferences-page";
import {
  mockPreferences,
  mockTeams,
  mockViewer,
} from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Preferences · Sandpi",
  description: "Personal Sandpi preferences.",
};

interface PreferencesRouteProps {
  searchParams: Promise<{ team?: string }>;
}

export default async function PreferencesRoute({
  searchParams,
}: PreferencesRouteProps) {
  const { team: requestedTeamId } = await searchParams;
  const team =
    mockTeams.find((candidate) => candidate.id === requestedTeamId) ?? mockTeams[0];

  if (!team) {
    notFound();
  }

  return (
    <PreferencesPage
      initialPreferences={structuredClone(mockPreferences)}
      viewer={structuredClone(mockViewer)}
      team={structuredClone(team)}
    />
  );
}
