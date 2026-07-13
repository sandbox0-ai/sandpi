import { createMockCodexTurnEvents, projectCodexConversation } from "./events";
import type {
  CodexComposerImage,
  CodexEventEnvelope,
  CodexHarnessState,
} from "./types";

function completedUserItem(event: CodexEventEnvelope, itemId: string) {
  return (
    event.notification.method === "item/completed" &&
    event.notification.params.item.type === "userMessage" &&
    event.notification.params.item.id === itemId
  );
}

function turnStartIndex(events: CodexEventEnvelope[], itemId: string) {
  const userEventIndex = events.findIndex((event) => completedUserItem(event, itemId));
  if (userEventIndex < 0) {
    return -1;
  }
  const userEvent = events[userEventIndex];
  if (userEvent.notification.method !== "item/completed") {
    return -1;
  }
  const turnId = userEvent.notification.params.turnId;
  for (let index = userEventIndex; index >= 0; index -= 1) {
    const notification = events[index].notification;
    if (
      notification.method === "turn/started" &&
      notification.params.turn.id === turnId
    ) {
      return index;
    }
  }
  return userEventIndex;
}

/**
 * Codex-only Turn editing contract. The rollback marker is the native userMessage item; shared
 * Sandpi code never truncates a synthetic cross-harness message array.
 */
export function truncateCodexEventsBeforeUserItem(
  events: CodexEventEnvelope[],
  itemId: string,
): CodexEventEnvelope[] | null {
  const index = turnStartIndex(events, itemId);
  return index < 0 ? null : events.slice(0, index);
}

export function visibleCodexConversationWhileEditing(
  events: CodexEventEnvelope[],
  itemId: string | null,
) {
  if (!itemId) {
    return projectCodexConversation(events);
  }
  const prefix = truncateCodexEventsBeforeUserItem(events, itemId);
  return projectCodexConversation(prefix ?? events);
}

export function replaceCodexTurn(
  state: CodexHarnessState,
  itemId: string,
  input: {
    content: string;
    images?: CodexComposerImage[];
    assistantText: string;
    createdAt: string;
  },
): CodexHarnessState | null {
  const prefix = truncateCodexEventsBeforeUserItem(state.events, itemId);
  if (!prefix) {
    return null;
  }
  const next = { ...state, events: prefix };
  return { ...next, events: [...prefix, ...createMockCodexTurnEvents(next, input)] };
}

export function appendCodexTurn(
  state: CodexHarnessState,
  input: {
    content: string;
    images?: CodexComposerImage[];
    assistantText: string;
    createdAt: string;
  },
): CodexHarnessState {
  return {
    ...state,
    events: [...state.events, ...createMockCodexTurnEvents(state, input)],
  };
}

export function codexUserMessageInput(state: CodexHarnessState, itemId: string) {
  return projectCodexConversation(state.events).find(
    (message) => message.id === itemId && message.role === "user",
  );
}
