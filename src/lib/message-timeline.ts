import type { ChatMessage } from "@/lib/types";

function userMessageIndex(messages: ChatMessage[], messageId: string) {
  return messages.findIndex((message) => message.id === messageId && message.role === "user");
}

/**
 * Cross-client editing contract for Web, iOS, Android, and HarmonyOS: editing rewrites a
 * branch instead of appending a new message, so hide the selected user Turn and every
 * descendant while its draft is open. Keeping the stale branch visible makes Send look like
 * an append action and must not be reintroduced by another client.
 */
export function visibleTimelineWhileEditing(
  messages: ChatMessage[],
  editingMessageId: string | null,
): ChatMessage[] {
  if (!editingMessageId) {
    return messages;
  }
  return truncateTimelineFromUserMessage(messages, editingMessageId) ?? messages;
}

/**
 * Returns the product timeline before a Turn boundary. The production backend must restore
 * that boundary's Workspace Volume snapshot before publishing this truncated timeline.
 */
export function truncateTimelineFromUserMessage(
  messages: ChatMessage[],
  messageId: string,
): ChatMessage[] | null {
  const index = userMessageIndex(messages, messageId);
  if (index < 0) {
    return null;
  }
  return messages.slice(0, index);
}

/**
 * Replaces a Turn and all descendants after the Workspace Volume has been restored or forked.
 * Session rootfs state is intentionally outside this Turn-level operation.
 */
export function replaceTimelineFromUserMessage(
  messages: ChatMessage[],
  messageId: string,
  replacement: ChatMessage[],
): ChatMessage[] | null {
  const prefix = truncateTimelineFromUserMessage(messages, messageId);
  if (!prefix) {
    return null;
  }
  return [...prefix, ...replacement];
}
