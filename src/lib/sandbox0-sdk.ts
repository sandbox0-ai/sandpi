import "server-only";

import { Client, SandboxRuntimeMetricName } from "sandbox0";

import {
  normalizeSandbox0ApiHost,
  requireSandbox0ApiKey,
} from "@/lib/sandbox0-connection";

export interface Sandbox0ClientConnection {
  apiHost: string;
  apiKey: string;
}

export const sandbox0SdkCapabilities = [
  {
    id: "sandbox-lifecycle",
    label: "Sandbox lifecycle",
    sdk: "client.sandboxes.claim / pause / resume / fork",
    status: "available",
  },
  {
    id: "supervisor-sessions",
    label: "Supervisor sessions and resumable events",
    sdk: "sandbox.createSession / watchSessionEvents / connectSession",
    status: "available",
  },
  {
    id: "web-terminal",
    label: "Web terminal over Supervisor I/O",
    sdk: "sandbox.connectSession / resizeSessionTerminal / writeSessionInput",
    status: "available",
  },
  {
    id: "workspace-volumes",
    label: "Volume fork and file browser",
    sdk: "client.volumes.fork / listFiles / readFile / watchFiles",
    status: "available",
  },
  {
    id: "network-policy",
    label: "Per-sandbox network policy",
    sdk: "sandbox.getNetworkPolicy / updateNetworkPolicy",
    status: "available",
  },
  {
    id: "observability",
    label: "Audit, logs and runtime metrics",
    sdk: "sandbox.listObservabilityEvents / getMetrics / getMetricsCatalog",
    status: "available",
  },
] as const;

export function createSandbox0Client(connection: Sandbox0ClientConnection): Client {
  return new Client({
    token: requireSandbox0ApiKey(connection.apiKey),
    baseUrl: normalizeSandbox0ApiHost(connection.apiHost),
    userAgent: "sandpi/0.1.0",
  });
}

export function createSandbox0ClientFromEnv(): Client | null {
  const apiKey =
    process.env.SANDBOX0_API_KEY?.trim() ||
    process.env.SANDBOX0_API_TOKEN?.trim() ||
    process.env.SANDBOX0_TOKEN?.trim();
  if (!apiKey) {
    return null;
  }

  return createSandbox0Client({
    apiKey,
    apiHost:
      process.env.SANDBOX0_API_HOST?.trim() ||
      process.env.SANDBOX0_BASE_URL?.trim() ||
      "https://api.sandbox0.ai",
  });
}

export function getSandbox0IntegrationSummary() {
  return {
    mode:
      process.env.SANDBOX0_API_KEY ||
      process.env.SANDBOX0_API_TOKEN ||
      process.env.SANDBOX0_TOKEN
        ? "configured"
        : "mock",
    sdkPackage: "sandbox0",
    metricNames: {
      cpu: SandboxRuntimeMetricName.SandboxCpuUsage,
      memory: SandboxRuntimeMetricName.SandboxMemoryWorkingSet,
    },
    capabilities: sandbox0SdkCapabilities,
  };
}
