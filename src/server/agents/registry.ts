import type { EnvironmentAgentId } from "@/lib/types";
import { CODEX_ENVIRONMENT_CREDENTIAL_PATH } from "@/server/runtime/types";

export interface AgentCredentialProjection {
  persistentLink?: string;
  ephemeralPath?: string;
  credentialType?: string;
  managedBySandpi: boolean;
}

export interface AgentAdapter {
  id: EnvironmentAgentId;
  label: string;
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  persistentStatePaths: readonly string[];
  credentialProjection: AgentCredentialProjection;
  runtimeRecovery: "restart";
  capabilities: {
    nativeResume: boolean;
    mouse: boolean;
    structuredAutomation: boolean;
  };
}

const WORKSPACE_HOME = "/workspace";
const AGENT_STATE_ROOT = `${WORKSPACE_HOME}/.sandpi/harnesses`;

// These commands run inside Sandbox0, which owns the isolation boundary.
// Native harnesses should not add another sandbox or require tool approvals.
const adapters = {
  codex: {
    id: "codex",
    label: "Codex",
    command: [
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'cli_auth_credentials_store="file"',
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "remote_plugin",
      "--disable",
      "tool_suggest",
    ],
    environment: {
      HOME: WORKSPACE_HOME,
      CODEX_HOME: `${AGENT_STATE_ROOT}/codex`,
    },
    persistentStatePaths: [`${AGENT_STATE_ROOT}/codex`],
    credentialProjection: {
      persistentLink: `${AGENT_STATE_ROOT}/codex/auth.json`,
      ephemeralPath: CODEX_ENVIRONMENT_CREDENTIAL_PATH,
      credentialType: "codex-native-auth-json",
      managedBySandpi: true,
    },
    runtimeRecovery: "restart",
    capabilities: {
      nativeResume: true,
      mouse: true,
      structuredAutomation: false,
    },
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    command: [
      "claude",
      "--dangerously-skip-permissions",
      "--settings",
      JSON.stringify({ skipDangerousModePermissionPrompt: true }),
    ],
    environment: {
      HOME: WORKSPACE_HOME,
      // The guest may run as root; Claude requires this for sandboxed bypass.
      IS_SANDBOX: "1",
      CLAUDE_CONFIG_DIR: `${AGENT_STATE_ROOT}/claude-code`,
    },
    persistentStatePaths: [`${AGENT_STATE_ROOT}/claude-code`],
    credentialProjection: {
      persistentLink: `${AGENT_STATE_ROOT}/claude-code/.credentials.json`,
      ephemeralPath: "/dev/shm/sandpi-claude-code-auth.json",
      credentialType: "claude-code-native-credentials-json",
      managedBySandpi: true,
    },
    runtimeRecovery: "restart",
    capabilities: {
      nativeResume: true,
      mouse: true,
      structuredAutomation: false,
    },
  },
  pi: {
    id: "pi",
    label: "Pi",
    // Pi already runs tools without a built-in permission approval layer.
    command: ["pi"],
    environment: {
      HOME: WORKSPACE_HOME,
    },
    persistentStatePaths: [`${WORKSPACE_HOME}/.pi/agent`],
    credentialProjection: {
      persistentLink: `${WORKSPACE_HOME}/.pi/agent/auth.json`,
      ephemeralPath: "/dev/shm/sandpi-pi-auth.json",
      credentialType: "pi-native-auth-json",
      managedBySandpi: true,
    },
    runtimeRecovery: "restart",
    capabilities: {
      nativeResume: true,
      mouse: true,
      structuredAutomation: false,
    },
  },
} as const satisfies Record<EnvironmentAgentId, AgentAdapter>;

export const AGENT_ADAPTERS: Readonly<Record<EnvironmentAgentId, AgentAdapter>> =
  adapters;

export function agentAdapter(agentId: EnvironmentAgentId): AgentAdapter {
  return AGENT_ADAPTERS[agentId];
}

export function agentSessionName(agentId: EnvironmentAgentId) {
  return `sandpi-agent-${agentId}`;
}

export function agentSessionIdempotencyKey(
  environmentId: string,
  agentId: EnvironmentAgentId,
) {
  return `sandpi-agent-${agentId}-${environmentId}`;
}
