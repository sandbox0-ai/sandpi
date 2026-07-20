import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_COMPOSER_UPLOAD_ROOT,
  codexComposerReference,
  codexComposerUploadReference,
  codexComposerUploadPath,
  decodeCodexComposerUpload,
  isCodexComposerUploadPath,
} from "./input-references";

test("maps visible Workspace and protected upload references to native Codex inputs", () => {
  assert.deepEqual(
    codexComposerReference({
      kind: "mention",
      name: "server.ts",
      path: "/workspace/src/server.ts",
    }),
    {
      type: "mention",
      name: "server.ts",
      path: "/workspace/src/server.ts",
    },
  );
  assert.deepEqual(
    codexComposerReference({
      kind: "localImage",
      name: "diagram.png",
      path: `${CODEX_COMPOSER_UPLOAD_ROOT}/upload-1/diagram.png`,
    }),
    {
      type: "localImage",
      path: `${CODEX_COMPOSER_UPLOAD_ROOT}/upload-1/diagram.png`,
    },
  );
});

test("does not expose other Sandpi-managed Workspace state as mentions", () => {
  assert.throws(
    () =>
      codexComposerReference({
        kind: "mention",
        name: "auth.json",
        path: "/workspace/.sandpi/harnesses/codex/auth.json",
      }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "invalid_codex_file_reference",
      );
      return true;
    },
  );
  assert.throws(() =>
    codexComposerReference({
      kind: "localImage",
      name: "outside.png",
      path: "/workspace/outside.png",
    }),
  );
});

test("creates normalized upload paths and decodes bounded canonical bytes", () => {
  const uploadPath = codexComposerUploadPath(
    "upload-1",
    "../../report\u0000.pdf",
  );
  assert.equal(
    uploadPath,
    `${CODEX_COMPOSER_UPLOAD_ROOT}/upload-1/report_.pdf`,
  );
  assert.equal(isCodexComposerUploadPath(uploadPath), true);
  assert.equal(isCodexComposerUploadPath(CODEX_COMPOSER_UPLOAD_ROOT), false);
  assert.deepEqual(
    decodeCodexComposerUpload(Buffer.from("hello").toString("base64")),
    Buffer.from("hello"),
  );
  assert.throws(() => decodeCodexComposerUpload("not base64"));
});

test("uses localImage only for uploads with a valid native image signature", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  assert.equal(
    codexComposerUploadReference({
      id: "upload:1",
      name: "pixel.png",
      path: `${CODEX_COMPOSER_UPLOAD_ROOT}/upload-1/pixel.png`,
      mimeType: "image/png",
      content: png,
    }).kind,
    "localImage",
  );
  assert.throws(() =>
    codexComposerUploadReference({
      id: "upload:2",
      name: "fake.png",
      path: `${CODEX_COMPOSER_UPLOAD_ROOT}/upload-2/fake.png`,
      mimeType: "image/png",
      content: Buffer.from("not a png"),
    }),
  );
});
