import type { Metadata } from "next";

import { getClientPreferencesBootstrapScript } from "@/lib/client-preferences";
import { mockPreferences } from "@/lib/mock-data";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sandpi",
  description: "Remote coding agents that keep working when you disconnect.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const preferencesScript = getClientPreferencesBootstrapScript(mockPreferences);

  return (
    <html
      lang={mockPreferences.general.language}
      data-language={mockPreferences.general.language}
      data-theme={mockPreferences.appearance.theme}
      data-density={mockPreferences.appearance.density}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: preferencesScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
