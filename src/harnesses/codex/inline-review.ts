import type { CodexThreadItem, CodexTurn } from "./types";

type EnteredReviewModeItem = Extract<
  CodexThreadItem,
  { type: "enteredReviewMode" }
>;
type ExitedReviewModeItem = Extract<
  CodexThreadItem,
  { type: "exitedReviewMode" }
>;

export function enteredReviewModeItem(
  turn: CodexTurn,
): EnteredReviewModeItem | undefined {
  return turn.items.find(
    (item): item is EnteredReviewModeItem =>
      item.type === "enteredReviewMode",
  );
}

export function exitedReviewModeItem(
  turn: CodexTurn,
): ExitedReviewModeItem | undefined {
  return turn.items.find(
    (item): item is ExitedReviewModeItem => item.type === "exitedReviewMode",
  );
}

/**
 * Inline review is represented by a user-facing wrapper Turn plus a private
 * one-shot reviewer Turn in some Codex snapshots. The wrapper owns the review
 * result. Hide only an adjacent delegate that can be proven to belong to it.
 */
export function visibleCodexTurns(
  turns: readonly CodexTurn[],
): CodexTurn[] {
  const hidden = new Set<string>();
  for (let index = 0; index < turns.length - 1; index += 1) {
    const reviewTurn = turns[index];
    const candidate = turns[index + 1];
    if (
      reviewTurn &&
      candidate &&
      isInlineReviewDelegate(reviewTurn, candidate)
    ) {
      hidden.add(candidate.id);
    }
  }
  return turns.filter((turn) => !hidden.has(turn.id));
}

function isInlineReviewDelegate(
  reviewTurn: CodexTurn,
  candidate: CodexTurn,
) {
  if (!enteredReviewModeItem(reviewTurn) || candidate.error) return false;
  if (
    candidate.items.some(
      (item) =>
        item.type === "enteredReviewMode" ||
        item.type === "exitedReviewMode",
    )
  ) {
    return false;
  }

  const userMessages = candidate.items.filter(
    (item): item is Extract<CodexThreadItem, { type: "userMessage" }> =>
      item.type === "userMessage",
  );
  if (
    userMessages.length === 0 ||
    userMessages.some((item) => item.clientId !== null)
  ) {
    return false;
  }
  if (
    reviewTurn.completedAt !== null &&
    candidate.startedAt !== null &&
    candidate.startedAt > reviewTurn.completedAt
  ) {
    return false;
  }

  const review = exitedReviewModeItem(reviewTurn)?.review.trim();
  if (review) {
    return candidate.items.some(
      (item) =>
        item.type === "agentMessage" && item.text.trim() === review,
    );
  }

  // Before review completion there is no result to compare. Concurrent
  // in-progress Turns are otherwise invalid on one Codex Thread, so the
  // adjacent clientless Turn is the private reviewer.
  return (
    reviewTurn.status === "inProgress" &&
    candidate.status === "inProgress" &&
    candidate.completedAt === null
  );
}
