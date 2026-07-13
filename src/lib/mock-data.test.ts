import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockEnvironment,
  createMockSession,
  mockPreferences,
} from "./mock-data";
import { getDefaultMockCodexModel } from "../harnesses/codex/models";

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
  assert.equal(session.harnessState.protocol, "codex-app-server");
  assert.equal("messages" in session, false);
  assert.equal("modelLabel" in session, false);
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
    modelId: "gpt-5.1-codex-max",
  });
  const fallback = createMockSession(environment, {
    title: "Unknown model",
    prompt: "Reject an unknown model.",
    modelId: "not-a-native-codex-model",
  });

  assert.equal(selected.harnessState.modelId, "gpt-5.1-codex-max");
  assert.equal(fallback.harnessState.modelId, getDefaultMockCodexModel().id);
});
