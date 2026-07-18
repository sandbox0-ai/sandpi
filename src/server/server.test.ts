import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "./http-error";
import { parseEnvironmentAuditCursor } from "./server";

test("accepts an absent or opaque Environment audit cursor unchanged", () => {
  assert.equal(parseEnvironmentAuditCursor(undefined), undefined);
  assert.equal(
    parseEnvironmentAuditCursor("opaque+cursor/value=="),
    "opaque+cursor/value==",
  );
});

test("rejects a blank Environment audit cursor", () => {
  assert.throws(
    () => parseEnvironmentAuditCursor(" \t\n"),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_audit_cursor");
      assert.equal(
        error.message,
        "The Environment audit cursor must not be blank.",
      );
      return true;
    },
  );
});

test("rejects an obviously overlong Environment audit cursor", () => {
  assert.throws(
    () => parseEnvironmentAuditCursor("x".repeat(4_097)),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_audit_cursor");
      assert.equal(
        error.message,
        "The Environment audit cursor exceeds the maximum length of 4,096 characters.",
      );
      return true;
    },
  );
});
