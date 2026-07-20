import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  CodexMcpInventory,
  CodexMcpServer,
  CodexMcpServerInput,
} from "@/harnesses/codex/environment-tools";
import type { Environment, NetworkPolicy } from "@/lib/types";
import type { CodexService } from "@/server/harnesses/codex/service";
import { HttpError } from "@/server/http-error";
import type {
  EnvironmentRuntimeRecord,
  RuntimeAdapter,
  Sandbox0NetworkPolicy,
} from "@/server/runtime/types";
import type {
  SandpiStore,
  StoredEnvironmentRuntime,
} from "@/server/store";
import { CodexMcpIntegrationService } from "./integration-service";
import type {
  CodexMcpNativeEventIdentity,
  EnvironmentMcpIntegration,
  EnvironmentMcpOAuthFlow,
  EnvironmentMcpIntegrationStore,
} from "./integration-store";

const USER_ID = "user-test";
const ENVIRONMENT_ID = "environment-test";
const NOW = new Date("2026-07-20T00:00:00.000Z");

const runtimeRecord: EnvironmentRuntimeRecord = {
  id: ENVIRONMENT_ID,
  sandboxId: "sandbox-test",
  workspaceVolumeId: "volume-test",
  supervisorSessionId: "supervisor-test",
  runtimeGeneration: 1,
  decoder: {
    supervisorCursor: 0,
    tailBase64: "",
    runtimeGeneration: 1,
  },
};

const notificationRuntime = {
  ...runtimeRecord,
  attemptId: "attempt-test",
  desiredState: "running",
  observedState: "running",
  version: 1,
  lifecyclePolicyVersion: 1,
} as StoredEnvironmentRuntime;

interface HarnessOptions {
  inventory: CodexMcpInventory;
  integrations: EnvironmentMcpIntegration[];
  flows?: EnvironmentMcpOAuthFlow[];
  userPolicy?: NetworkPolicy;
  callbackPublicUrl?: string;
  authorizationUrl?: string;
  policyErrors?: Error[];
  oauthPersistenceError?: Error;
  oauthCorrelationError?: Error;
  persistErrors?: Error[];
  discardErrors?: Error[];
  beforeOAuthLoginResponse?: () => Promise<void>;
}

