import type { Metadata } from "next";

import {
  DEFAULT_CLIENT_PREFERENCES,
  getClientPreferencesBootstrapScript,
} from "@/lib/client-preferences";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sandpi",
  description: "Remote coding agents that keep working when you disconnect.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const preferencesScript = getClientPreferencesBootstrapScript(
    DEFAULT_CLIENT_PREFERENCES,
  );

  return (
    <html
      lang={DEFAULT_CLIENT_PREFERENCES.general.language}
      data-language={DEFAULT_CLIENT_PREFERENCES.general.language}
      data-theme={DEFAULT_CLIENT_PREFERENCES.appearance.theme}
      data-density={DEFAULT_CLIENT_PREFERENCES.appearance.density}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: preferencesScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
