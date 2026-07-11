import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sandpi",
  description: "Remote coding agents that keep working when you disconnect.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
