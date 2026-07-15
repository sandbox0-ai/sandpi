import "server-only";

import { Client, SandboxRuntimeMetricName } from "sandbox0";

export interface Sandbox0DeploymentConfig {
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
    label: "Environment Volume and file browser",
    sdk: "client.volumes.create / listFiles / readFile / watchFiles",
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
    label: "Signed audit, logs and runtime metrics",
    sdk: "sandbox.listObservabilityEvents / watchObservabilityEvents / getMetrics",
    status: "available",
  },
] as const;

export function createSandbox0Client(config: Sandbox0DeploymentConfig): Client {
  const apiKey = config.apiKey.trim();
  const apiHost = config.apiHost.trim().replace(/\/+$/, "");
  if (!apiKey) {
    throw new Error("SANDBOX0_API_KEY is required");
  }
  if (!apiHost) {
    throw new Error("SANDBOX0_API_HOST is required");
  }
  const url = new URL(apiHost);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("SANDBOX0_API_HOST must use http:// or https://");
  }

  return new Client({
    token: apiKey,
    baseUrl: apiHost,
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
    configurationScope: "deployment",
    tenantAuthority: "sandpi",
    credentialsExposedToClient: false,
    metricNames: {
      cpu: SandboxRuntimeMetricName.SandboxCpuUtilization,
      memory: SandboxRuntimeMetricName.SandboxMemoryWorkingSet,
      networkIo: SandboxRuntimeMetricName.SandboxNetworkIo,
    },
    capabilities: sandbox0SdkCapabilities,
  };
}
