import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWorkspaceMarkdownPath,
  workspaceTextPresentationForName,
} from "./workspace-file-presentation";

test("selects lightweight semantic presentations for text files", () => {
  assert.equal(workspaceTextPresentationForName("README.md"), "markdown");
  assert.equal(workspaceTextPresentationForName("notes.markdown"), "markdown");
  assert.equal(workspaceTextPresentationForName("report.csv"), "csv");
  assert.equal(workspaceTextPresentationForName("report.tsv"), "csv");
  assert.equal(workspaceTextPresentationForName("component.tsx"), "source");
  assert.equal(workspaceTextPresentationForName("unsafe.mdx"), "source");
});

test("resolves relative Markdown paths inside the Workspace", () => {
  assert.equal(
    resolveWorkspaceMarkdownPath("../assets/chart.png", "/workspace/docs/guide.md"),
    "/workspace/assets/chart.png",
  );
  assert.equal(
    resolveWorkspaceMarkdownPath("./details.md#setup", "/workspace/docs/guide.md"),
    "/workspace/docs/details.md",
  );
  assert.equal(
    resolveWorkspaceMarkdownPath("/workspace/src/app.ts", "/workspace/README.md"),
    "/workspace/src/app.ts",
  );
});

test("rejects Markdown paths outside the Workspace and active schemes", () => {
  assert.equal(
    resolveWorkspaceMarkdownPath("../../../etc/passwd", "/workspace/docs/guide.md"),
    undefined,
  );
  assert.equal(
    resolveWorkspaceMarkdownPath("javascript:alert(1)", "/workspace/README.md"),
    undefined,
  );
  assert.equal(
    resolveWorkspaceMarkdownPath("https://example.com", "/workspace/README.md"),
    undefined,
  );
});
