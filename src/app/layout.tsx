import type { Metadata, Viewport } from "next";
import Script from "next/script";

import {
  DEFAULT_CLIENT_PREFERENCES,
  getClientPreferencesBootstrapScript,
  NATIVE_CHROME_BOTTOM_COLOR_META_NAME,
  NATIVE_CHROME_TOP_COLOR_META_NAME,
} from "@/lib/client-preferences";

import "@xterm/xterm/css/xterm.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sandpi",
  description: "Remote coding agents that keep working when you disconnect.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f7f6f2",
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
        <meta name="color-scheme" content="light dark" />
        <meta
          name={NATIVE_CHROME_TOP_COLOR_META_NAME}
          content="#f7f6f2"
        />
        <meta
          name={NATIVE_CHROME_BOTTOM_COLOR_META_NAME}
          content="#f7f6f2"
        />
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
