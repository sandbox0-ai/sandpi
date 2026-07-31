import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../lib/api-client";
import {
  beginSessionCreation,
  failSessionCreation,
  isDefinitiveSessionCreationFailure,
  type SessionCreationGate,
} from "./session-creation";

test("admits only one synchronous Session creation", () => {
  const gate: SessionCreationGate = { active: false };
  const key = beginSessionCreation(gate, "same request");

  assert.match(key ?? "", /^session-create-/);
  assert.equal(beginSessionCreation(gate, "same request"), undefined);
  assert.equal(beginSessionCreation(gate, "another request"), undefined);
});

test("reuses only an ambiguously failed Session creation key", () => {
  const gate: SessionCreationGate = { active: false };
  const first = beginSessionCreation(gate, "same request");
  failSessionCreation(gate, false);
  const ambiguousRetry = beginSessionCreation(gate, "same request");
  assert.equal(ambiguousRetry, first);

  failSessionCreation(gate, true);
  const definitiveRetry = beginSessionCreation(gate, "same request");
  assert.notEqual(definitiveRetry, first);
});

test("classifies only conclusive client responses as definitive", () => {
  assert.equal(
    isDefinitiveSessionCreationFailure(
      new ApiError("Invalid request", { status: 400 }),
    ),
    true,
  );
  assert.equal(
    isDefinitiveSessionCreationFailure(
      new ApiError("Still running", {
        status: 409,
        code: "session_creation_in_progress",
      }),
    ),
    false,
  );
  assert.equal(
    isDefinitiveSessionCreationFailure(
      new ApiError("Gateway timeout", { status: 504 }),
    ),
    false,
  );
  assert.equal(
    isDefinitiveSessionCreationFailure(new TypeError("offline")),
    false,
  );
});
