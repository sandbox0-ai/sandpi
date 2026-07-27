import type { Metadata } from "next";

import { WorkspaceIdePageLoader } from "@/components/bootstrap-loader";

export const metadata: Metadata = {
  title: "Web IDE · Sandpi",
  description: "Live Sandpi Environment workspace and Git changes.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function WorkspaceIdeRoute() {
  return <WorkspaceIdePageLoader />;
}