function createHarness(options: HarnessOptions) {
  const policyErrors = [...(options.policyErrors ?? [])];
  const persistErrors = [...(options.persistErrors ?? [])];
  const discardErrors = [...(options.discardErrors ?? [])];
  const state = {
    inventory: structuredClone(options.inventory),
    integrations: structuredClone(options.integrations).map((value) => ({
      ...value,
      bindingEnabled:
        value.bindingEnabled ?? Boolean(value.credentialSourceRef),
      version: value.version ?? 1,
    })),
    flows: structuredClone(options.flows ?? []),
    sequence: [] as string[],
    sourceCreates: [] as Array<{ name: string; headers: Record<string, string> }>,
    sourceUpdates: [] as Array<{ name: string; headers: Record<string, string> }>,
    sourceDeletes: [] as string[],
    appliedPolicies: [] as Sandbox0NetworkPolicy[],
    policyAttempts: 0,
    mcpLockEntries: 0,
    lifecycleLockEntries: 0,
    integrationUpserts: [] as Array<
      Parameters<EnvironmentMcpIntegrationStore["upsertIntegration"]>[1]
    >,
    integrationMarks: [] as Array<{
      serverName: string;
      update: Parameters<EnvironmentMcpIntegrationStore["markIntegration"]>[3];
    }>,
    runtimeIntegrationMarks: [] as Array<{
      serverName: string;
      update: Parameters<
        EnvironmentMcpIntegrationStore["markIntegrationForRuntime"]
      >[2];
    }>,
    oauthCreates: [] as Array<
      Parameters<EnvironmentMcpIntegrationStore["createOAuthFlow"]>[1]
    >,
    oauthMarks: [] as Array<{
      flowId: string;
      update: Parameters<EnvironmentMcpIntegrationStore["markOAuthFlow"]>[3];
    }>,
    oauthRuntimeMarks: [] as Array<{
      serverName: string;
      update: Parameters<
        EnvironmentMcpIntegrationStore["markOAuthFlowForRuntime"]
      >[2];
    }>,
    oauthCorrelations: [] as Array<{
      flowId: string;
      input: Parameters<
        EnvironmentMcpIntegrationStore["markOAuthFlowCorrelation"]
      >[3];
    }>,
    oauthNativeEvents: new Map<
      string,
      {
        serverName: string;
        success: boolean;
        disposition: string;
      }
    >(),
    oauthTerminalApplies: 0,
    callbackConfigurations: [] as Array<{
      port: number;
      url: string;
    }>,
    oauthCorrelationThreads: [] as string[],
    oauthReleasedThreads: [] as string[],
    oauthLoginInputs: [] as Array<{
      name: string;
      nativeThreadId: string;
      runtimeGeneration: number;
      attemptId?: string;
      scopes: string[];
      timeoutSecs: number;
    }>,
    oauthPersistencePreflights: 0,
    oauthPersists: 0,
    oauthDiscards: [] as string[],
    codexEnableInputs: [] as Array<{ name: string; enabled: boolean }>,
    codexUpdateInputs: [] as Array<{
      name: string;
      server: CodexMcpServerInput;
    }>,
    codexDeleteInputs: [] as string[],
  };

  const integrationStore = {
    async listIntegrations() {
      return structuredClone(state.integrations);
    },
    async getIntegration(
      _userId: string,
      _environmentId: string,
      serverName: string,
    ) {
      return requireIntegration(state.integrations, serverName);
    },
    async getIntegrationForRuntime(
      _environmentId: string,
      serverName: string,
    ) {
      return requireIntegration(state.integrations, serverName);
    },
    async upsertIntegration(
      _userId: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["upsertIntegration"]
      >[1],
    ) {
      state.sequence.push(`upsert:${input.serverName}`);
      state.integrationUpserts.push(structuredClone(input));
      const existing = state.integrations.find(
        (integration) => integration.serverName === input.serverName,
      );
      const next: EnvironmentMcpIntegration = {
        environmentId: input.environmentId,
        serverName: input.serverName,
        authMode: input.authMode,
        endpointFingerprint: input.endpointFingerprint,
        destinationDomain: input.destinationDomain,
        destinationPath: input.destinationPath,
        lifecycleStatus: input.lifecycleStatus ?? "provisioning",
        credentialStatus:
          input.credentialStatus ??
          (input.authMode === "none" ? "not-required" : "missing"),
        bindingEnabled: input.bindingEnabled ?? false,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? NOW,
        updatedAt: NOW,
        ...(input.presetId ? { presetId: input.presetId } : {}),
        ...(input.credentialSourceRef
          ? { credentialSourceRef: input.credentialSourceRef }
          : {}),
        ...(input.credentialBindingRef
          ? { credentialBindingRef: input.credentialBindingRef }
          : {}),
        ...(input.credentialHeaderName
          ? { credentialHeaderName: input.credentialHeaderName }
          : {}),
        ...(input.credentialValueTemplate
          ? { credentialValueTemplate: input.credentialValueTemplate }
          : {}),
        ...(input.lastError ? { lastError: input.lastError } : {}),
        ...(existing?.authMode === input.authMode &&
        existing.endpointFingerprint === input.endpointFingerprint &&
        existing.oauthConfigFingerprint
          ? { oauthConfigFingerprint: existing.oauthConfigFingerprint }
          : {}),
      };
      replaceIntegration(state.integrations, next);
      return structuredClone(next);
    },
    async markIntegration(
      _userId: string,
      _environmentId: string,
      serverName: string,
      update: Parameters<
        EnvironmentMcpIntegrationStore["markIntegration"]
      >[3],
    ) {
      state.sequence.push(`mark:${update.lifecycleStatus}`);
      state.integrationMarks.push({
        serverName,
        update: structuredClone(update),
      });
      return updateIntegration(
        state.integrations,
        serverName,
        update,
      );
    },
    async markIntegrationForRuntime(
      _environmentId: string,
      serverName: string,
      update: Parameters<
        EnvironmentMcpIntegrationStore["markIntegrationForRuntime"]
      >[2],
    ) {
      state.runtimeIntegrationMarks.push({
        serverName,
        update: structuredClone(update),
      });
      return updateIntegration(state.integrations, serverName, update);
    },
    async beginStaticCredentialPending(
      _userId: string,
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["beginStaticCredentialPending"]
      >[3],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      assertIntegrationVersion(current, input.expectedVersion);
      assert.equal(
        current.endpointFingerprint,
        input.expectedEndpointFingerprint,
      );
      assert.equal(
        current.credentialSourceRef ?? null,
        input.expectedCurrentSourceRef,
      );
      state.sequence.push(`begin-pending:${input.pendingSourceRef}`);
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "updating",
        pendingCredentialSourceRef: input.pendingSourceRef,
        pendingCredentialBindingRef: input.pendingBindingRef,
        pendingCredentialHeaderName: input.credentialHeaderName,
        pendingCredentialValueTemplate: input.credentialValueTemplate,
        lastError: null,
      });
    },
    async promoteStaticCredentialPending(
      _userId: string,
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["promoteStaticCredentialPending"]
      >[3],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      assertIntegrationVersion(current, input.expectedVersion);
      assert.equal(
        current.endpointFingerprint,
        input.expectedEndpointFingerprint,
      );
      assert.equal(
        current.pendingCredentialSourceRef,
        input.expectedPendingSourceRef,
      );
      state.sequence.push(`promote-pending:${input.expectedPendingSourceRef}`);
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "updating",
        credentialStatus: "configured",
        credentialSourceRef: current.pendingCredentialSourceRef,
        credentialBindingRef: current.pendingCredentialBindingRef,
        credentialHeaderName: current.pendingCredentialHeaderName,
        credentialValueTemplate: current.pendingCredentialValueTemplate,
        bindingEnabled: input.bindingEnabled,
        retiringCredentialSourceRef: current.credentialSourceRef,
        pendingCredentialSourceRef: undefined,
        pendingCredentialBindingRef: undefined,
        pendingCredentialHeaderName: undefined,
        pendingCredentialValueTemplate: undefined,
        lastError: null,
      });
    },
    async abortStaticCredentialPending(
      _userId: string,
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["abortStaticCredentialPending"]
      >[3],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      assertIntegrationVersion(current, input.expectedVersion);
      assert.equal(
        current.pendingCredentialSourceRef,
        input.expectedPendingSourceRef,
      );
      state.sequence.push(`abort-pending:${input.expectedPendingSourceRef}`);
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "active",
        credentialStatus: current.credentialSourceRef
          ? current.credentialStatus
          : "missing",
        pendingCredentialSourceRef: undefined,
        pendingCredentialBindingRef: undefined,
        pendingCredentialHeaderName: undefined,
        pendingCredentialValueTemplate: undefined,
        lastError: null,
      });
    },
    async abortStaticCredentialPendingForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore[
          "abortStaticCredentialPendingForRuntime"
        ]
      >[2],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      if (
        current.version !== input.expectedVersion ||
        current.pendingCredentialSourceRef !==
          input.expectedPendingSourceRef
      ) {
        return undefined;
      }
      state.sequence.push(`abort-pending:${input.expectedPendingSourceRef}`);
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "active",
        credentialStatus: current.credentialSourceRef
          ? current.credentialStatus
          : "missing",
        pendingCredentialSourceRef: undefined,
        pendingCredentialBindingRef: undefined,
        pendingCredentialHeaderName: undefined,
        pendingCredentialValueTemplate: undefined,
        lastError: null,
      });
    },
    async finishStaticCredentialRetirement(
      _userId: string,
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["finishStaticCredentialRetirement"]
      >[3],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      assertIntegrationVersion(current, input.expectedVersion);
      assert.equal(
        current.retiringCredentialSourceRef,
        input.expectedRetiringSourceRef,
      );
      state.sequence.push(
        `finish-retiring:${input.expectedRetiringSourceRef}`,
      );
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "active",
        retiringCredentialSourceRef: undefined,
        lastError: null,
      });
    },
    async finishStaticCredentialRetirementForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore[
          "finishStaticCredentialRetirementForRuntime"
        ]
      >[2],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      if (
        current.version !== input.expectedVersion ||
        current.retiringCredentialSourceRef !==
          input.expectedRetiringSourceRef
      ) {
        return undefined;
      }
      state.sequence.push(
        `finish-retiring:${input.expectedRetiringSourceRef}`,
      );
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "active",
        retiringCredentialSourceRef: undefined,
        lastError: null,
      });
    },
    async markStaticCredentialActiveForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore[
          "markStaticCredentialActiveForRuntime"
        ]
      >[2],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      if (
        current.version !== input.expectedVersion ||
        current.endpointFingerprint !== input.expectedEndpointFingerprint ||
        (current.credentialSourceRef ?? null) !== input.expectedSourceRef ||
        current.bindingEnabled !== input.expectedBindingEnabled
      ) {
        return undefined;
      }
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "active",
        credentialStatus: current.credentialSourceRef
          ? "configured"
          : "missing",
        lastError: null,
      });
    },
    async setBindingEnabled(
      _userId: string,
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["setBindingEnabled"]
      >[3],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      assertIntegrationVersion(current, input.expectedVersion);
      assert.equal(
        current.endpointFingerprint,
        input.expectedEndpointFingerprint,
      );
      assert.equal(
        current.credentialSourceRef ?? null,
        input.expectedSourceRef,
      );
      state.sequence.push(`set-binding:${input.enabled}`);
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "updating",
        bindingEnabled: input.enabled,
        lastError: null,
      });
    },
    async clearStaticCredentialForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["clearStaticCredentialForRuntime"]
      >[2],
    ) {
      const current = requireIntegration(state.integrations, serverName);
      assertIntegrationVersion(current, input.expectedVersion);
      assert.equal(current.credentialSourceRef, input.expectedSourceRef);
      state.sequence.push(`clear-source:${input.expectedSourceRef}`);
      return updateIntegration(state.integrations, serverName, {
        lifecycleStatus: "active",
        credentialStatus: "missing",
        credentialSourceRef: undefined,
        credentialBindingRef: undefined,
        credentialHeaderName: undefined,
        credentialValueTemplate: undefined,
        bindingEnabled: false,
        lastError: null,
      });
    },
    async deleteIntegration(
      _userId: string,
      _environmentId: string,
      serverName: string,
    ) {
      const index = state.integrations.findIndex(
        (value) => value.serverName === serverName,
      );
      assert.notEqual(index, -1);
      state.integrations.splice(index, 1);
    },
    async listActiveStaticIntegrationsForRuntime() {
      return structuredClone(
        state.integrations.filter(
          (integration) =>
            (integration.authMode === "bearer" ||
              integration.authMode === "header") &&
            integration.lifecycleStatus !== "deleting" &&
            (integration.credentialStatus === "configured" ||
              integration.credentialStatus === "authorized") &&
            integration.bindingEnabled === true &&
            integration.credentialSourceRef &&
            integration.credentialBindingRef,
        ),
      );
    },
    async listReconciliationCandidatesForRuntime() {
      return structuredClone(
        state.integrations.filter(
          (integration) =>
            integration.lifecycleStatus !== "active" ||
            integration.credentialStatus === "error" ||
            integration.pendingCredentialSourceRef ||
            integration.retiringCredentialSourceRef,
        ),
      );
    },
    async createOAuthFlow(
      _userId: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["createOAuthFlow"]
      >[1],
    ) {
      state.oauthCreates.push(structuredClone(input));
      const blocking = state.flows.find((flow) => isBlockingFlow(flow));
      if (blocking) {
        return { flow: structuredClone(blocking), created: false as const };
      }
      updateIntegration(state.integrations, input.serverName, {
        lifecycleStatus: "updating",
        credentialStatus: "authorizing",
        oauthConfigFingerprint: input.configFingerprint,
        lastError: null,
      });
      const flow: EnvironmentMcpOAuthFlow = {
        id: `oauth-flow-${state.flows.length + 1}`,
        environmentId: input.environmentId,
        serverName: input.serverName,
        configFingerprint: input.configFingerprint,
        endpointFingerprint: input.expectedEndpointFingerprint,
        status: "starting",
        expiresAt: input.expiresAt,
        createdAt: NOW,
        updatedAt: NOW,
      };
      state.flows.push(flow);
      return { flow: structuredClone(flow), created: true as const };
    },
    async findActiveOAuthFlow() {
      return structuredClone(
        state.flows.find((flow) => isActiveFlow(flow)),
      );
    },
    async findBlockingOAuthFlow() {
      return structuredClone(
        state.flows.find((flow) => isBlockingFlow(flow)),
      );
    },
    async markOAuthFlow(
      _userId: string,
      _environmentId: string,
      flowId: string,
      update: Parameters<
        EnvironmentMcpIntegrationStore["markOAuthFlow"]
      >[3],
    ) {
      state.oauthMarks.push({ flowId, update: structuredClone(update) });
      const current = state.flows.find((flow) => flow.id === flowId);
      if (
        !current ||
        !isActiveFlow(current) ||
        (update.status === "awaiting_user" && !current.nativeThreadId) ||
        (update.expectedConfigFingerprint &&
          current.configFingerprint !== update.expectedConfigFingerprint)
      ) {
        throw new HttpError(
          404,
          "mcp_oauth_flow_not_found",
          "MCP OAuth flow not found.",
        );
      }
      return updateFlow(state.flows, flowId, update);
    },
    async findActiveOAuthFlowForRuntime() {
      return structuredClone(
        state.flows.find((flow) => isActiveFlow(flow)),
      );
    },
    async findLatestOAuthFlowForRuntime(
      _environmentId: string,
      serverName: string,
    ) {
      return structuredClone(
        [...state.flows]
          .reverse()
          .find((flow) => flow.serverName === serverName),
      );
    },
    async findOAuthFlowByNativeThreadForRuntime(
      _environmentId: string,
      serverName: string,
      nativeThreadId: string,
    ) {
      return structuredClone(
        [...state.flows]
          .reverse()
          .find(
            (flow) =>
              flow.serverName === serverName &&
              flow.nativeThreadId === nativeThreadId,
          ),
      );
    },
    async markOAuthFlowCorrelation(
      _userId: string,
      _environmentId: string,
      flowId: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore["markOAuthFlowCorrelation"]
      >[3],
    ) {
      state.oauthCorrelations.push({
        flowId,
        input: structuredClone(input),
      });
      if (options.oauthCorrelationError) {
        throw options.oauthCorrelationError;
      }
      const flow = state.flows.find((candidate) => candidate.id === flowId);
      if (
        !flow ||
        flow.status !== "starting" ||
        flow.configFingerprint !== input.expectedConfigFingerprint ||
        flow.endpointFingerprint !== input.expectedEndpointFingerprint
      ) {
        throw new HttpError(
          409,
          "mcp_oauth_correlation_changed",
          "The MCP OAuth flow or native thread correlation changed.",
        );
      }
      flow.nativeThreadId = input.nativeThreadId;
      flow.nativeRuntime = structuredClone(input.runtime);
      flow.expiresAt = input.expiresAt;
      flow.updatedAt = NOW;
      return structuredClone(flow);
    },
    async markOAuthFlowCorrelationForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore[
          "markOAuthFlowCorrelationForRuntime"
        ]
      >[2],
    ) {
      const flow = state.flows.find(
        (candidate) =>
          candidate.id === input.flowId &&
          candidate.serverName === serverName &&
          candidate.status === "starting" &&
          candidate.configFingerprint ===
            input.expectedConfigFingerprint &&
          candidate.endpointFingerprint ===
            input.expectedEndpointFingerprint,
      );
      if (!flow) return undefined;
      flow.nativeThreadId = input.nativeThreadId;
      flow.nativeRuntime = structuredClone(input.runtime);
      flow.expiresAt = input.expiresAt;
      flow.updatedAt = NOW;
      return structuredClone(flow);
    },
    async markOAuthFlowForRuntime(
      _environmentId: string,
      serverName: string,
      update: Parameters<
        EnvironmentMcpIntegrationStore["markOAuthFlowForRuntime"]
      >[2],
    ) {
      state.oauthRuntimeMarks.push({
        serverName,
        update: structuredClone(update),
      });
      const flow = state.flows.find(
        (candidate) =>
          candidate.serverName === serverName &&
          isActiveFlow(candidate) &&
          candidate.configFingerprint ===
            update.expectedConfigFingerprint &&
          candidate.endpointFingerprint ===
            update.expectedEndpointFingerprint,
      );
      if (!flow) return undefined;
      const current = requireIntegration(state.integrations, serverName);
      if (
        current.authMode !== "oauth" ||
        current.oauthConfigFingerprint !== flow.configFingerprint ||
        current.endpointFingerprint !== flow.endpointFingerprint
      ) {
        return undefined;
      }
      const updated = updateFlow(state.flows, flow.id, update);
      updateIntegration(state.integrations, serverName, {
        lifecycleStatus:
          update.status === "completed" ? "active" : "error",
        credentialStatus:
          update.status === "completed" ? "authorized" : "error",
        lastError: update.error,
      });
      return updated;
    },
    async hasOAuthNativeEventForRuntime(
      _environmentId: string,
      event: CodexMcpNativeEventIdentity,
    ) {
      return state.oauthNativeEvents.has(oauthEventKey(event));
    },
    async recordOAuthNativeEventForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore[
          "recordOAuthNativeEventForRuntime"
        ]
      >[2],
    ) {
      const key = oauthEventKey(input.event);
      if (state.oauthNativeEvents.has(key)) return "duplicate" as const;
      state.oauthNativeEvents.set(key, {
        serverName,
        success: input.success,
        disposition: input.disposition,
      });
      return "recorded" as const;
    },
    async applyOAuthNativeTerminalEventForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore[
          "applyOAuthNativeTerminalEventForRuntime"
        ]
      >[2],
    ) {
      const key = oauthEventKey(input.event);
      if (state.oauthNativeEvents.has(key)) {
        return { disposition: "duplicate" as const };
      }
      const flow = state.flows.find(
        (candidate) =>
          candidate.serverName === serverName &&
          candidate.nativeThreadId === input.nativeThreadId,
      );
      const current = state.integrations.find(
        (candidate) => candidate.serverName === serverName,
      );
      const nativeRuntime = flow?.nativeRuntime;
      const attemptId = input.event.attemptId ?? "";
      if (
        !flow ||
        !isActiveFlowAt(flow, input.occurredAt) ||
        nativeRuntime?.runtimeGeneration !==
          input.event.runtimeGeneration ||
        (nativeRuntime.attemptId ?? "") !== attemptId ||
        flow.configFingerprint !== input.expectedConfigFingerprint ||
        flow.endpointFingerprint !==
          input.expectedEndpointFingerprint ||
        current?.authMode !== "oauth" ||
        current.oauthConfigFingerprint !== flow.configFingerprint ||
        current.endpointFingerprint !== flow.endpointFingerprint
      ) {
        return { disposition: "stale" as const };
      }
      state.oauthTerminalApplies += 1;
      state.oauthNativeEvents.set(key, {
        serverName,
        success: input.success,
        disposition: "applied",
      });
      const updated = updateFlow(state.flows, flow.id, {
        status: input.success ? "completed" : "failed",
        error: input.error,
      });
      updateIntegration(state.integrations, serverName, {
        lifecycleStatus: input.success ? "active" : "error",
        credentialStatus: input.success ? "authorized" : "error",
        lastError: input.error,
      });
      return { disposition: "applied" as const, flow: updated };
    },
    async getOAuthFlow(
      _userId: string,
      _environmentId: string,
      flowId: string,
    ) {
      const flow = state.flows.find((value) => value.id === flowId);
      assert.ok(flow, `Missing test OAuth flow ${flowId}`);
      return structuredClone(flow);
    },
    async expireOAuthFlows() {
      for (const flow of state.flows) {
        if (
          isActiveFlow(flow) &&
          flow.expiresAt.getTime() <= Date.now()
        ) {
          updateFlow(state.flows, flow.id, {
            status: "expired",
            error: "MCP OAuth authorization expired.",
          });
        }
      }
    },
    async listCancelledOAuthFlowsForRuntime() {
      return structuredClone(
        state.flows.filter(
          (flow) =>
            (flow.status === "cancelled" || flow.status === "expired") &&
            !flow.cleanupCompletedAt,
        ),
      );
    },
    async listOAuthThreadCleanupForRuntime(environmentId?: string) {
      return structuredClone(
        state.flows.filter(
          (flow) =>
            (!environmentId || flow.environmentId === environmentId) &&
            isTerminalFlow(flow) &&
            Boolean(flow.nativeThreadId) &&
            !flow.nativeThreadCleanupCompletedAt,
        ),
      );
    },
    async markOAuthThreadCleanupCompletedForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore[
          "markOAuthThreadCleanupCompletedForRuntime"
        ]
      >[2],
    ) {
      const flow = state.flows.find(
        (value) =>
          value.id === input.flowId &&
          value.serverName === serverName &&
          value.nativeThreadId === input.nativeThreadId &&
          value.configFingerprint === input.expectedConfigFingerprint &&
          value.endpointFingerprint === input.expectedEndpointFingerprint &&
          isTerminalFlow(value),
      );
      if (!flow) return undefined;
      flow.nativeThreadCleanupCompletedAt = NOW;
      return structuredClone(flow);
    },
    async markOAuthFlowCleanupCompletedForRuntime(
      _environmentId: string,
      serverName: string,
      input: Parameters<
        EnvironmentMcpIntegrationStore[
          "markOAuthFlowCleanupCompletedForRuntime"
        ]
      >[2],
    ) {
      const flow = state.flows.find(
        (value) =>
          value.id === input.flowId &&
          value.serverName === serverName &&
          value.configFingerprint === input.expectedConfigFingerprint &&
          value.endpointFingerprint === input.expectedEndpointFingerprint,
      );
      if (!flow) return undefined;
      flow.cleanupCompletedAt = NOW;
      const current = state.integrations.find(
        (integration) => integration.serverName === serverName,
      );
      if (
        current?.authMode === "oauth" &&
        current.oauthConfigFingerprint === flow.configFingerprint &&
        current.endpointFingerprint === flow.endpointFingerprint
      ) {
        updateIntegration(state.integrations, serverName, {
          lifecycleStatus:
            current.lifecycleStatus === "deleting"
              ? "deleting"
              : "active",
          credentialStatus: "missing",
          oauthConfigFingerprint: undefined,
          lastError: null,
        });
      }
      return structuredClone(flow);
    },
  } as unknown as EnvironmentMcpIntegrationStore;

  const storedRuntime = {
    ...runtimeRecord,
    attemptId: "attempt-test",
    desiredState: "running",
    observedState: "running",
    version: 1,
    lifecyclePolicyVersion: 1,
  } as StoredEnvironmentRuntime;
  const store = {
    async getEnvironmentRuntime() {
      return storedRuntime;
    },
    async environmentRuntime() {
      return storedRuntime;
    },
    async getEnvironmentById() {
      return {
        id: ENVIRONMENT_ID,
        networkPolicy:
          options.userPolicy ?? ({
            mode: "block-all",
            domainExceptions: [],
          } satisfies NetworkPolicy),
      } as Environment;
    },
    async withEnvironmentMcpMutationLock(
      _environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      state.mcpLockEntries += 1;
      state.sequence.push("mcp-lock");
      return { acquired: true as const, value: await operation() };
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (lockedStore?: SandpiStore) => Promise<unknown>,
    ) {
      state.lifecycleLockEntries += 1;
      state.sequence.push("lifecycle-lock");
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
  } as unknown as SandpiStore;

  const runtime = {
    async createStaticHeaderCredentialSource(input: {
      name: string;
      headers: Record<string, string>;
    }) {
      state.sequence.push("create-source");
      state.sourceCreates.push(structuredClone(input));
      return { name: input.name, resolverKind: "static_headers" as const };
    },
    async updateStaticHeaderCredentialSource(input: {
      name: string;
      headers: Record<string, string>;
    }) {
      state.sequence.push("update-source");
      state.sourceUpdates.push(structuredClone(input));
      return { name: input.name, resolverKind: "static_headers" as const };
    },
    async deleteCredentialSource(sourceRef: string) {
      state.sequence.push("delete-source");
      state.sourceDeletes.push(sourceRef);
    },
    async applyEnvironmentSandboxNetworkPolicy(
      _runtime: EnvironmentRuntimeRecord,
      policy: Sandbox0NetworkPolicy,
    ) {
      state.sequence.push("apply-policy");
      state.policyAttempts += 1;
      const error = policyErrors.shift();
      if (error) throw error;
      state.appliedPolicies.push(structuredClone(policy));
    },
    async ensureEnvironmentMcpOAuthCallbackService() {
      return {
        serviceId: "mcp-oauth-callback",
        port: 43_419,
        publicUrl:
          options.callbackPublicUrl ??
          "https://callback.sandbox.example/",
      };
    },
  } as unknown as RuntimeAdapter;

  const codex = {
    async withAdvisoryLockStore<T>(
      _store: SandpiStore,
      operation: () => Promise<T>,
    ) {
      return operation();
    },
    async listEnvironmentMcpServers() {
      return structuredClone(state.inventory);
    },
    async testEnvironmentMcpServer() {
      return structuredClone(state.inventory);
    },
    async environmentRuntimeForMcp() {
      return storedRuntime;
    },
    requireEnvironmentMcpOAuthPersistence() {
      state.oauthPersistencePreflights += 1;
      if (options.oauthPersistenceError) {
        throw options.oauthPersistenceError;
      }
    },
    async configureEnvironmentMcpOAuthCallback(input: {
      port: number;
      url: string;
    }) {
      state.callbackConfigurations.push({
        port: input.port,
        url: input.url,
      });
    },
    async createEnvironmentMcpOAuthCorrelationThread() {
      const nativeThreadId = `oauth-thread-${state.oauthCorrelationThreads.length + 1}`;
      state.oauthCorrelationThreads.push(nativeThreadId);
      return {
        nativeThreadId,
        runtime: storedRuntime,
      };
    },
    async beginEnvironmentMcpOAuthLogin(input: {
      environmentId: string;
      name: string;
      nativeThreadId: string;
      runtime: StoredEnvironmentRuntime;
      scopes: string[];
      timeoutSecs: number;
    }) {
      state.oauthLoginInputs.push({
        name: input.name,
        nativeThreadId: input.nativeThreadId,
        runtimeGeneration: input.runtime.runtimeGeneration,
        attemptId: input.runtime.attemptId,
        scopes: structuredClone(input.scopes),
        timeoutSecs: input.timeoutSecs,
      });
      await options.beforeOAuthLoginResponse?.();
      return {
        authorizationUrl:
          options.authorizationUrl ??
          "https://identity.example/authorize?state=browser-only",
        runtime: input.runtime,
      };
    },
    async releaseEnvironmentMcpOAuthCorrelationThread(
      _runtime: StoredEnvironmentRuntime,
      nativeThreadId: string,
    ) {
      state.oauthReleasedThreads.push(nativeThreadId);
    },
    async persistEnvironmentMcpOAuthCredential() {
      state.oauthPersists += 1;
      const error = persistErrors.shift();
      if (error) throw error;
    },
    async discardEnvironmentMcpOAuthCredential(
      _runtime: StoredEnvironmentRuntime,
      name: string,
    ) {
      state.oauthDiscards.push(name);
      const error = discardErrors.shift();
      if (error) throw error;
    },
    async logoutEnvironmentMcpServer(input: { name: string }) {
      state.oauthDiscards.push(input.name);
      return structuredClone(state.inventory);
    },
    async setEnvironmentMcpServerEnabled(input: {
      name: string;
      enabled: boolean;
    }) {
      state.sequence.push(`codex-enable:${input.enabled}`);
      state.codexEnableInputs.push(structuredClone(input));
      const server = requireServer(state.inventory, input.name);
      replaceServer(state.inventory, { ...server, enabled: input.enabled });
      return structuredClone(state.inventory);
    },
    async updateEnvironmentMcpServer(input: {
      name: string;
      server: CodexMcpServerInput;
    }) {
      state.sequence.push(`codex-update:${input.server.enabled}`);
      state.codexUpdateInputs.push(structuredClone(input));
      const current = requireServer(state.inventory, input.name);
      replaceServer(state.inventory, {
        ...current,
        ...input.server,
        name: input.name,
        managed: true,
      });
      return structuredClone(state.inventory);
    },
    async deleteEnvironmentMcpServer(input: { name: string }) {
      state.codexDeleteInputs.push(input.name);
      state.inventory.servers = state.inventory.servers.filter(
        (server) => server.name !== input.name,
      );
      return structuredClone(state.inventory);
    },
  } as unknown as CodexService;

  const service = new CodexMcpIntegrationService(
    store,
    integrationStore,
    runtime,
    codex,
    { warn() {} },
  );
  return { service, state };
}

