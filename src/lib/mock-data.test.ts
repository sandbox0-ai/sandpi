import assert from "node:assert/strict";
import test from "node:test";

import { createMockEnvironment, createMockSession } from "./mock-data";

test("binds the coding agent to an Environment and every derived Session", () => {
  const environment = createMockEnvironment({
    name: "Agent binding test",
    repository: "sandbox0-ai/sandpi",
    branch: "main",
    sandbox0ConnectionId: "connection-private",
  });
  const session = createMockSession(environment, {
    title: "Verify binding",
    prompt: "Verify the Environment coding agent binding.",
  });

  assert.equal(environment.codingAgent.harness, "codex");
  assert.equal(session.harness, environment.codingAgent.harness);
  assert.equal(session.harnessLabel, environment.codingAgent.label);
  assert.equal(session.environmentRevision, environment.revision);
  assert.equal(environment.sandbox0ConnectionId, "connection-private");
  assert.equal(session.sandbox0ConnectionId, environment.sandbox0ConnectionId);
});
