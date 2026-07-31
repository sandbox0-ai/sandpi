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
      onOpenBrowserUrl: () => undefined,
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

test("marks Workspace documents for the GitHub-like reading presentation", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, {
      content: "# Workspace guide",
      variant: "document",
    }),
  );

  assert.match(
    html,
    /class="markdown-content markdown-content-document"/,
  );
  assert.match(html, /<h1>Workspace guide<\/h1>/);
});

test("keeps Workspace and external links inside their intended boundaries", () => {
  const html = render(
    "[Page](/workspace/app/page.tsx) [Docs](https://example.com)",
  );

  assert.match(html, /data-workspace-path="\/workspace\/app\/page.tsx"/);
  assert.match(html, /data-sandpi-external-link=""/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test("opens line-qualified Workspace links as their underlying files", () => {
  const html = render(
    "[Line](/workspace/app/page.tsx:42) [Column](/workspace/app/page.tsx:42:7)",
  );

  assert.equal(
    html.match(/data-workspace-path="\/workspace\/app\/page\.tsx"/g)?.length,
    2,
  );
  assert.doesNotMatch(html, /data-workspace-path="[^"]*:42/);
});

test("resolves relative links from a Workspace Markdown file", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, {
      content: "[Details](./reference/details.md)",
      baseWorkspacePath: "/workspace/docs/guide.md",
      onOpenWorkspacePath: () => undefined,
    }),
  );

  assert.match(
    html,
    /data-workspace-path="\/workspace\/docs\/reference\/details\.md"/,
  );
});

test("delegates relative Workspace images to a safe file renderer", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, {
      content: "![Chart](../assets/chart.png)",
      baseWorkspacePath: "/workspace/docs/guide.md",
      renderWorkspaceImage: (path, alt) =>
        createElement("span", { "data-image-path": path }, alt),
    }),
  );

  assert.match(html, /data-image-path="\/workspace\/assets\/chart\.png"/);
  assert.match(html, />Chart<\/span>/);
});

test("routes sandbox loopback links into the shared Environment browser", () => {
  const html = render(
    "[Next.js](http://localhost:3000/dashboard) [API](127.0.0.1:8080/health)",
  );

  assert.match(html, /data-browser-url="http:\/\/localhost:3000\/dashboard"/);
  assert.match(html, /data-browser-url="http:\/\/127\.0\.0\.1:8080\/health"/);
  assert.doesNotMatch(html, /data-sandpi-external-link/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("marks external image destinations for native system browsers", () => {
  const html = render("![Architecture](https://example.com/diagram.png)");

  assert.match(html, /class="markdown-image-link"/);
  assert.match(html, /data-sandpi-external-link=""/);
  assert.match(html, /href="https:\/\/example\.com\/diagram\.png"/);
});

test("does not preserve scheme-less loopback targets without a Browser handler", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, {
      content: "[App](localhost:3000)",
    }),
  );

  assert.match(html, /<a href="">App<\/a>/);
  assert.doesNotMatch(html, /data-browser-url/);
});

test("renders raw HTML from a harness message as inert text", () => {
  const html = render('Safe <script>alert("unsafe")</script> text');

  assert.doesNotMatch(html, /<script>/);
  assert.match(
    html,
    /Safe &lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt; text/,
  );
});

test("preserves pasted multiline script blocks as inert text", () => {
  const html = render(`Before

<!-- Google tag -->
<script async src="https://example.com/tag.js"></script>
<script>
  window.dataLayer = window.dataLayer || [];
</script>

After`);

  assert.doesNotMatch(html, /<script(?:\s|>)/i);
  assert.match(html, /&lt;!-- Google tag --&gt;/);
  assert.match(
    html,
    /&lt;script async src=&quot;https:\/\/example\.com\/tag\.js&quot;&gt;&lt;\/script&gt;/,
  );
  assert.match(html, /window\.dataLayer = window\.dataLayer \|\| \[\];/);
  assert.match(html, /&lt;\/script&gt;/);
});