test("first static key creation exposes the secret only to Runtime and composes all bindings", async () => {
  const secret = "test-secret-never-persist";
  const primary = remoteServer({
    name: "primary",
    url: "https://primary.example/mcp",
  });
  const existing = integration({
    serverName: "existing",
    url: "https://existing.example/mcp",
    authMode: "header",
    credentialSourceRef: "source-existing",
    credentialBindingRef: "binding-existing",
    credentialHeaderName: "X-API-Key",
    credentialValueTemplate: "{{ .token }}",
    credentialStatus: "configured",
  });
  const missing = integration({
    serverName: primary.name,
    url: primary.url!,
    authMode: "bearer",
    credentialStatus: "missing",
  });
  const { service, state } = createHarness({
    inventory: { servers: [primary] },
    integrations: [existing, missing],
    userPolicy: {
      mode: "block-all",
      domainExceptions: ["existing.example", "primary.example"],
    },
  });

  const inventory = await service.putEnvironmentMcpCredential({
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: primary.name,
    credential: {
      method: "bearer",
      secret,
    },
  });

  assert.equal(state.sourceCreates.length, 1);
  assert.deepEqual(state.sourceCreates[0]?.headers, { token: secret });
  assert.equal(state.sourceUpdates.length, 0);
  const stored = requireIntegration(state.integrations, primary.name);
  assert.equal(stored.credentialHeaderName, "Authorization");
  assert.equal(stored.credentialValueTemplate, "Bearer {{ .token }}");
  assert.equal(stored.credentialStatus, "configured");

  const bindings = state.appliedPolicies[0]?.credentialBindings ?? [];
  assert.deepEqual(
    new Set(bindings.map((binding) => binding.ref)),
    new Set(["binding-existing", stored.credentialBindingRef!]),
  );
  assert.equal(
    inventory.servers.find((server) => server.name === primary.name)
      ?.credentialState,
    "key-configured",
  );
  assert.doesNotMatch(
    JSON.stringify({
      integrationUpserts: state.integrationUpserts,
      integrations: state.integrations,
      appliedPolicies: state.appliedPolicies,
      inventory,
    }),
    new RegExp(secret),
  );
});

