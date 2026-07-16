import type {
  CodingSession,
  HarnessEventEnvelope,
  SessionStatus,
} from "@/lib/types";

/**
 * Hand-maintained subset of the Codex app-server v2 schema used by the current UI and mock
 * fixtures. Production packaging should generate the exact TypeScript schema from the Codex
 * binary pinned to the Environment with
 * `codex app-server generate-ts --out <dir>`. Keeping the native method and item names here is
 * intentional: Sandpi must not translate them into a cross-harness chat or tool-call model.
 */
export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" };

export interface CodexFileUpdateChange {
  path: string;
  kind:
    | { type: "add" }
    | { type: "delete" }
    | { type: "update"; move_path: string | null };
  diff: string;
}

export type CodexCommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export type CodexThreadItem =
  | {
      type: "userMessage";
      id: string;
      clientId: string | null;
      content: CodexUserInput[];
    }
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase: "commentary" | "final_answer" | null;
      memoryCitation: null;
    }
  | {
      type: "plan";
      id: string;
      text: string;
    }
  | {
      type: "reasoning";
      id: string;
      summary: string[];
      content: string[];
    }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      source: "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";
      status: "inProgress" | "completed" | "failed" | "declined";
      commandActions: CodexCommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: CodexFileUpdateChange[];
      status: "inProgress" | "completed" | "failed" | "declined";
    };

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  itemsView: "notLoaded" | "summary" | "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: {
    message: string;
    codexErrorInfo: unknown | null;
    additionalDetails: string | null;
  } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export type CodexThreadStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | {
      type: "active";
      activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput">;
    };

/** Native app-server Thread returned by thread/read(includeTurns=true). */
export interface CodexThread {
  id: string;
  sessionId?: string;
  forkedFromId?: string | null;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  status: CodexThreadStatus;
  turns: CodexTurn[];
}

export type CodexServerNotification =
  | { method: "thread/started"; params: { thread: { id: string } } }
  | { method: "turn/started"; params: { threadId: string; turn: CodexTurn } }
  | {
      method: "item/started";
      params: {
        item: CodexThreadItem;
        threadId: string;
        turnId: string;
        startedAtMs: number;
      };
    }
  | {
      method: "item/agentMessage/delta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "item/plan/delta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "item/reasoning/summaryTextDelta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
        summaryIndex: number;
      };
    }
  | {
      method: "item/reasoning/summaryPartAdded";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        summaryIndex: number;
      };
    }
  | {
      method: "item/reasoning/textDelta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
        contentIndex: number;
      };
    }
  | {
      method: "item/commandExecution/outputDelta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "item/commandExecution/terminalInteraction";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        processId: string;
        stdin: string;
      };
    }
  | {
      method: "item/fileChange/outputDelta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "item/fileChange/patchUpdated";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        changes: CodexFileUpdateChange[];
      };
    }
  | {
      method: "item/completed";
      params: {
        item: CodexThreadItem;
        threadId: string;
        turnId: string;
        completedAtMs: number;
      };
    }
  | { method: "turn/completed"; params: { threadId: string; turn: CodexTurn } };

/**
 * Native app-server notifications needed to reconstruct the live Codex transcript. Keep the
 * names intact: this is a Codex transport contract, not a cross-harness event vocabulary.
 */
export const CODEX_TRANSCRIPT_NOTIFICATION_METHODS = [
  "turn/started",
  "item/started",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/completed",
  "turn/completed",
] as const;

export type CodexEventEnvelope = HarnessEventEnvelope<"codex", CodexServerNotification>;

export interface CodexHarnessState {
  protocol: "codex-app-server";
  /** Opaque native reference only. Conversation history remains in CODEX_HOME. */
  threadId: string;
  modelId: string;
  harnessVersion: string;
  protocolVersion: "v2";
  /** Changes whenever the product Session switches to another native branch. */
  historyRevision: number;
}

/**
 * Codex-specific read model. `thread` is the unmodified native app-server
 * payload; Sandpi adds only native branch capability and control metadata.
 */
export interface CodexNativeSnapshot {
  protocol: "codex-app-server";
  nativeSessionId: string;
  historyRevision: number;
  modelId: string;
  /**
   * Product control state derived from the same native event stream. Sandpi
   * persists this scalar for refresh recovery, never the transcript payload.
   */
  sessionStatus: SessionStatus;
  thread: CodexThread;
  /** Completed native Turns through which Codex can fork a child Thread. */
  forkableTurnIds: string[];
}

/**
 * A native branch became stale. A recoverable invalidation is followed by a
 * fresh `snapshot`; an unrecoverable invalidation means the Codex rollout is
 * gone and Sandpi must not substitute a database transcript for it.
 */
export interface CodexNativeInvalidation {
  reason?: string;
  message?: string;
  unrecoverable?: boolean;
}

export type CodexSession = CodingSession<"codex", CodexHarnessState>;

export interface CodexComposerImage {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Data URL preview; the server validates it before sending Codex's native `image` input. */
  previewUrl: string;
}

export function isCodexSession(session: CodingSession): session is CodexSession {
  return session.harness === "codex";
}
