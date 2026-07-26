export const SANDPI_GITHUB_REPOSITORY_URL =
  "https://github.com/sandbox0-ai/sandpi";

export const SANDPI_DOCUMENTATION_URL =
  `${SANDPI_GITHUB_REPOSITORY_URL}#readme`;

const SANDPI_NEW_ISSUE_URL = `${SANDPI_GITHUB_REPOSITORY_URL}/issues/new`;

export type SandpiFeedbackKind = "bug" | "feedback";

export function sandpiFeedbackIssueUrl(
  kind: SandpiFeedbackKind,
  context: {
    pageUrl: string;
    userAgent: string;
  },
) {
  const page = new URL(context.pageUrl);
  const safePage = `${page.origin}${page.pathname}`;
  const url = new URL(SANDPI_NEW_ISSUE_URL);
  const browser = context.userAgent.trim().slice(0, 500) || "Unknown";

  url.searchParams.set("title", kind === "bug" ? "Bug: " : "Feedback: ");
  url.searchParams.set(
    "body",
    kind === "bug"
      ? [
          "## What happened?",
          "",
          "",
          "## Steps to reproduce",
          "",
          "1. ",
          "",
          "## Expected behavior",
          "",
          "",
          "## Context",
          "",
          `- Page: ${safePage}`,
          `- Browser: ${browser}`,
        ].join("\n")
      : [
          "## Feedback or suggestion",
          "",
          "",
          "## Why would this be useful?",
          "",
          "",
          "## Context",
          "",
          `- Page: ${safePage}`,
          `- Browser: ${browser}`,
        ].join("\n"),
  );
  return url.toString();
}