test("static credential rotation publishes a new immutable source before retiring the old one", async () => {
  const server = remoteServer({
    name: "rotating",
    url: "https://rotate.example/mcp",
  });
  const current = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "bearer",
    credentialSourceRef: "source-old",
    credentialBindingRef: "binding-old",
    credentialHeaderName: "Authorization",
    credentialValueTemplate: "Bearer {{ .token }}",
    credentialStatus: "configured",
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [current],
  });

  await service.putEnvironmentMcpCredential({
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: server.name,
    credential: {
      method: "bearer",
      secret: "replacement-secret",
    },
  });

  assert.equal(state.sourceCreates.length, 1);
  const newSourceRef = state.sourceCreates[0]!.name;
  assert.notEqual(newSourceRef, "source-old");
  assert.deepEqual(state.sourceUpdates, []);
  assert.deepEqual(state.sourceDeletes, ["source-old"]);
  assert.ok(
    state.sequence.indexOf("create-source") <
      state.sequence.indexOf("apply-policy"),
  );
  assert.ok(
    state.sequence.indexOf("apply-policy") <
      state.sequence.indexOf("delete-source"),
  );
  const binding = state.appliedPolicies[0]?.credentialBindings?.find(
    (value) => value.sourceRef === newSourceRef,
  );
  assert.ok(binding, "new immutable source was not published");
  const stored = requireIntegration(state.integrations, server.name);
  assert.equal(stored.credentialSourceRef, newSourceRef);
  assert.equal(stored.retiringCredentialSourceRef, undefined);
  assert.equal(stored.lifecycleStatus, "active");
});

test("configuring a disabled server retains its source without publishing a binding", async () => {
  const server = remoteServer({
    name: "disabled-key",
    url: "https://disabled.example/mcp",
    enabled: false,
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [
      integration({
        serverName: server.name,
        url: server.url!,
        authMode: "header",
        credentialStatus: "missing",
        bindingEnabled: false,
      }),
    ],
  });

  await service.putEnvironmentMcpCredential({
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: server.name,
    credential: {
      method: "header",
      headerName: "X-API-Key",
      secret: "disabled-secret",
    },
  });

  const stored = requireIntegration(state.integrations, server.name);
  assert.equal(stored.credentialStatus, "configured");
  assert.equal(stored.bindingEnabled, false);
  assert.ok(stored.credentialSourceRef);
  assert.deepEqual(
    state.appliedPolicies[0]?.credentialBindings ?? [],
    [],
  );
  assert.deepEqual(state.sourceDeletes, []);
});

