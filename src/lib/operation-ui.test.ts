import assert from "node:assert/strict";
import test from "node:test";

import { shouldSubmitComposer } from "./operation-ui";

const key = {
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
};

test("composer shortcut preserves newlines and IME composition", () => {
  assert.equal(shouldSubmitComposer(key, "enter"), true);
  assert.equal(
    shouldSubmitComposer({ ...key, shiftKey: true }, "enter"),
    false,
  );
  assert.equal(
    shouldSubmitComposer({ ...key, isComposing: true }, "enter"),
    false,
  );
  assert.equal(shouldSubmitComposer(key, "mod-enter"), false);
  assert.equal(
    shouldSubmitComposer({ ...key, metaKey: true }, "mod-enter"),
    true,
  );
  assert.equal(
    shouldSubmitComposer({ ...key, ctrlKey: true }, "mod-enter"),
    true,
  );
  assert.equal(
    shouldSubmitComposer(
      { ...key, ctrlKey: true, shiftKey: true },
      "mod-enter",
    ),
    false,
  );
});
