import type { CodingSession, HarnessEventEnvelope } from "@/lib/types";

/**
 * Mock-only subset of the Codex app-server v2 schema. Production builds must generate and use
 * the exact TypeScript schema from the Codex binary pinned to the Environment with
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
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      source: "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";
      status: "inProgress" | "completed" | "failed" | "declined";
      commandActions: [];
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
  itemsView: "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
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
      method: "item/completed";
      params: {
        item: CodexThreadItem;
        threadId: string;
        turnId: string;
        completedAtMs: number;
      };
    }
  | { method: "turn/completed"; params: { threadId: string; turn: CodexTurn } };

export type CodexEventEnvelope = HarnessEventEnvelope<"codex", CodexServerNotification>;

export interface CodexHarnessState {
  protocol: "codex-app-server";
  threadId: string;
  modelId: string;
  harnessVersion: string;
  protocolVersion: "v2";
  /** Monotonic server branch revision used to reset other connected clients. */
  historyRevision?: number;
  events: CodexEventEnvelope[];
  /** User-message item IDs backed by a ready Workspace Volume checkpoint. */
  recoverableUserMessageItemIds?: string[];
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
