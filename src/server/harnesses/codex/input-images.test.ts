import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import { nativeCodexTurnInput } from "./input-images";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

test("projects validated image bytes into the native Codex image input", () => {
  assert.deepEqual(
    nativeCodexTurnInput("Inspect this", [
      { name: "pixel.png", mimeType: "image/png", dataBase64: onePixelPng },
    ]),
    [
      { type: "text", text: "Inspect this", text_elements: [] },
      { type: "image", url: `data:image/png;base64,${onePixelPng}` },
    ],
  );
});

test("rejects image content that does not match its declared type", () => {
  assert.throws(
    () =>
      nativeCodexTurnInput("", [
        {
          name: "not-an-image.png",
          mimeType: "image/png",
          dataBase64: Buffer.from("not an image").toString("base64"),
        },
      ]),
    (error) => error instanceof HttpError && error.code === "invalid_codex_image",
  );
});

test("preserves visible file path text and native local image inputs", () => {
  assert.deepEqual(
    nativeCodexTurnInput(
      "Compare README.md",
      [],
      [
        {
          name: "diagram.png",
          path: "/workspace/.sandpi/uploads/upload-1/diagram.png",
        },
      ],
    ),
    [
      { type: "text", text: "Compare README.md", text_elements: [] },
      {
        type: "localImage",
        path: "/workspace/.sandpi/uploads/upload-1/diagram.png",
      },
    ],
  );
});