test("endpoint drift rejects static credential reuse before Runtime mutation", async () => {
  const server = remoteServer({
    name: "drifted",
    url: "https://new-destination.example/mcp",
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [
      integration({
        serverName: server.name,
        url: "https://old-destination.example/mcp",
        authMode: "bearer",
        credentialSourceRef: "source-old",
        credentialBindingRef: "binding-old",
        credentialHeaderName: "Authorization",
        credentialValueTemplate: "Bearer {{ .token }}",
        credentialStatus: "configured",
      }),
    ],
  });

  await assert.rejects(
    service.putEnvironmentMcpCredential({
      userId: USER_ID,
      environmentId: ENVIRONMENT_ID,
      name: server.name,
      credential: {
        method: "bearer",
        secret: "must-not-be-used",
      },
    }),
    (error) =>
      error instanceof HttpError &&
      error.code === "mcp_credential_definition_mismatch",
  );
  assert.deepEqual(state.sourceCreates, []);
  assert.deepEqual(state.sourceUpdates, []);
  assert.deepEqual(state.integrationUpserts, []);
  assert.deepEqual(state.appliedPolicies, []);
});

test("static credential deletion detaches policy before deleting its source", async () => {
  const server = remoteServer({
    name: "removable",
    url: "https://remove.example/mcp",
  });
  const configured = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "bearer",
    credentialSourceRef: "source-remove",
    credentialBindingRef: "binding-remove",
    credentialHeaderName: "Authorization",
    credentialValueTemplate: "Bearer {{ .token }}",
    credentialStatus: "configured",
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [configured],
    userPolicy: {
      mode: "block-all",
      domainExceptions: ["remove.example"],
    },
  });

  await service.deleteEnvironmentMcpCredential({
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: server.name,
  });

  assert.ok(
    state.sequence.indexOf("apply-policy") <
      state.sequence.indexOf("delete-source"),
  );
  assert.deepEqual(state.sourceDeletes, ["source-remove"]);
  assert.deepEqual(
    state.appliedPolicies[0]?.credentialBindings ?? [],
    [],
  );
  assert.equal(
    requireIntegration(state.integrations, server.name).credentialStatus,
    "missing",
  );
});

test("retrying enable replays policy convergence after an apply failure", async () => {
  const policyError = new Error("Sandbox0 policy update failed");
  const server = remoteServer({
    name: "retry-enable",
    url: "https://retry-enable.example/mcp",
    enabled: false,
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [
      integration({
        serverName: server.name,
        url: server.url!,
        authMode: "bearer",
        credentialSourceRef: "source-enable",
        credentialBindingRef: "binding-enable",
        credentialHeaderName: "Authorization",
        credentialValueTemplate: "Bearer {{ .token }}",
        credentialStatus: "configured",
        bindingEnabled: false,
      }),
    ],
    policyErrors: [policyError],
  });
  const input = {
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: server.name,
    enabled: true,
  };

  await assert.rejects(
    service.setEnvironmentMcpServerEnabled(input),
    (error: unknown) => error === policyError,
  );
  let stored = requireIntegration(state.integrations, server.name);
  assert.equal(stored.bindingEnabled, true);
  assert.equal(stored.lifecycleStatus, "error");

  await service.setEnvironmentMcpServerEnabled(input);

  stored = requireIntegration(state.integrations, server.name);
  assert.equal(state.policyAttempts, 2);
  assert.equal(state.codexEnableInputs.length, 2);
  assert.equal(stored.bindingEnabled, true);
  assert.equal(stored.lifecycleStatus, "active");
  assert.equal(
    state.appliedPolicies[0]?.credentialBindings?.[0]?.sourceRef,
    "source-enable",
  );
});

test("retrying a definition update replays unfinished policy convergence", async () => {
  const policyError = new Error("Sandbox0 policy update failed");
  const server = remoteServer({
    name: "retry-definition",
    url: "https://retry-definition.example/mcp",
    enabled: true,
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [
      integration({
        serverName: server.name,
        url: server.url!,
        authMode: "bearer",
        credentialSourceRef: "source-definition",
        credentialBindingRef: "binding-definition",
        credentialHeaderName: "Authorization",
        credentialValueTemplate: "Bearer {{ .token }}",
        credentialStatus: "configured",
        bindingEnabled: true,
      }),
    ],
    policyErrors: [policyError],
  });
  const input = {
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: server.name,
    server: serverDefinition(server, { enabled: false }),
    metadata: { authMode: "bearer" as const },
  };

  await assert.rejects(
    service.updateEnvironmentMcpServer(input),
    (error: unknown) => error === policyError,
  );
  let stored = requireIntegration(state.integrations, server.name);
  assert.equal(stored.bindingEnabled, false);
  assert.equal(stored.lifecycleStatus, "error");

  await service.updateEnvironmentMcpServer(input);

  stored = requireIntegration(state.integrations, server.name);
  assert.equal(state.policyAttempts, 2);
  assert.equal(state.codexUpdateInputs.length, 2);
  assert.equal(stored.bindingEnabled, false);
  assert.equal(stored.lifecycleStatus, "active");
  assert.deepEqual(
    state.appliedPolicies[0]?.credentialBindings ?? [],
    [],
  );
});

test("listing MCP servers replays pending and retiring static credential work", async () => {
  const pendingServer = remoteServer({
    name: "pending-on-list",
    url: "https://pending-on-list.example/mcp",
  });
  const retiringServer = remoteServer({
    name: "retiring-on-list",
    url: "https://retiring-on-list.example/mcp",
  });
  const { service, state } = createHarness({
    inventory: { servers: [pendingServer, retiringServer] },
    integrations: [
      integration({
        serverName: pendingServer.name,
        url: pendingServer.url!,
        authMode: "bearer",
        credentialStatus: "configured",
        lifecycleStatus: "updating",
        credentialSourceRef: "source-stable",
        credentialBindingRef: "binding-stable",
        credentialHeaderName: "Authorization",
        credentialValueTemplate: "Bearer {{ .token }}",
        bindingEnabled: true,
        pendingCredentialSourceRef: "source-pending",
        pendingCredentialBindingRef: "binding-pending",
        pendingCredentialHeaderName: "Authorization",
        pendingCredentialValueTemplate: "Bearer {{ .token }}",
      }),
      integration({
        serverName: retiringServer.name,
        url: retiringServer.url!,
        authMode: "header",
        credentialStatus: "configured",
        lifecycleStatus: "updating",
        credentialSourceRef: "source-current",
        credentialBindingRef: "binding-current",
        credentialHeaderName: "X-API-Key",
        credentialValueTemplate: "{{ .token }}",
        bindingEnabled: true,
        retiringCredentialSourceRef: "source-retiring",
      }),
    ],
  });

  const inventory = await service.listEnvironmentMcpServers(
    USER_ID,
    ENVIRONMENT_ID,
  );

  assert.deepEqual(state.sourceDeletes, [
    "source-pending",
    "source-retiring",
  ]);
  assert.ok(
    state.sequence.indexOf("abort-pending:source-pending") <
      state.sequence.indexOf("apply-policy"),
  );
  assert.ok(
    state.sequence.indexOf("apply-policy") <
      state.sequence.indexOf("finish-retiring:source-retiring"),
  );
  const pending = requireIntegration(
    state.integrations,
    pendingServer.name,
  );
  assert.equal(pending.pendingCredentialSourceRef, undefined);
  assert.equal(pending.credentialSourceRef, "source-stable");
  assert.equal(pending.lifecycleStatus, "active");
  const retiring = requireIntegration(
    state.integrations,
    retiringServer.name,
  );
  assert.equal(retiring.retiringCredentialSourceRef, undefined);
  assert.equal(retiring.credentialSourceRef, "source-current");
  assert.equal(retiring.lifecycleStatus, "active");
  assert.deepEqual(
    new Set(
      state.appliedPolicies[0]?.credentialBindings?.map(
        (binding) => binding.sourceRef,
      ),
    ),
    new Set(["source-stable", "source-current"]),
  );
  assert.deepEqual(
    inventory.servers.map((server) => server.credentialState),
    ["key-configured", "key-configured"],
  );
});

test("OAuth login returns the browser URL without persisting it in flow state", async () => {
  const server = remoteServer({
    name: "oauth-server",
    url: "https://oauth-mcp.example/mcp",
    scopes: ["repo:read"],
  });
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "missing",
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
  });

  const result = await service.startEnvironmentMcpOAuth({
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: server.name,
    login: {},
  });

  assert.equal(
    result.authorizationUrl,
    "https://identity.example/authorize?state=browser-only",
  );
  assert.equal(state.oauthCreates.length, 1);
  assert.equal(state.oauthPersistencePreflights, 1);
  assert.equal(state.flows[0]?.status, "awaiting_user");
  assert.equal(state.flows[0]?.nativeThreadId, "oauth-thread-1");
  assert.deepEqual(state.flows[0]?.nativeRuntime, {
    runtimeGeneration: 1,
    attemptId: "attempt-test",
  });
  assert.equal(state.oauthLoginInputs[0]?.nativeThreadId, "oauth-thread-1");
  assert.doesNotMatch(
    JSON.stringify({
      createInputs: state.oauthCreates,
      markInputs: state.oauthMarks,
      storedFlows: state.flows,
    }),
    /authorizationUrl|identity\.example|browser-only/,
  );
  assert.deepEqual(state.callbackConfigurations, [
    {
      port: 43_419,
      url: "https://callback.sandbox.example/callback/",
    },
  ]);
});

