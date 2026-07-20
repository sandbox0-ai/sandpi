import assert from "node:assert/strict";
import test from "node:test";

import {
  codexFileMentionToken,
  insertCodexFileMentions,
} from "./file-mentions";

test("inserts visible Codex file paths at the current selection", () => {
  assert.deepEqual(
    insertCodexFileMentions(
      "Inspect this placeholder please",
      ["/workspace/src/server.ts"],
      13,
      24,
    ),
    {
      text: "Inspect this src/server.ts  please",
      cursor: "Inspect this src/server.ts ".length,
    },
  );
});

test("keeps completion typing separated from an existing suffix", () => {
  const insertion = insertCodexFileMentions(
    "Inspect please",
    ["/workspace/src/server.ts"],
    "Inspect ".length,
    "Inspect ".length,
  );
  assert.equal(
    `${insertion.text.slice(0, insertion.cursor)}closely${insertion.text.slice(insertion.cursor)}`,
    "Inspect src/server.ts closely please",
  );
});

test("quotes paths with spaces and keeps every mention user-visible", () => {
  assert.deepEqual(
    insertCodexFileMentions("Compare", [
      "/workspace/.sandpi/uploads/upload-1/first report.pdf",
      "/workspace/README.md",
    ]),
    {
      text:
        'Compare ".sandpi/uploads/upload-1/first report.pdf" README.md ',
      cursor:
        'Compare ".sandpi/uploads/upload-1/first report.pdf" README.md '
          .length,
    },
  );
});

test("does not synthesize instructions around a file mention", () => {
  assert.equal(
    codexFileMentionToken("/workspace/docs/design.md"),
    "docs/design.md",
  );
  assert.deepEqual(insertCodexFileMentions("", ["/workspace/docs/design.md"]), {
    text: "docs/design.md ",
    cursor: "docs/design.md ".length,
  });
});
