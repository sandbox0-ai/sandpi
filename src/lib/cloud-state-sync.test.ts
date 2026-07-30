import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeCloudEnvironments,
  mergeCloudSessions,
  reconcileCloudWorkspaceState,
} from "@/lib/cloud-state-sync";
import { getMockBootstrap } from "@/lib/mock-data";

test("cloud reconciliation preserves observed runtime state", () => {
  const bootstrap = getMockBootstrap();
  const environment = bootstrap.environments[0]!;
  const [merged] = mergeCloudEnvironments(
    [{ ...environment, sandboxState: "running" }],
    [{ ...environment, name: "Renamed elsewhere" }],
  );

  assert.equal(merged.name, "Renamed elsewhere");
  assert.equal(merged.sandboxState, "running");
});

test("cloud reconciliation preserves a newer local Session projection", () => {
  const session = getMockBootstrap().sessions[0]!;
  const [merged] = mergeCloudSessions(
    [{ ...session, status: "running", updatedAt: session.updatedAt + 1 }],
    [{ ...session, status: "waiting" }],
  );
  assert.equal(merged.status, "running");
});

test("cloud reconciliation keeps New Session open during a refresh", () => {
  const bootstrap = getMockBootstrap();
  const result = reconcileCloudWorkspaceState(
    {
      environments: bootstrap.environments,
      sessions: bootstrap.sessions,
      selectedEnvironmentId: bootstrap.environments[0]!.id,
      selectedSessionId: "",
    },
    {
      environments: bootstrap.environments,
      sessions: bootstrap.sessions,
    },
  );
  assert.equal(result.selectedSessionId, "");
});

test("cloud reconciliation leaves a remotely archived Session", () => {
  const bootstrap = getMockBootstrap();
  const selected = bootstrap.sessions.find(
    (session) => !session.archived,
  )!;
  const sessions = bootstrap.sessions.map((session) =>
    session.id === selected.id ? { ...session, archived: true } : session,
  );
  const result = reconcileCloudWorkspaceState(
    {
      environments: bootstrap.environments,
      sessions: bootstrap.sessions,
      selectedEnvironmentId: selected.environmentId,
      selectedSessionId: selected.id,
    },
    {
      environments: bootstrap.environments,
      sessions,
    },
  );
  assert.notEqual(result.selectedSessionId, selected.id);
});
