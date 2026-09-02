import assert from "node:assert/strict";
import test from "node:test";

import { ENVIRONMENT_AGENT_IDS } from "@/lib/types";

import {
  AGENT_ADAPTERS,
  agentSessionIdempotencyKey,
  agentSessionName,
} from "./registry";

test("registers every v2 Environment agent exactly once", () => {
  assert.deepEqual(Object.keys(AGENT_ADAPTERS).sort(), [
    ...ENVIRONMENT_AGENT_IDS,
  ].sort());

  for (const agentId of ENVIRONMENT_AGENT_IDS) {
    const adapter = AGENT_ADAPTERS[agentId];
    assert.equal(adapter.id, agentId);
    assert.ok(adapter.command.length > 0);
    assert.equal(adapter.runtimeRecovery, "restart");
    assert.equal(adapter.capabilities.structuredAutomation, false);
  }
});

test("scopes native agent sessions to the Environment and agent", () => {
  assert.equal(agentSessionName("claude-code"), "sandpi-agent-claude-code");
  assert.equal(
    agentSessionIdempotencyKey("env-1", "pi"),
    "sandpi-agent-pi-env-1",
  );
});

test("keeps managed credentials outside the persistent RootFS", () => {
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    assert.ok(
      adapter.credentialProjection.ephemeralPath?.startsWith("/dev/shm/"),
    );
    assert.ok(
      !adapter.persistentStatePaths.includes(
        adapter.credentialProjection.ephemeralPath ?? "",
      ),
    );
  }
});