test("OAuth releases an unpersisted correlation Thread before native login submission", async () => {
  const server = remoteServer({
    name: "correlation-persist-failure",
    url: "https://correlation-persist-failure.example/mcp",
  });
  const correlationError = new Error(
    "OAuth correlation persistence failed",
  );
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [
      integration({
        serverName: server.name,
        url: server.url!,
        authMode: "oauth",
        credentialStatus: "missing",
      }),
    ],
    oauthCorrelationError: correlationError,
  });

  await assert.rejects(
    service.startEnvironmentMcpOAuth({
      userId: USER_ID,
      environmentId: ENVIRONMENT_ID,
      name: server.name,
      login: {},
    }),
    (error: unknown) => error === correlationError,
  );

  assert.deepEqual(state.oauthCorrelationThreads, ["oauth-thread-1"]);
  assert.deepEqual(state.oauthReleasedThreads, ["oauth-thread-1"]);
  assert.equal(state.oauthCorrelations.length, 1);
  assert.deepEqual(state.oauthLoginInputs, []);
  assert.deepEqual(state.oauthDiscards, []);
  assert.equal(state.flows[0]?.nativeThreadId, undefined);
  assert.equal(state.flows[0]?.status, "failed");
});

test("OAuth correlation expiry covers native timeout, admission, and quarantine safety", async () => {
  const server = remoteServer({
    name: "correlation-expiry",
    url: "https://correlation-expiry.example/mcp",
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [
      integration({
        serverName: server.name,
        url: server.url!,
        authMode: "oauth",
        credentialStatus: "missing",
      }),
    ],
  });
  const startedAt = Date.now();

  await service.startEnvironmentMcpOAuth({
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: server.name,
    login: {},
  });

  const login = state.oauthLoginInputs[0];
  const correlation = state.oauthCorrelations[0];
  assert.ok(login);
  assert.ok(correlation);
  const requiredTtlMs =
    login.timeoutSecs * 1_000 + 160_000 + 200_000;
  assert.ok(
    correlation.input.expiresAt.getTime() - startedAt >= requiredTtlMs,
    "correlation quarantine must cover login, admission, and safety budgets",
  );
  assert.ok(
    correlation.input.expiresAt.getTime() >=
      state.oauthCreates[0]!.expiresAt.getTime(),
    "persisted correlation must refresh, not shorten, the flow expiry",
  );
});

test("rejects an unsafe callback service URL before starting native OAuth", async () => {
  const server = remoteServer({
    name: "unsafe-callback",
    url: "https://oauth-mcp.example/mcp",
  });
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "missing",
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
    callbackPublicUrl: "http://callback.sandbox.example/",
  });

  await assert.rejects(
    service.startEnvironmentMcpOAuth({
      userId: USER_ID,
      environmentId: ENVIRONMENT_ID,
      name: server.name,
      login: {},
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "sandbox0_mcp_oauth_callback_url_invalid",
  );

  assert.equal(state.flows[0]?.status, "failed");
  assert.deepEqual(state.callbackConfigurations, []);
  assert.deepEqual(state.oauthLoginInputs, []);
  assert.deepEqual(state.oauthDiscards, []);
});

test("quarantines a flow when native OAuth returns an unsafe authorization URL", async () => {
  const server = remoteServer({
    name: "unsafe-authorization",
    url: "https://oauth-mcp.example/mcp",
  });
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "missing",
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
    authorizationUrl: "http://identity.example/authorize?token=unsafe",
  });

  await assert.rejects(
    service.startEnvironmentMcpOAuth({
      userId: USER_ID,
      environmentId: ENVIRONMENT_ID,
      name: server.name,
      login: {},
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "codex_mcp_oauth_authorization_url_invalid",
  );

  assert.equal(state.oauthLoginInputs.length, 1);
  assert.equal(state.flows[0]?.status, "cancelled");
  assert.deepEqual(state.oauthDiscards, [server.name]);
  assert.doesNotMatch(
    JSON.stringify({
      flows: state.flows,
      marks: state.oauthMarks,
    }),
    /identity\.example|token=unsafe/,
  );
});

test("rejects OAuth scope overrides before persistence preflight or flow creation", async () => {
  const server = remoteServer({
    name: "scoped-oauth",
    url: "https://oauth-mcp.example/mcp",
    scopes: ["repo:read"],
  });
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [
      integration({
        serverName: server.name,
        url: server.url!,
        authMode: "oauth",
        credentialStatus: "missing",
      }),
    ],
  });

  await assert.rejects(
    service.startEnvironmentMcpOAuth({
      userId: USER_ID,
      environmentId: ENVIRONMENT_ID,
      name: server.name,
      login: { scopes: ["repo:write"] },
    }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "mcp_oauth_scope_definition_mismatch",
  );

  assert.equal(state.oauthPersistencePreflights, 0);
  assert.deepEqual(state.oauthCreates, []);
  assert.deepEqual(state.callbackConfigurations, []);
  assert.deepEqual(state.oauthLoginInputs, []);
});

test("OAuth definition update and delete remain blocked by cancelled-flow quarantine", async () => {
  for (const operation of ["update", "delete"] as const) {
    const server = remoteServer({
      name: `quarantine-${operation}`,
      url: `https://quarantine-${operation}.example/mcp`,
    });
    const configFingerprint =
      operation === "update" ? "2".repeat(64) : "3".repeat(64);
    const association = integration({
      serverName: server.name,
      url: server.url!,
      authMode: "oauth",
      credentialStatus: "authorizing",
      oauthConfigFingerprint: configFingerprint,
    });
    const flow: EnvironmentMcpOAuthFlow = {
      id: `flow-quarantine-${operation}`,
      environmentId: ENVIRONMENT_ID,
      serverName: server.name,
      configFingerprint,
      endpointFingerprint: association.endpointFingerprint,
      status: "awaiting_user",
      nativeThreadId: `thread-quarantine-${operation}`,
      nativeRuntime: {
        runtimeGeneration: notificationRuntime.runtimeGeneration,
        attemptId: notificationRuntime.attemptId,
      },
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { service, state } = createHarness({
      inventory: { servers: [server] },
      integrations: [association],
      flows: [flow],
    });
    const mutate = () =>
      operation === "update"
        ? service.updateEnvironmentMcpServer({
            userId: USER_ID,
            environmentId: ENVIRONMENT_ID,
            name: server.name,
            server: serverDefinition(server, {
              url: `https://changed-${operation}.example/mcp`,
            }),
            metadata: {
              authMode: "oauth",
              networkApproved: true,
            },
          })
        : service.deleteEnvironmentMcpServer({
            userId: USER_ID,
            environmentId: ENVIRONMENT_ID,
            name: server.name,
          });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        mutate(),
        (error: unknown) =>
          error instanceof HttpError &&
          error.code === "mcp_oauth_flow_quarantined",
      );
    }

    assert.equal(state.flows[0]?.status, "cancelled");
    assert.ok(state.flows[0]?.cleanupCompletedAt);
    assert.ok(state.flows[0]?.nativeThreadCleanupCompletedAt);
    assert.deepEqual(state.oauthDiscards, [server.name]);
    assert.deepEqual(state.oauthReleasedThreads, [
      flow.nativeThreadId,
    ]);
    assert.equal(state.oauthMarks.length, 1);
    assert.deepEqual(state.codexUpdateInputs, []);
    assert.deepEqual(state.codexDeleteInputs, []);
    assert.equal(state.inventory.servers[0]?.url, server.url);
    const stored = requireIntegration(
      state.integrations,
      server.name,
    );
    assert.equal(stored.authMode, "oauth");
    assert.equal(
      stored.endpointFingerprint,
      association.endpointFingerprint,
    );
  }
});

test("strictly discards late OAuth success after cancellation or failure", async () => {
  for (const status of ["cancelled", "failed"] as const) {
    const server = remoteServer({
      name: `late-${status}`,
      url: `https://${status}.example/mcp`,
    });
    const association = integration({
      serverName: server.name,
      url: server.url!,
      authMode: "oauth",
      credentialStatus: status === "failed" ? "error" : "missing",
      oauthConfigFingerprint: "c".repeat(64),
    });
    const flow: EnvironmentMcpOAuthFlow = {
      id: `flow-${status}`,
      environmentId: ENVIRONMENT_ID,
      serverName: server.name,
      configFingerprint: "c".repeat(64),
      endpointFingerprint: association.endpointFingerprint,
      status,
      nativeThreadId: `thread-${status}`,
      nativeRuntime: {
        runtimeGeneration: runtimeRecord.runtimeGeneration,
        attemptId: "attempt-test",
      },
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const discardError =
      status === "cancelled"
        ? new Error("strict native discard failed")
        : undefined;
    const { service, state } = createHarness({
      inventory: { servers: [server] },
      integrations: [association],
      flows: [flow],
      discardErrors: discardError ? [discardError] : [],
    });
    const notification = {
      method: "mcpServer/oauthLogin/completed",
      params: {
        name: server.name,
        success: true,
        threadId: flow.nativeThreadId,
      },
    };
    const event = nativeOAuthEvent(status === "cancelled" ? 10 : 11);

    if (discardError) {
      await assert.rejects(
        service.handleCodexMcpNotification(
          ENVIRONMENT_ID,
          notificationRuntime,
          notification,
          event,
        ),
        (error: unknown) => error === discardError,
      );
    } else {
      await service.handleCodexMcpNotification(
        ENVIRONMENT_ID,
        notificationRuntime,
        notification,
        event,
      );
    }

    assert.deepEqual(state.oauthDiscards, [server.name]);
    assert.equal(state.oauthPersists, 0);
    assert.deepEqual(state.oauthRuntimeMarks, []);
  }
});

test("completed OAuth notification replay is a no-op for the same configuration", async () => {
  const server = remoteServer({
    name: "completed-replay",
    url: "https://completed.example/mcp",
  });
  const configFingerprint = "d".repeat(64);
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "authorized",
    oauthConfigFingerprint: configFingerprint,
  });
  const flow: EnvironmentMcpOAuthFlow = {
    id: "flow-completed",
    environmentId: ENVIRONMENT_ID,
    serverName: server.name,
    configFingerprint,
    endpointFingerprint: association.endpointFingerprint,
    status: "completed",
    nativeThreadId: "thread-completed",
    nativeRuntime: {
      runtimeGeneration: runtimeRecord.runtimeGeneration,
      attemptId: "attempt-test",
    },
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
    flows: [flow],
  });

  await service.handleCodexMcpNotification(
    ENVIRONMENT_ID,
    notificationRuntime,
    {
      method: "mcpServer/oauthLogin/completed",
      params: {
        name: server.name,
        success: true,
        threadId: flow.nativeThreadId,
      },
    },
    nativeOAuthEvent(20),
  );

  assert.equal(state.oauthPersists, 0);
  assert.deepEqual(state.oauthDiscards, []);
  assert.deepEqual(state.oauthRuntimeMarks, []);
  assert.equal(state.flows[0]?.status, "completed");
});

