"use client";

import { CodexNewSessionWorkspace } from "@/harnesses/codex/new-session-workspace";
import type { EnvironmentSettingsTab } from "@/components/environment-settings";
import type { CodexSession } from "@/harnesses/codex/types";
import type { OperationLanguage, SendShortcut } from "@/lib/operation-ui";
import type { CodingSession, Environment } from "@/lib/types";

interface NewSessionWorkspaceProps {
  language: OperationLanguage;
  sendShortcut: SendShortcut;
  environment: Environment;
  canManageEnvironment: boolean;
  onEnvironmentChange: (environment: Environment) => void;
  onCreated: (session: CodingSession) => void;
  onOpenAgentHarnessSettings: () => void;
  onOpenEnvironmentSettings: (tab: EnvironmentSettingsTab) => void;
  onToggleSidebar: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}

/**
 * Environment-level dispatcher only. Each harness owns its complete empty-session page and
 * composer; this component must not grow a shared command, model or input abstraction. Every
 * future harness adapter must discover its models and model-specific configuration options from
 * the running coding agent. Do not add Sandpi-owned fallback catalogs or capability enums here.
 */
export function NewSessionWorkspace(props: NewSessionWorkspaceProps) {
  if (props.environment.codingAgent.harness === "codex") {
    return (
      <CodexNewSessionWorkspace
        {...props}
        onCreated={(session: CodexSession) => props.onCreated(session)}
      />
    );
  }

  throw new Error(
    `No new-Session experience is registered for ${props.environment.codingAgent.harness}.`,
  );
}
