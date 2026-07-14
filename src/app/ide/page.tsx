import type { Metadata } from "next";

import { WorkspaceIdePageLoader } from "@/components/bootstrap-loader";

export const metadata: Metadata = {
  title: "Web IDE · Sandpi",
  description: "Live Sandpi Session workspace and Git changes.",
};

export default function WorkspaceIdeRoute() {
  return <WorkspaceIdePageLoader />;
}