test("ordinary list and OAuth start requests reconcile terminal native Thread cleanup", async () => {
  for (const entrypoint of ["list", "start"] as const) {
    const server = remoteServer({
      name: `thread-cleanup-${entrypoint}`,
      url: `https://thread-cleanup-${entrypoint}.example/mcp`,
    });
    const configFingerprint =
      entrypoint === "list" ? "4".repeat(64) : "5".repeat(64);
    const association = integration({
      serverName: server.name,
      url: server.url!,
      authMode: "oauth",
      credentialStatus: "authorized",
      oauthConfigFingerprint: configFingerprint,
    });
    const terminal: EnvironmentMcpOAuthFlow = {
      id: `flow-thread-cleanup-${entrypoint}`,
      environmentId: ENVIRONMENT_ID,
      serverName: server.name,
      configFingerprint,
      endpointFingerprint: association.endpointFingerprint,
      status: "completed",
      nativeThreadId: `thread-cleanup-${entrypoint}`,
      nativeRuntime: {
        runtimeGeneration: notificationRuntime.runtimeGeneration,
        attemptId: notificationRuntime.attemptId,
      },
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { service, state } = createHarness({
      inventory: { servers: [server] },
      integrations: [association],
      flows: [terminal],
    });

    if (entrypoint === "list") {
      await service.listEnvironmentMcpServers(USER_ID, ENVIRONMENT_ID);
    } else {
      const started = await service.startEnvironmentMcpOAuth({
        userId: USER_ID,
        environmentId: ENVIRONMENT_ID,
        name: server.name,
        login: {},
      });
      assert.equal(started.status, "awaiting_user");
      assert.equal(state.flows[1]?.status, "awaiting_user");
    }

    assert.deepEqual(state.oauthReleasedThreads, [
      terminal.nativeThreadId,
    ]);
    assert.ok(state.flows[0]?.nativeThreadCleanupCompletedAt);
    assert.equal(
      state.oauthCorrelationThreads.length,
      entrypoint === "start" ? 1 : 0,
    );
  }
});

test("OAuth notification bypasses the MCP mutation lock and persists credential state", async () => {
  const server = remoteServer({
    name: "oauth-server",
    url: "https://oauth-mcp.example/mcp",
    authStatus: "oAuth",
    runtimeStatus: "unavailable",
    readiness: "failed",
  });
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "authorizing",
    oauthConfigFingerprint: "b".repeat(64),
  });
  const flow: EnvironmentMcpOAuthFlow = {
    id: "oauth-flow-active",
    environmentId: ENVIRONMENT_ID,
    serverName: server.name,
    configFingerprint: "b".repeat(64),
    endpointFingerprint: association.endpointFingerprint,
    status: "awaiting_user",
    nativeThreadId: "thread-active",
    nativeRuntime: {
      runtimeGeneration: runtimeRecord.runtimeGeneration,
      attemptId: "attempt-test",
    },
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
    flows: [flow],
  });

  await service.handleCodexMcpNotification(
    ENVIRONMENT_ID,
    notificationRuntime,
    {
      method: "mcpServer/oauthLogin/completed",
      params: {
        name: server.name,
        success: true,
        threadId: flow.nativeThreadId,
      },
    },
    nativeOAuthEvent(30),
  );
  assert.equal(state.oauthTerminalApplies, 1);
  assert.equal(state.oauthPersists, 1);
  assert.equal(
    requireIntegration(state.integrations, server.name).credentialStatus,
    "authorized",
  );
  assert.equal(
    state.mcpLockEntries,
    0,
    "native notification handling must not wait on the MCP mutation lock",
  );

  const inventory = await service.listEnvironmentMcpServers(
    USER_ID,
    ENVIRONMENT_ID,
  );
  assert.equal(state.mcpLockEntries, 1);
  const decorated = inventory.servers[0];
  assert.equal(decorated?.credentialState, "oauth-authorized");
  assert.equal(decorated?.readiness, "failed");
});

test("OAuth completion notifications require name, boolean success, and threadId", async () => {
  const server = remoteServer({
    name: "strict-shape",
    url: "https://strict-shape.example/mcp",
  });
  const configFingerprint = "e".repeat(64);
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "authorizing",
    oauthConfigFingerprint: configFingerprint,
  });
  const flow: EnvironmentMcpOAuthFlow = {
    id: "flow-strict-shape",
    environmentId: ENVIRONMENT_ID,
    serverName: server.name,
    configFingerprint,
    endpointFingerprint: association.endpointFingerprint,
    status: "awaiting_user",
    nativeThreadId: "thread-strict-shape",
    nativeRuntime: {
      runtimeGeneration: runtimeRecord.runtimeGeneration,
      attemptId: "attempt-test",
    },
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
    flows: [flow],
  });
  const malformed = [
    {
      serverName: server.name,
      success: true,
      threadId: flow.nativeThreadId,
    },
    { name: server.name, threadId: flow.nativeThreadId },
    { name: server.name, success: true },
  ];

  for (const [index, params] of malformed.entries()) {
    await service.handleCodexMcpNotification(
      ENVIRONMENT_ID,
      notificationRuntime,
      {
        method: "mcpServer/oauthLogin/completed",
        params,
      },
      nativeOAuthEvent(40 + index),
    );
  }

  assert.equal(state.oauthPersists, 0);
  assert.deepEqual(state.oauthDiscards, []);
  assert.equal(state.oauthTerminalApplies, 0);
  assert.equal(state.oauthNativeEvents.size, 0);
  assert.equal(state.flows[0]?.status, "awaiting_user");
});

test("OAuth completion is correlated to the exact native thread", async () => {
  const server = remoteServer({
    name: "strict-thread",
    url: "https://strict-thread.example/mcp",
  });
  const configFingerprint = "f".repeat(64);
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "authorizing",
    oauthConfigFingerprint: configFingerprint,
  });
  const flow: EnvironmentMcpOAuthFlow = {
    id: "flow-strict-thread",
    environmentId: ENVIRONMENT_ID,
    serverName: server.name,
    configFingerprint,
    endpointFingerprint: association.endpointFingerprint,
    status: "awaiting_user",
    nativeThreadId: "thread-current",
    nativeRuntime: {
      runtimeGeneration: runtimeRecord.runtimeGeneration,
      attemptId: "attempt-test",
    },
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
    flows: [flow],
  });

  await service.handleCodexMcpNotification(
    ENVIRONMENT_ID,
    notificationRuntime,
    {
      method: "mcpServer/oauthLogin/completed",
      params: {
        name: server.name,
        success: true,
        threadId: "thread-stale",
      },
    },
    nativeOAuthEvent(50),
  );

  assert.equal(state.oauthPersists, 0);
  assert.deepEqual(state.oauthDiscards, [server.name]);
  assert.equal(state.oauthTerminalApplies, 0);
  assert.notEqual(state.flows[0]?.status, "completed");
});

test("replaying one OAuth native event does not repeat credential persistence", async () => {
  const server = remoteServer({
    name: "event-replay",
    url: "https://event-replay.example/mcp",
  });
  const configFingerprint = "1".repeat(64);
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "authorizing",
    oauthConfigFingerprint: configFingerprint,
  });
  const flow: EnvironmentMcpOAuthFlow = {
    id: "flow-event-replay",
    environmentId: ENVIRONMENT_ID,
    serverName: server.name,
    configFingerprint,
    endpointFingerprint: association.endpointFingerprint,
    status: "awaiting_user",
    nativeThreadId: "thread-event-replay",
    nativeRuntime: {
      runtimeGeneration: runtimeRecord.runtimeGeneration,
      attemptId: "attempt-test",
    },
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const { service, state } = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
    flows: [flow],
  });
  const message = {
    method: "mcpServer/oauthLogin/completed",
    params: {
      name: server.name,
      success: true,
      threadId: flow.nativeThreadId,
    },
  };
  const event = nativeOAuthEvent(60);

  await service.handleCodexMcpNotification(
    ENVIRONMENT_ID,
    notificationRuntime,
    message,
    event,
  );
  await service.handleCodexMcpNotification(
    ENVIRONMENT_ID,
    notificationRuntime,
    message,
    event,
  );

  assert.equal(state.oauthPersists, 1);
  assert.equal(state.oauthTerminalApplies, 1);
  assert.equal(state.oauthNativeEvents.size, 1);
  assert.deepEqual(state.oauthDiscards, []);
  assert.equal(state.flows[0]?.status, "completed");
});

