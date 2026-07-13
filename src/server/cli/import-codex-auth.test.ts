import assert from "node:assert/strict";
import test from "node:test";

import { parseImportOptions } from "./import-codex-auth";

test("Codex auth import requires an explicit Environment", () => {
  assert.throws(() => parseImportOptions([]), /--environment is required/);
});

test("Codex auth import defaults to the native user auth cache", () => {
  const options = parseImportOptions(["--environment", "env-test"]);
  assert.equal(options.environmentId, "env-test");
  assert.match(options.filePath, /\/\.codex\/auth\.json$/);
});

test("Codex auth import rejects unknown arguments", () => {
  assert.throws(
    () => parseImportOptions(["--environment", "env-test", "--token", "secret"]),
    /Unknown argument: --token/,
  );
});
