import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownContent } from "./markdown-content";

function render(content: string) {
  return renderToStaticMarkup(
    createElement(MarkdownContent, {
      content,
      onOpenWorkspacePath: () => undefined,
    }),
  );
}

test("renders common Markdown and GitHub-flavored structures", () => {
  const html = render(`# Result

- [x] tests pass
- ~~obsolete~~

| File | Status |
| --- | --- |
| app.tsx | changed |

\`\`\`tsx
export default function App() {}
\`\`\``);

  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<del>obsolete<\/del>/);
  assert.match(html, /class="markdown-table-scroll"/);
  assert.match(html, /class="language-tsx"/);
});

test("keeps Workspace and external links inside their intended boundaries", () => {
  const html = render(
    "[Page](/workspace/app/page.tsx) [Docs](https://example.com)",
  );

  assert.match(html, /data-workspace-path="\/workspace\/app\/page.tsx"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test("does not execute raw HTML from a harness message", () => {
  const html = render("Safe <script>alert('unsafe')</script> text");
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\('unsafe'\)/);
});