test("OAuth completion can win before the native login response", async () => {
  const server = remoteServer({
    name: "completion-race",
    url: "https://completion-race.example/mcp",
  });
  const association = integration({
    serverName: server.name,
    url: server.url!,
    authMode: "oauth",
    credentialStatus: "missing",
  });
  let completeBeforeResponse: () => Promise<void> = async () => {
    assert.fail("OAuth completion hook was not initialized.");
  };
  const harness = createHarness({
    inventory: { servers: [server] },
    integrations: [association],
    beforeOAuthLoginResponse: () => completeBeforeResponse(),
  });
  completeBeforeResponse = async () => {
    const flow = harness.state.flows[0];
    assert.ok(flow?.nativeThreadId);
    await harness.service.handleCodexMcpNotification(
      ENVIRONMENT_ID,
      notificationRuntime,
      {
        method: "mcpServer/oauthLogin/completed",
        params: {
          name: server.name,
          success: true,
          threadId: flow.nativeThreadId,
        },
      },
      nativeOAuthEvent(70),
    );
  };

  const result = await harness.service.startEnvironmentMcpOAuth({
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    name: server.name,
    login: {},
  });

  assert.equal(result.status, "completed");
  assert.equal(harness.state.flows[0]?.status, "completed");
  assert.equal(harness.state.oauthPersists, 1);
  assert.equal(harness.state.oauthTerminalApplies, 1);
});

function remoteServer(
  overrides: Partial<CodexMcpServer> & Pick<CodexMcpServer, "name" | "url">,
): CodexMcpServer {
  const { name, url, ...rest } = overrides;
  return {
    name,
    transport: "streamable-http",
    args: [],
    url,
    enabled: true,
    required: false,
    enabledTools: [],
    disabledTools: [],
    managed: true,
    authStatus: "notLoggedIn",
    runtimeStatus: "unavailable",
    readiness: "failed",
    toolCount: 0,
    resourceCount: 0,
    ...rest,
  };
}

function serverDefinition(
  server: CodexMcpServer,
  overrides: Partial<CodexMcpServerInput> = {},
): CodexMcpServerInput {
  return {
    transport: server.transport,
    command: server.command,
    args: [...server.args],
    url: server.url,
    enabled: server.enabled,
    required: server.required,
    startupTimeoutSec: server.startupTimeoutSec,
    toolTimeoutSec: server.toolTimeoutSec,
    defaultToolsApprovalMode: server.defaultToolsApprovalMode,
    scopes: server.scopes ? [...server.scopes] : undefined,
    enabledTools: [...server.enabledTools],
    disabledTools: [...server.disabledTools],
    ...overrides,
  };
}

function integration(input: {
  serverName: string;
  url: string;
  authMode: EnvironmentMcpIntegration["authMode"];
  credentialStatus: EnvironmentMcpIntegration["credentialStatus"];
  lifecycleStatus?: EnvironmentMcpIntegration["lifecycleStatus"];
  credentialSourceRef?: string;
  credentialBindingRef?: string;
  credentialHeaderName?: string;
  credentialValueTemplate?: string;
  bindingEnabled?: boolean;
  pendingCredentialSourceRef?: string;
  pendingCredentialBindingRef?: string;
  pendingCredentialHeaderName?: string;
  pendingCredentialValueTemplate?: string;
  retiringCredentialSourceRef?: string;
  oauthConfigFingerprint?: string;
  version?: number;
}): EnvironmentMcpIntegration {
  const url = new URL(input.url);
  url.hostname = url.hostname.toLowerCase();
  url.port = "";
  return {
    environmentId: ENVIRONMENT_ID,
    serverName: input.serverName,
    authMode: input.authMode,
    credentialSourceRef: input.credentialSourceRef,
    credentialBindingRef: input.credentialBindingRef,
    credentialHeaderName: input.credentialHeaderName,
    credentialValueTemplate: input.credentialValueTemplate,
    bindingEnabled:
      input.bindingEnabled ?? Boolean(input.credentialSourceRef),
    pendingCredentialSourceRef: input.pendingCredentialSourceRef,
    pendingCredentialBindingRef: input.pendingCredentialBindingRef,
    pendingCredentialHeaderName: input.pendingCredentialHeaderName,
    pendingCredentialValueTemplate:
      input.pendingCredentialValueTemplate,
    retiringCredentialSourceRef: input.retiringCredentialSourceRef,
    oauthConfigFingerprint: input.oauthConfigFingerprint,
    version: input.version ?? 1,
    endpointFingerprint: createHash("sha256")
      .update(url.toString())
      .digest("hex"),
    destinationDomain: url.hostname,
    destinationPath: url.pathname || "/",
    lifecycleStatus: input.lifecycleStatus ?? "active",
    credentialStatus: input.credentialStatus,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function requireIntegration(
  integrations: EnvironmentMcpIntegration[],
  serverName: string,
) {
  const found = integrations.find(
    (integration) => integration.serverName === serverName,
  );
  assert.ok(found, `Missing test integration ${serverName}`);
  return found;
}

function replaceIntegration(
  integrations: EnvironmentMcpIntegration[],
  next: EnvironmentMcpIntegration,
) {
  const index = integrations.findIndex(
    (integration) => integration.serverName === next.serverName,
  );
  if (index === -1) integrations.push(next);
  else integrations[index] = next;
}

function updateIntegration(
  integrations: EnvironmentMcpIntegration[],
  serverName: string,
  update: Partial<
    Omit<
      EnvironmentMcpIntegration,
      | "environmentId"
      | "serverName"
      | "createdAt"
      | "updatedAt"
      | "version"
      | "lastError"
    >
  > & { lastError?: string | null },
) {
  const current = requireIntegration(integrations, serverName);
  const { lastError, ...fields } = update;
  const next: EnvironmentMcpIntegration = {
    ...current,
    ...fields,
    version: (current.version ?? 0) + 1,
    ...(lastError === null
      ? { lastError: undefined }
      : lastError !== undefined
        ? { lastError }
        : {}),
    updatedAt: NOW,
  };
  replaceIntegration(integrations, next);
  return structuredClone(next);
}

function updateFlow(
  flows: EnvironmentMcpOAuthFlow[],
  flowId: string,
  update: {
    status: EnvironmentMcpOAuthFlow["status"];
    error?: string | null;
  },
) {
  const index = flows.findIndex((flow) => flow.id === flowId);
  assert.notEqual(index, -1, `Missing test OAuth flow ${flowId}`);
  const next: EnvironmentMcpOAuthFlow = {
    ...flows[index]!,
    status: update.status,
    ...(update.error === null
      ? { error: undefined }
      : update.error
        ? { error: update.error }
        : {}),
    updatedAt: NOW,
  };
  flows[index] = next;
  return structuredClone(next);
}

function assertIntegrationVersion(
  integration: EnvironmentMcpIntegration,
  expectedVersion: number,
) {
  assert.equal(integration.version, expectedVersion);
}

function isActiveFlow(flow: EnvironmentMcpOAuthFlow) {
  return (
    (flow.status === "starting" || flow.status === "awaiting_user") &&
    flow.expiresAt.getTime() > Date.now()
  );
}

function isActiveFlowAt(
  flow: EnvironmentMcpOAuthFlow,
  occurredAt: Date,
) {
  return (
    (flow.status === "starting" || flow.status === "awaiting_user") &&
    occurredAt.getTime() <= flow.expiresAt.getTime()
  );
}

function isTerminalFlow(flow: EnvironmentMcpOAuthFlow) {
  return (
    flow.status === "completed" ||
    flow.status === "failed" ||
    flow.status === "cancelled" ||
    flow.status === "expired"
  );
}

function isBlockingFlow(flow: EnvironmentMcpOAuthFlow) {
  return (
    isActiveFlow(flow) ||
    flow.status === "cancelled" ||
    (flow.status === "expired" && !flow.cleanupCompletedAt)
  );
}

function nativeOAuthEvent(
  supervisorSequence: number,
): CodexMcpNativeEventIdentity & { occurredAt: string } {
  return {
    runtimeGeneration: runtimeRecord.runtimeGeneration,
    supervisorSequence,
    recordIndex: 0,
    attemptId: "attempt-test",
    occurredAt: new Date().toISOString(),
  };
}

function oauthEventKey(event: CodexMcpNativeEventIdentity) {
  return [
    event.runtimeGeneration,
    event.supervisorSequence,
    event.recordIndex,
    event.attemptId ?? "",
  ].join(":");
}

function requireServer(inventory: CodexMcpInventory, name: string) {
  const server = inventory.servers.find((value) => value.name === name);
  assert.ok(server, `Missing test MCP server ${name}`);
  return server;
}

function replaceServer(
  inventory: CodexMcpInventory,
  next: CodexMcpServer,
) {
  const index = inventory.servers.findIndex(
    (server) => server.name === next.name,
  );
  assert.notEqual(index, -1, `Missing test MCP server ${next.name}`);
  inventory.servers[index] = next;
}
