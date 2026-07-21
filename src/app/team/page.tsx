import type { Metadata } from "next";

import { TeamSettingsPageLoader } from "@/components/bootstrap-loader";

export const metadata: Metadata = {
  title: "Team settings · Sandpi",
  description: "Manage a Sandpi Team, Team Plan, shared quota and billing.",
};

export default function TeamSettingsRoute() {
  return <TeamSettingsPageLoader />;
}
