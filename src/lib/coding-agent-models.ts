import type { HarnessId } from "@/lib/types";

export interface CodingAgentModelOption {
  id: string;
  label: string;
}

/**
 * Prototype-only catalog for the mock frontend.
 * Production clients must discover available models from the native coding-agent harness
 * bound to the Environment. Sandpi must not own or duplicate a hard-coded model catalog.
 */
const mockModelsByHarness: Record<HarnessId, CodingAgentModelOption[]> = {
  codex: [
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { id: "gpt-5.1-codex-max", label: "GPT-5.1 Max" },
    { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Mini" },
  ],
  "claude-code": [
    { id: "default", label: "Default" },
    { id: "claude-opus", label: "Opus" },
    { id: "claude-sonnet", label: "Sonnet" },
    { id: "claude-haiku", label: "Haiku" },
  ],
  opencode: [
    { id: "provider-default", label: "Provider default" },
    { id: "configured-primary", label: "Primary" },
    { id: "configured-fast", label: "Fast" },
  ],
  pi: [
    { id: "default", label: "Default" },
    { id: "frontier", label: "Frontier" },
    { id: "fast", label: "Fast" },
  ],
};

export function getMockCodingAgentModels(harness: HarnessId) {
  return mockModelsByHarness[harness];
}

export function getDefaultMockCodingAgentModel(harness: HarnessId) {
  return getMockCodingAgentModels(harness)[0];
}
