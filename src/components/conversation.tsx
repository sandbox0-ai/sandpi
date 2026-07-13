"use client";

import type { InspectorTab } from "@/components/inspector";
import { CodexConversation } from "@/harnesses/codex/conversation";
import { isCodexSession, type CodexSession } from "@/harnesses/codex/types";
import type { OperationLanguage, SendShortcut } from "@/lib/operation-ui";
import type { CodingSession, Environment } from "@/lib/types";

interface ConversationProps {
  language: OperationLanguage;
  sendShortcut: SendShortcut;
  environment: Environment;
  session: CodingSession;
  inspectorOpen: boolean;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  onOpenInspector: (tab: InspectorTab) => void;
  onSessionChange: (session: CodingSession) => void;
  onCreateSession: (session: CodingSession) => void;
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
    return (
      <CodexConversation
        {...props}
        session={props.session}
        onSessionChange={(session: CodexSession) => props.onSessionChange(session)}
        onCreateSession={(session: CodexSession) => props.onCreateSession(session)}
      />
    );
  }

  throw new Error(`No conversation experience is registered for ${props.session.harness}.`);
}
