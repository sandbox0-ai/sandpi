import { randomToken } from "@/lib/id";

import {
  appendCodexTurn,
  codexUserMessageInput,
  replaceCodexTurn,
  truncateCodexEventsBeforeUserItem,
} from "./timeline";
import type {
  CodexComposerImage,
  CodexEventEnvelope,
  CodexHarnessState,
  CodexServerNotification,
  CodexSession,
} from "./types";

function mockQueuedResponse() {
  return "I’ve queued that instruction for the running Codex thread. This prototype now stores native app-server notifications; the backend integration will replace these mock events with the Supervisor event stream.";
}

export function appendMockCodexTurn(
  session: CodexSession,
  content: string,
  images: CodexComposerImage[],
  createdAt: string,
): CodexSession {
  return {
    ...session,
    updatedAt: createdAt,
    harnessState: appendCodexTurn(session.harnessState, {
      content,
      images,
      assistantText: mockQueuedResponse(),
      createdAt,
    }),
  };
}

export function deleteMockCodexTurn(
  session: CodexSession,
  userItemId: string,
  updatedAt: string,
): CodexSession | null {
  const events = truncateCodexEventsBeforeUserItem(
    session.harnessState.events,
    userItemId,
  );
  return events
    ? { ...session, updatedAt, harnessState: { ...session.harnessState, events } }
    : null;
}

export function editMockCodexTurn(
  session: CodexSession,
  userItemId: string,
  content: string,
  images: CodexComposerImage[],
  updatedAt: string,
): CodexSession | null {
  const harnessState = replaceCodexTurn(session.harnessState, userItemId, {
    content,
    images,
    assistantText: mockQueuedResponse(),
    createdAt: updatedAt,
  });
  return harnessState ? { ...session, updatedAt, harnessState } : null;
}

function notificationForFork(
  notification: CodexServerNotification,
  threadId: string,
): CodexServerNotification {
  if (notification.method === "thread/started") {
    return { ...notification, params: { thread: { id: threadId } } };
  }
  return {
    ...notification,
    params: { ...notification.params, threadId },
  } as CodexServerNotification;
}

function rebindThread(state: CodexHarnessState, threadId: string): CodexHarnessState {
  return {
    ...state,
    threadId,
    events: state.events.map(
      (event): CodexEventEnvelope => ({
        ...event,
        notification: notificationForFork(event.notification, threadId),
      }),
    ),
  };
}

function derivedCodexSession(
  source: CodexSession,
  createdAt: string,
  kind: "session" | "turn",
  harnessState: CodexHarnessState,
  sourceNativeItemId?: string,
): CodexSession {
  const idSuffix = randomToken(10);
  const createdAtDate = new Date(createdAt);

  return {
    ...source,
    id: `session-${idSuffix}`,
    title: `Fork of ${source.title}`,
    pinned: false,
    archived: false,
    unread: false,
    createdAt,
    updatedAt: createdAt,
    hardExpiresAt: new Date(
      createdAtDate.getTime() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    sandboxId: `sbx_${idSuffix}`,
    supervisorSessionId: `ses_${idSuffix}`,
    workspaceVolumeId: `vol_${idSuffix}`,
    origin: {
      kind,
      label: source.title,
      sourceSessionId: source.id,
      sourceNativeItemId,
    },
    harnessState,
    files: structuredClone(source.files),
    // A fork creates another sandbox-scoped ledger. The real Sandbox0 fork/lifecycle events
    // arrive through observability; Sandpi must neither copy source facts nor forge Supervisor
    // notifications as canonical signed audit records.
    audit: { events: [] },
    metrics: structuredClone(source.metrics),
  };
}

/**
 * Mock counterpart of a Codex-native `thread/fork` plus the Sandpi Session rootfs/Volume fork.
 * Other harnesses must define their own Session-fork semantics in their integration module.
 */
export function forkMockCodexSession(source: CodexSession, createdAt: string) {
  const threadId = `thr_${randomToken(10)}`;
  return derivedCodexSession(
    source,
    createdAt,
    "session",
    rebindThread(structuredClone(source.harnessState), threadId),
  );
}

export function forkMockCodexTurn(
  source: CodexSession,
  userItemId: string,
  createdAt: string,
): CodexSession | null {
  const input = codexUserMessageInput(source.harnessState, userItemId);
  if (!input) {
    return null;
  }
  const replayedState = replaceCodexTurn(source.harnessState, userItemId, {
    content: input.content,
    images: input.attachments,
    assistantText: mockQueuedResponse(),
    createdAt,
  });
  if (!replayedState) {
    return null;
  }

  const threadId = `thr_${randomToken(10)}`;
  return derivedCodexSession(
    source,
    createdAt,
    "turn",
    rebindThread(replayedState, threadId),
    userItemId,
  );
}
