import type { Metadata } from "next";

import { PreferencesPage } from "@/components/preferences-page";
import { mockPreferences } from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Preferences · Sandpi",
  description: "Personal Sandpi preferences.",
};

export default function PreferencesRoute() {
  return (
    <PreferencesPage initialPreferences={structuredClone(mockPreferences)} />
  );
}
