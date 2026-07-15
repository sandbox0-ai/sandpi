import type { SandpiConfig } from "@/server/config";
import { Sandbox0Runtime } from "./sandbox0";
import type { RuntimeAdapter } from "./types";
import { UnconfiguredRuntime } from "./unconfigured";

export function createRuntime(config: SandpiConfig): RuntimeAdapter {
  return config.sandbox0 ? new Sandbox0Runtime(config.sandbox0) : new UnconfiguredRuntime();
}

export type { EnvironmentRuntimeRecord, RuntimeAdapter } from "./types";
