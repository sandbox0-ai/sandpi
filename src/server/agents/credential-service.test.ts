import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeAdapter } from "@/server/runtime/types";
import { SecretBox } from "@/server/secrets";
import type { SandpiStore } from "@/server/store";

import type { AgentCredentialStore } from "./credential-store";
import {
  AgentCredentialService,
  agentCredentialAssociatedData,
} from "./credential-service";

const secretBox = new SecretBox("native-agent-test-secret-with-at-least-32-bytes");

test("keeps the v1 Codex encryption context compatible", () => {
  assert.equal(
    agentCredentialAssociatedData("env-one", "codex"),
    "sandpi:codex:environment-credential:env-one",
  );
  assert.equal(
    agentCredentialAssociatedData("env-one", "claude-code"),
    "sandpi:claude-code:environment-credential:env-one",
  );
});

test("captures a first native Pi login and marks only its /dev/shm binding", async () => {
  const credentialJson = JSON.stringify({ openai: { type: "oauth" } });
  let replacement:
    | Parameters<AgentCredentialStore["replaceCredentialFromRuntime"]>[0]
    | undefined;
  let binding:
    | Parameters<AgentCredentialStore["markCredentialMaterialized"]>[0]
    | undefined;
  const credentialStore = {
    async getCredentialForRuntime() {
      return undefined;
    },
    async replaceCredentialFromRuntime(input: typeof replacement) {
      replacement = input;
      return {
        replaced: true as const,
        credential: {
          environmentId: "env-one",
          agentId: "pi" as const,
          sourceId: "credential-one",
          revision: 1,
          encrypted: input!.encrypted,
          metadata: {},
        },
      };
    },
    async markCredentialMaterialized(input: typeof binding) {
      binding = input;
    },
  } as unknown as AgentCredentialStore;
  const runtime = {
    mode: "sandbox0" as const,
    async readAgentCredential() {
      return credentialJson;
    },
  } as unknown as RuntimeAdapter;
  const service = new AgentCredentialService(
    {} as SandpiStore,
    credentialStore,
    runtime,
    secretBox,
    { warn() {} },
  );

  await service.syncOpenedRuntime(
    "env-one",
    "pi",
    {
      id: "env-one",
      sandboxId: "sandbox-one",
      runtimeGeneration: 3,
      decoder: {
        supervisorCursor: 0,
        tailBase64: "",
        runtimeGeneration: 3,
      },
    },
  );

  assert.equal(replacement?.agentId, "pi");
  assert.equal(replacement?.credentialType, "pi-native-auth-json");
  assert.equal(
    secretBox.decrypt(
      replacement!.encrypted,
      agentCredentialAssociatedData("env-one", "pi"),
    ),
    credentialJson,
  );
  assert.deepEqual(binding, {
    environmentId: "env-one",
    agentId: "pi",
    sourceId: "credential-one",
    sourceRevision: 1,
    nativeTargetPath: "/dev/shm/sandpi-pi-auth.json",
  });
});

test("a concurrent credential refresh reinstalls the published winner", async () => {
  const oldJson = JSON.stringify({ token: "old" });
  const winnerJson = JSON.stringify({ token: "winner" });
  const associatedData = agentCredentialAssociatedData(
    "env-one",
    "claude-code",
  );
  const installed: string[] = [];
  const stored = {
    environmentId: "env-one",
    agentId: "claude-code" as const,
    sourceId: "credential-old",
    revision: 1,
    encrypted: secretBox.encrypt(oldJson, associatedData),
    metadata: {},
  };
  const winner = {
    ...stored,
    sourceId: "credential-winner",
    revision: 2,
    encrypted: secretBox.encrypt(winnerJson, associatedData),
  };
  const credentialStore = {
    async getCredentialForRuntime() {
      return stored;
    },
    async replaceCredentialFromRuntime() {
      return { replaced: false as const, credential: winner };
    },
    async markCredentialMaterialized() {},
  } as unknown as AgentCredentialStore;
  const runtime = {
    mode: "sandbox0" as const,
    async readAgentCredential() {
      return JSON.stringify({ token: "local-refresh" });
    },
    async installAgentCredential(
      _runtime: unknown,
      _agentId: unknown,
      credentialJson: string,
    ) {
      installed.push(credentialJson);
    },
  } as unknown as RuntimeAdapter;
  const service = new AgentCredentialService(
    {} as SandpiStore,
    credentialStore,
    runtime,
    secretBox,
    { warn() {} },
  );

  await service.syncOpenedRuntime(
    "env-one",
    "claude-code",
    {
      id: "env-one",
      sandboxId: "sandbox-one",
      runtimeGeneration: 3,
      decoder: {
        supervisorCursor: 0,
        tailBase64: "",
        runtimeGeneration: 3,
      },
    },
  );

  assert.deepEqual(installed, [winnerJson]);
});
