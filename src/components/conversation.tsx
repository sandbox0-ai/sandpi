"use client";

import type { InspectorTab } from "@/components/inspector";
import type {
  EnvironmentSettingsOpenOptions,
  EnvironmentSettingsTab,
} from "@/components/environment-settings";
import type { WorkspaceFileNavigationRequest } from "@/components/workspace-ide";
import { CodexConversation } from "@/harnesses/codex/conversation";
import { isCodexSession } from "@/harnesses/codex/types";
import type { OperationLanguage, SendShortcut } from "@/lib/operation-ui";
import type { CodingSession, Environment, SandpiUser } from "@/lib/types";

interface ConversationProps {
  language: OperationLanguage;
  timeZone: string;
  sendShortcut: SendShortcut;
  viewer: SandpiUser;
  environment: Environment;
  session: CodingSession;
  refreshEpoch: number;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  inspectorWidthRatio: number;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onInspectorWidthRatioChange: (ratio: number, persist: boolean) => void;
  onToggleTerminal: () => void;
  onNewSession: () => void;
  onOpenEnvironmentSettings: (
    tab: EnvironmentSettingsTab,
    options?: EnvironmentSettingsOpenOptions,
  ) => void;
  onOpenInspector: (tab: InspectorTab) => void;
  workspaceNavigationRequest?: WorkspaceFileNavigationRequest;
  onOpenWorkspacePath: (path: string) => void;
  onWorkspaceNavigationHandled: (
    request: WorkspaceFileNavigationRequest,
  ) => void;
  onSessionChange: (session: CodingSession) => void;
  onToggleSessionCompleted: (sessionId: string) => Promise<void>;
  onDerivedSessionCreated: (session: CodingSession) => void;
}

/**
 * Thin harness dispatcher. It selects a complete harness-owned conversation experience and
 * intentionally exposes no shared message, tool, approval or composer contract.
 */
export function Conversation(props: ConversationProps) {
  if (isCodexSession(props.session)) {
    // Preserve callback identity across harness dispatch. The Codex
    // conversation owns a long-lived EventSource; wrapping this prop on every
    // render would tear down the stream after each native snapshot/update.
    return <CodexConversation {...props} session={props.session} />;
  }

  throw new Error(`No conversation experience is registered for ${props.session.harness}.`);
}
