import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockEnvironment,
  createMockSession,
  getMockBootstrap,
  mockEnvironmentAudit,
  mockEnvironmentMetrics,
  mockEnvironments,
  mockPreferences,
  mockSandpiPlans,
  mockSessions,
  mockTeamMemberships,
  mockTeams,
} from "./mock-data";

test("binds the coding agent to an Environment and every derived Session", () => {
  const environment = createMockEnvironment({
    teamId: "team-sandpi-labs",
    name: "Agent binding test",
  });
  const session = createMockSession(environment, {
    title: "Verify binding",
    prompt: "Verify the Environment coding agent binding.",
  });

  assert.equal(environment.codingAgent.harness, "codex");
  assert.equal(environment.teamId, "team-sandpi-labs");
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
    teamId: "team-sandpi-labs",
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

test("bootstraps one selected Team without exposing deployment credentials", () => {
  const bootstrap = getMockBootstrap("team-side-projects");
  const selectedEnvironment = bootstrap.environments.find(
    (environment) => environment.id === bootstrap.selectedEnvironmentId,
  );

  assert.equal(bootstrap.selectedTeamId, "team-side-projects");
  assert.equal(selectedEnvironment?.teamId, bootstrap.selectedTeamId);
  assert.equal(bootstrap.deployment.identity.provider, "sandpi-auth0");
  assert.equal(bootstrap.deployment.runtime.configurationScope, "deployment");
  assert.equal("apiHost" in bootstrap.deployment.runtime, false);
  assert.equal("apiKey" in bootstrap.deployment.runtime, false);
  assert.equal(mockTeams[0]?.billingAccount.billingCadence, "monthly");
  assert.equal("subscription" in (mockTeams[0] ?? {}), false);
  assert.deepEqual(
    mockSandpiPlans.map((plan) => plan.id),
    ["free", "pro", "max"],
  );
  assert.equal(bootstrap.viewerMemberships.length, 2);
  assert.equal(
    bootstrap.viewerMemberships.find(
      (membership) => membership.teamId === bootstrap.selectedTeamId,
    )?.planAssignment.planId,
    "pro",
  );
  assert.ok(
    mockTeamMemberships.every(
      (membership) => membership.planAssignment.quotas.weeklyExecution.window === "weekly",
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
});

test("models Environment Audit as the JSON-safe sdk-js signed event feed", () => {
  const environment = mockEnvironments[0];
  assert.ok(environment);
  assert.equal(mockEnvironmentAudit.events.length, 8);
  assert.equal(mockEnvironmentAudit.nextCursor, "mock-history-cursor");
  assert.ok(
    mockEnvironmentAudit.events.every(
      (event) =>
        event.schemaVersion === 2 &&
        event.sandboxId === environment.sandboxId &&
        event.integrity.signatureStatus === "verified" &&
        typeof event.occurredAt === "number" &&
        typeof event.ingestedAt === "number",
    ),
  );
  assert.equal(
    mockEnvironmentAudit.events.some(
      (event) => String(event.source) === "supervisor",
    ),
    false,
  );
  assert.deepEqual(
    [...new Set(mockEnvironmentAudit.events.map((event) => event.source))].sort(),
    ["cluster_gateway", "netd"],
  );

  const resumeEvents = mockEnvironmentAudit.events.filter(
    (event) => event.action === "sandbox.resume",
  );
  assert.equal(new Set(resumeEvents.map((event) => event.operationId)).size, 1);
  assert.deepEqual(
    resumeEvents.map((event) => event.phase),
    ["attempt", "result"],
  );
  assert.equal(resumeEvents.at(-1)?.outcome, "succeeded");
  const networkOperations = new Map<string, string[]>();
  for (const event of mockEnvironmentAudit.events.filter(
    (candidate) => candidate.eventType === "network_audit",
  )) {
    const phases = networkOperations.get(event.operationId) ?? [];
    phases.push(event.phase);
    networkOperations.set(event.operationId, phases);
  }
  assert.deepEqual([...networkOperations.values()], [
    ["attempt", "result"],
    ["attempt", "result"],
  ]);
  assert.equal(
    mockEnvironmentAudit.events.find((event) => event.action === "network.deny")
      ?.attributes?.reason,
    "l7_denied",
  );
});
