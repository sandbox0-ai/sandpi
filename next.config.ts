import type { NextConfig } from "next";

const development = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // API clients use extensionless REST, SSE, and WebSocket URLs. In development,
  // Next must proxy those exact paths instead of redirecting them to its static
  // export trailing-slash convention (WebSocket clients do not follow the 308).
  skipTrailingSlashRedirect: development,
  ...(development
    ? {
        async rewrites() {
          return [
            {
              source: "/api/v1/:path*",
              destination: "http://172.16.100.2:3001/api/v1/:path*",
            },
            {
              source: "/health/:path*",
              destination: "http://172.16.100.2:3001/health/:path*",
            },
          ];
        },
      }
    : { output: "export" as const }),
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
