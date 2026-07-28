import type { Metadata } from "next";
import Script from "next/script";

import {
  DEFAULT_CLIENT_PREFERENCES,
  getClientPreferencesBootstrapScript,
} from "@/lib/client-preferences";

import "@xterm/xterm/css/xterm.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sandpi",
  description: "Remote coding agents that keep working when you disconnect.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const preferencesScript = getClientPreferencesBootstrapScript(
    DEFAULT_CLIENT_PREFERENCES,
  );
  const googleAnalyticsMeasurementId =
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim();

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
        {googleAnalyticsMeasurementId ? (
          <>
            <Script
              async
              src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleAnalyticsMeasurementId)}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag("js", new Date());
gtag("config", ${JSON.stringify(googleAnalyticsMeasurementId)});`}
            </Script>
          </>
        ) : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
