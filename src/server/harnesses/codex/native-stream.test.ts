import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import { codexNativeStreamFailure } from "./native-stream";

test("projects Sandbox0 credential failures into the Codex native stream", () => {
  assert.deepEqual(
    codexNativeStreamFailure(
      new HttpError(
        401,
        "sandbox0_invalid_api_key",
        "Sandbox0 rejected the deployment API key.",
      ),
    ),
    {
      status: 401,
      code: "sandbox0_invalid_api_key",
      message: "Sandbox0 rejected the deployment API key.",
      retryable: true,
    },
  );
  assert.deepEqual(
    codexNativeStreamFailure(
      new HttpError(
        403,
        "sandbox0_permission_denied",
        "Sandbox0 denied the deployment API key.",
      ),
    ),
    {
      status: 403,
      code: "sandbox0_permission_denied",
      message: "Sandbox0 denied the deployment API key.",
      retryable: true,
    },
  );
});

test("does not normalize unrelated Codex stream failures", () => {
  assert.equal(
    codexNativeStreamFailure(
      new HttpError(401, "authentication_required", "Sign in required."),
    ),
    undefined,
  );
  assert.equal(
    codexNativeStreamFailure(
      new HttpError(503, "sandbox0_unavailable", "Sandbox0 is unavailable."),
    ),
    undefined,
  );
  assert.equal(codexNativeStreamFailure(new Error("broken stream")), undefined);
});
