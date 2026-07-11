import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionForkPlan,
  SESSION_HARD_TTL_SECONDS,
} from "./environment-blueprint";

test("builds an isolated session from one Environment revision", () => {
  const plan = buildSessionForkPlan({
    environment: {
      id: "env-default",
      revision: 12,
      templateId: "coding-agent",
      rootfsSnapshotId: "snap-rootfs-12",
      workspaceVolumeId: "vol-seed",
      sandbox0ConnectionId: "connection-private",
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
  assert.equal(plan.credentialRevision, 4);
  assert.equal(plan.sandbox0ConnectionId, "connection-private");
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
  assert.equal(plan.steps[3].input.harness, "codex");
});
