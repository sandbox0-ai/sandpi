import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockEnvironment,
  createMockSession,
  mockPreferences,
} from "./mock-data";

test("binds the coding agent to an Environment and every derived Session", () => {
  const environment = createMockEnvironment({
    name: "Agent binding test",
  });
  const session = createMockSession(environment, {
    title: "Verify binding",
    prompt: "Verify the Environment coding agent binding.",
  });

  assert.equal(environment.codingAgent.harness, "codex");
  assert.equal(session.harness, environment.codingAgent.harness);
  assert.equal(session.harnessLabel, environment.codingAgent.label);
  assert.equal(session.environmentRevision, environment.revision);
  assert.equal(session.unread, false);
  assert.equal(session.pinned, false);
  assert.equal(session.archived, false);
  assert.equal(session.workspaceRoot, "/workspace");
  assert.equal("branch" in session, false);
  assert.equal("repository" in environment, false);
  assert.equal("initScript" in environment, false);
  assert.equal("sandbox0ConnectionId" in environment, false);
  assert.equal("sandbox0" in mockPreferences, false);
});

test("uses only a model exposed by the Environment harness mock", () => {
  const environment = createMockEnvironment({ name: "Model selection test" });
  const selected = createMockSession(environment, {
    title: "Selected model",
    prompt: "Use the selected model.",
    modelLabel: "GPT-5.2 Codex",
  });
  const fallback = createMockSession(environment, {
    title: "Unknown model",
    prompt: "Reject an unknown model.",
    modelLabel: "Not a native Codex model",
  });

  assert.equal(selected.modelLabel, "GPT-5.2 Codex");
  assert.equal(fallback.modelLabel, "GPT-5.2 Codex");
});
