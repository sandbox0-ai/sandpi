export interface CodexFileMentionInsertion {
  text: string;
  cursor: number;
}

/**
 * Codex CLI file mentions are literal, user-visible path text. They are not
 * app-server `mention` inputs, which are reserved for apps and plugins. Keep
 * this transformation in the Codex composer and never replace it with a
 * hidden Sandpi instruction appended to the user's prompt.
 */
export function insertCodexFileMentions(
  text: string,
  filePaths: readonly string[],
  selectionStart = text.length,
  selectionEnd = selectionStart,
): CodexFileMentionInsertion {
  const mentions = filePaths
    .map(codexFileMentionToken)
    .filter((mention) => mention.length > 0);
  if (mentions.length === 0) {
    return { text, cursor: clampedOffset(selectionStart, text.length) };
  }

  const start = clampedOffset(selectionStart, text.length);
  const end = Math.max(start, clampedOffset(selectionEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const leadingSpace = before && !/\s$/u.test(before) ? " " : "";
  const mentionText = `${leadingSpace}${mentions.join(" ")}`;
  const trailing = completionSeparator(after);
  const inserted = `${mentionText}${trailing.inserted}`;

  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + mentionText.length + trailing.cursorAdvance,
  };
}

export function codexFileMentionToken(filePath: string) {
  const relativePath = workspaceRelativePath(filePath.trim());
  if (!relativePath) return "";
  return /\s/u.test(relativePath) && !relativePath.includes('"')
    ? `"${relativePath}"`
    : relativePath;
}

export function workspaceRelativePath(filePath: string) {
  return filePath === "/workspace"
    ? "/workspace"
    : filePath.replace(/^\/workspace\//u, "");
}

function clampedOffset(offset: number, textLength: number) {
  if (!Number.isFinite(offset)) return textLength;
  return Math.min(textLength, Math.max(0, Math.trunc(offset)));
}

function completionSeparator(after: string) {
  const first = [...after][0];
  if (!first) {
    return { inserted: " ", cursorAdvance: 1 };
  }
  if (!/\s/u.test(first)) {
    return { inserted: "  ", cursorAdvance: 1 };
  }
  if (!isHorizontalWhitespace(first)) {
    return { inserted: " ", cursorAdvance: 1 };
  }

  const nextOffset = first.length;
  const next = [...after.slice(nextOffset)][0];
  if (next && !/\s/u.test(next)) {
    // Preserve the existing separator before its suffix and leave the cursor
    // between two separators, matching Codex CLI completion behavior.
    return { inserted: " ", cursorAdvance: 1 };
  }
  return { inserted: "", cursorAdvance: first.length };
}

function isHorizontalWhitespace(value: string) {
  return (
    /\s/u.test(value) &&
    !["\n", "\r", "\u000b", "\u000c", "\u0085", "\u2028", "\u2029"].includes(
      value,
    )
  );
}
