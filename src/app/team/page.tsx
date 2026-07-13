import type { Metadata } from "next";

import { TeamSettingsPageLoader } from "@/components/bootstrap-loader";

export const metadata: Metadata = {
  title: "Team settings · Sandpi",
  description: "Manage a Sandpi Team, member Plans, billing and usage.",
};

export default function TeamSettingsRoute() {
  return <TeamSettingsPageLoader />;
}
