import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionForkPlan,
  SESSION_HARD_TTL_SECONDS,
  SESSION_WORKSPACE_ROOT,
} from "./environment-blueprint";

test("builds an isolated session from one Environment revision", () => {
  const plan = buildSessionForkPlan({
    environment: {
      id: "env-default",
      teamId: "team-sandpi-labs",
      revision: 12,
      templateId: "coding-agent",
      rootfsSnapshotId: "snap-rootfs-12",
      workspaceVolumeId: "vol-seed",
      credentialRevision: 4,
      codingAgent: {
        harness: "codex",
        label: "Codex",
        status: "connected",
        account: "dev@sandbox0.ai",
      },
      networkPolicy: {
        mode: "restricted",
        allowedDomains: ["github.com"],
        logDeniedRequests: true,
      },
    },
    sessionName: "implement-login",
  });

  assert.equal(plan.hardTtlSeconds, 30 * 24 * 60 * 60);
  assert.equal(plan.teamId, "team-sandpi-labs");
  assert.equal(plan.credentialRevision, 4);
  assert.equal(plan.workspaceRoot, SESSION_WORKSPACE_ROOT);
  assert.deepEqual(
    plan.steps.map((step) => step.sdkMethod),
    [
      "client.volumes.fork",
      "client.sandboxes.claim",
      "sandbox.updateNetworkPolicy",
      "sandbox.createSession",
    ],
  );
  assert.equal(plan.steps[1].input.hardTtl, SESSION_HARD_TTL_SECONDS);
  assert.equal(plan.steps[1].input.mountPoint, "/workspace");
  assert.equal(plan.steps[3].input.cwd, "/workspace");
  assert.equal(plan.steps[3].input.harness, "codex");
});
