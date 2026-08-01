export const GITHUB_WEBHOOK_EVENT_TYPES = [
  { value: "pull_request.opened", label: "Pull request opened" },
  { value: "pull_request.reopened", label: "Pull request reopened" },
  { value: "pull_request.synchronize", label: "Pull request updated" },
  { value: "pull_request.ready_for_review", label: "Pull request ready" },
  { value: "pull_request.closed", label: "Pull request closed" },
  { value: "pull_request_review.submitted", label: "Review submitted" },
  {
    value: "pull_request_review_comment.created",
    label: "Review comment created",
  },
  { value: "issues.opened", label: "Issue opened" },
  { value: "issues.reopened", label: "Issue reopened" },
  { value: "issues.labeled", label: "Issue labeled" },
  { value: "issues.closed", label: "Issue closed" },
  { value: "issue_comment.created", label: "Issue or PR comment created" },
] as const;

export const GITHUB_WEBHOOK_EVENT_TYPE_VALUES = new Set<string>(
  GITHUB_WEBHOOK_EVENT_TYPES.map((event) => event.value),
);

export const DEFAULT_GITHUB_WEBHOOK_EVENT_TYPES = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request_review.submitted",
  "issues.opened",
  "issue_comment.created",
] as const;
