import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockEnvironment,
  createMockSession,
  getMockBootstrap,
  mockEnvironmentMetrics,
  mockEnvironments,
  mockPreferences,
  mockSessions,
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
  assert.equal(environment.ownerId, session.owner?.id);
  assert.equal(environment.idlePauseTimeoutSeconds, 30 * 60);
  assert.equal(environment.sandboxMemoryMiB, 2 * 1024);
  assert.deepEqual(environment.workspaceBackup, {
    intervalSeconds: 0,
    retentionCount: 7,
  });
  assert.equal(session.harness, environment.codingAgent.harness);
  assert.equal(session.harnessLabel, environment.codingAgent.label);
  assert.equal(session.environmentRevision, environment.revision);
  assert.equal(session.unread, false);
  assert.equal(session.pinned, false);
  assert.equal(session.archived, false);
  assert.equal(environment.workspaceRoot, "/workspace");
  assert.equal("sandboxId" in session, false);
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
  const environment = createMockEnvironment({
    name: "Model selection test",
  });
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
  assert.equal(fallback.harnessState.modelId, "gpt-5.2-codex");
});

test("bootstraps one selected Environment without exposing deployment credentials", () => {
  const bootstrap = getMockBootstrap("env-side-projects");
  const selectedEnvironment = bootstrap.environments.find(
    (environment) => environment.id === bootstrap.selectedEnvironmentId,
  );

  assert.equal(selectedEnvironment?.id, "env-side-projects");
  assert.equal(selectedEnvironment?.ownerId, bootstrap.viewer.id);
  assert.equal(bootstrap.deployment.identity.provider, "sandpi-auth0");
  assert.equal(bootstrap.deployment.runtime.configurationScope, "deployment");
  assert.equal("apiHost" in bootstrap.deployment.runtime, false);
  assert.equal("apiKey" in bootstrap.deployment.runtime, false);
  assert.equal("teams" in bootstrap, false);
  assert.equal("viewerMemberships" in bootstrap, false);
  assert.equal("teamMemberships" in bootstrap, false);
  assert.equal("plans" in bootstrap, false);
});

test("keeps every mock Environment user-owned", () => {
  assert.ok(
    mockEnvironments.every(
      (environment) => environment.ownerId === "user-yan",
    ),
  );
  assert.ok(
    mockEnvironments.every(
      (environment) =>
        !("teamId" in environment) && !("visibility" in environment),
    ),
  );
});

test("keeps every mock Session on its Environment revision", () => {
  for (const session of mockSessions) {
    const environment = mockEnvironments.find(
      (candidate) => candidate.id === session.environmentId,
    );

    assert.ok(environment);
    assert.equal(session.environmentRevision, environment.revision);
  }
});

test("models network throughput with the sdk-js metric contract", () => {
  const metrics = mockEnvironmentMetrics;

  assert.ok(metrics);
  assert.equal(metrics.networkReceive.metric, "sandbox.network.io");
  assert.equal(metrics.networkReceive.statistic, "rate");
  assert.equal(metrics.networkReceive.unit, "bytes_per_second");
  assert.equal(metrics.networkReceive.dimensions?.direction, "receive");
  assert.equal(metrics.networkTransmit.dimensions?.direction, "transmit");
  assert.ok(metrics.networkReceive.segments.length > 1);
  assert.ok(metrics.networkReceive.segments.every((segment) => segment.points.length > 0));
  assert.deepEqual(metrics.pauseIntervals.map((interval) => interval.reason), [
    "idle",
  ]);
});
