"use client";

import type { InspectorTab } from "@/components/inspector";
import { CodexConversation } from "@/harnesses/codex/conversation";
import { isCodexSession } from "@/harnesses/codex/types";
import type { OperationLanguage, SendShortcut } from "@/lib/operation-ui";
import type { CodingSession, Environment } from "@/lib/types";

interface ConversationProps {
  language: OperationLanguage;
  timeZone: string;
  sendShortcut: SendShortcut;
  environment: Environment;
  session: CodingSession;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onToggleTerminal: () => void;
  onOpenSettings: (tab?: "general" | "audit") => void;
  onOpenInspector: (tab: InspectorTab) => void;
  onSessionChange: (session: CodingSession) => void;
  onDerivedSessionCreated: (session: CodingSession) => void;
  onForkSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
}

/**
 * Thin harness dispatcher. It selects a complete harness-owned conversation experience and
 * intentionally exposes no shared message, tool, approval, slash-command or composer contract.
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
