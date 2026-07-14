import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import {
  requireWorkspaceFileRevision,
  workspaceFileRevision,
} from "./workspace-edit";

test("Workspace file revisions are stable content identities", () => {
  const content = Buffer.from("const value = 1;\n");
  assert.equal(workspaceFileRevision(content), workspaceFileRevision(content));
  assert.notEqual(
    workspaceFileRevision(content),
    workspaceFileRevision(Buffer.from("const value = 2;\n")),
  );
});

test("Workspace writes expose the current revision on conflict", () => {
  assert.throws(
    () => requireWorkspaceFileRevision(Buffer.from("new"), workspaceFileRevision(Buffer.from("old"))),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "workspace_file_conflict");
      assert.deepEqual(error.details, {
        currentRevision: workspaceFileRevision(Buffer.from("new")),
      });
      return true;
    },
  );
});
