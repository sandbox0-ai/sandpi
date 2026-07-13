import type { Metadata } from "next";

import { PreferencesPageLoader } from "@/components/bootstrap-loader";

export const metadata: Metadata = {
  title: "Preferences · Sandpi",
  description: "Personal Sandpi preferences.",
};

export default function PreferencesRoute() {
  return <PreferencesPageLoader />;
}
