import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type {
  CodexMcpCredentialInput,
  CodexMcpCredentialState,
  CodexMcpInventory,
  CodexMcpOAuthFlow,
  CodexMcpOAuthLoginInput,
  CodexMcpReadiness,
  CodexMcpRemoteAuthMethod,
  CodexMcpServer,
  CodexMcpServerInput,
  CodexMcpToolPolicyInput,
} from "@/harnesses/codex/environment-tools";
import {
  CODEX_MCP_PRESETS,
  isAggregatorMcpPreset,
  type CodexMcpPreset,
} from "@/harnesses/codex/mcp-catalog";
import type { NetworkPolicy } from "@/lib/types";
import { conflict, HttpError } from "@/server/http-error";
import {
  CODEX_MCP_OAUTH_CALLBACK_BASE_PATH,
  CODEX_MCP_OAUTH_CALLBACK_PORT,
  type EnvironmentRuntimeRecord,
  type RuntimeAdapter,
} from "@/server/runtime/types";
import {
  type CodexMcpNotificationHandler,
  type CodexService,
} from "@/server/harnesses/codex/service";
import type { CodexNativeEventIdentity } from "@/server/harnesses/codex/jsonl";
import type { StoredEnvironmentRuntime } from "@/server/store";
import { SandpiStore } from "@/server/store";
import {
  toSandbox0NetworkPolicy,
  type ManagedMcpToolPolicy,
} from "@/server/runtime/network-policy";
import {
  buildMcpCredentialValueTemplate,
  EnvironmentMcpIntegrationStore,
  type EnvironmentMcpIntegration,
  type EnvironmentMcpOAuthFlow,
  type McpIntegrationAuthMode,
  toManagedMcpCredentialBinding,
} from "./integration-store";

const MCP_OAUTH_NATIVE_TIMEOUT_SECONDS = 10 * 60;
// Runtime recovery/admission can consume 130 seconds before the 30-second
// native input submission budget begins. Keep another 200 seconds beyond that
// and Codex's own login timeout so a cancelled handle cannot outlive quarantine.
const MCP_OAUTH_REQUEST_ADMISSION_BUDGET_MS = 160_000;
const MCP_OAUTH_QUARANTINE_SAFETY_MS = 200_000;
const MCP_OAUTH_FLOW_TTL_MS =
  MCP_OAUTH_NATIVE_TIMEOUT_SECONDS * 1_000 +
  MCP_OAUTH_REQUEST_ADMISSION_BUDGET_MS +
  MCP_OAUTH_QUARANTINE_SAFETY_MS;
const MCP_MUTATION_LOCK_TIMEOUT_MS = 30_000;
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MANAGED_TEMPLATE =
  /^(?:([A-Za-z][A-Za-z0-9._~-]{0,31}) )?\{\{ \.token \}\}$/;

interface ServiceLogger {
  warn(fields: object, message: string): void;
}

export interface CodexMcpDefinitionMetadata {
  presetId?: string;
  authMode?: CodexMcpRemoteAuthMethod;
  networkApproved?: boolean;
}

interface RemoteEndpoint {
  canonicalUrl: string;
  fingerprint: string;
  domain: string;
  path: string;
}

/**
 * Coordinates Codex-native MCP definitions with write-only Sandbox0
 * credentials. It deliberately stores no remote MCP secret.
 */
export class CodexMcpIntegrationService
  implements CodexMcpNotificationHandler
{
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly lockScope = new AsyncLocalStorage<SandpiStore>();

  constructor(
    private readonly store: SandpiStore,
    private readonly integrations: EnvironmentMcpIntegrationStore,
    private readonly runtime: RuntimeAdapter,
    private readonly codex: CodexService,
    private readonly logger: ServiceLogger,
  ) {}

  async listEnvironmentMcpServers(userId: string, environmentId: string) {
    return this.withMutation(environmentId, () =>
      this.readEnvironmentMcpServers(userId, environmentId),
    );
  }

  async createEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
    server: CodexMcpServerInput;
    metadata: CodexMcpDefinitionMetadata;
  }) {
    return this.withMutation(input.environmentId, async () => {
      const prepared = prepareDefinition(
        input.name,
        input.server,
        input.metadata,
      );
      const inventory = await this.codex.createEnvironmentMcpServer({
        userId: input.userId,
        environmentId: input.environmentId,
        name: input.name,
        server: input.server,
      });
      if (prepared) {
        await this.integrations.upsertIntegration(input.userId, {
          environmentId: input.environmentId,
          serverName: input.name,
          presetId: prepared.preset?.id,
          authMode: prepared.authMode,
          endpointFingerprint: prepared.endpoint.fingerprint,
          destinationDomain: prepared.endpoint.domain,
          destinationPath: prepared.endpoint.path,
          credentialHeaderName: prepared.headerName,
          credentialValueTemplate: prepared.valueTemplate,
          lifecycleStatus: "active",
          credentialStatus:
            prepared.authMode === "none" ? "not-required" : "missing",
        });
      }
      return this.decorateCurrent(input.userId, input.environmentId, inventory);
    });
  }

  async updateEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
    server: CodexMcpServerInput;
    metadata: CodexMcpDefinitionMetadata;
  }) {
    return this.withMutation(input.environmentId, async () => {
      const currentInventory = await this.codex.listEnvironmentMcpServers(
        input.userId,
        input.environmentId,
      );
      const currentServer = currentInventory.servers.find(
        (server) => server.name === input.name,
      );
      if (!currentServer) {
        throw new HttpError(
          404,
          "codex_mcp_server_not_found",
          "The MCP server is no longer configured.",
        );
      }
      if (currentServer.transport !== input.server.transport) {
        throw conflict(
          "codex_mcp_transport_immutable",
          "Remove and recreate the MCP server to change its transport.",
        );
      }
      let associations = await this.integrations.listIntegrations(
        input.userId,
        input.environmentId,
      );
      await this.reconcileEnvironmentStaticCredentials(
        input.environmentId,
        associations,
      );
      associations = await this.integrations.listIntegrations(
        input.userId,
        input.environmentId,
      );
      const existing = associations.find(
        (association) => association.serverName === input.name,
      );
      const prepared = prepareDefinition(
        input.name,
        input.server,
        input.metadata,
        existing,
      );
      if (existing?.authMode === "oauth") {
        await this.requireOAuthDefinitionMutationReady(input);
      }
      const oauthScopeChanged =
        existing?.authMode === "oauth" &&
        !sameStringSet(currentServer.scopes, input.server.scopes);
      const associationChanged =
        existing !== undefined &&
        (!prepared ||
          existing.authMode !== prepared.authMode ||
          existing.endpointFingerprint !== prepared.endpoint.fingerprint);

      if (
        existing?.toolPolicyMode === "selected" &&
        (!prepared ||
          existing.endpointFingerprint !== prepared.endpoint.fingerprint ||
          isAggregatorMcpPreset(prepared.preset?.id))
      ) {
        throw conflict(
          "mcp_tool_policy_definition_change_blocked",
          "Allow all MCP tools before changing this server's endpoint or permission authority.",
        );
      }

      if (
        existing &&
        (associationChanged || oauthScopeChanged) &&
        existing.authMode === "oauth"
      ) {
        const cancelled = await this.cancelActiveOAuthFlowRecord(input);
        await this.codex.logoutEnvironmentMcpServer({
          userId: input.userId,
          environmentId: input.environmentId,
          name: input.name,
        });
        if (cancelled) {
          await this.markOAuthCleanupCompleted(cancelled);
        }
      }

      const inventory = await this.codex.updateEnvironmentMcpServer({
        userId: input.userId,
        environmentId: input.environmentId,
        name: input.name,
        server: input.server,
      });
      if (
        existing &&
        associationChanged &&
        isStaticAuth(existing.authMode) &&
        (existing.credentialSourceRef ||
          existing.pendingCredentialSourceRef ||
          existing.retiringCredentialSourceRef)
      ) {
        await this.removeStaticCredential({
          userId: input.userId,
          environmentId: input.environmentId,
          name: input.name,
          preserveAssociation: true,
        });
      }
      if (!prepared) {
        if (existing) {
          await this.integrations.deleteIntegration(
            input.userId,
            input.environmentId,
            input.name,
          );
        }
        return this.decorateCurrent(input.userId, input.environmentId, inventory);
      }

      const preserveCredential =
        existing &&
        existing.authMode === prepared.authMode &&
        existing.endpointFingerprint === prepared.endpoint.fingerprint &&
        !oauthScopeChanged;
      const desiredBindingEnabled = Boolean(
        preserveCredential &&
          isStaticAuth(prepared.authMode) &&
          existing.credentialSourceRef &&
          input.server.enabled,
      );
      const bindingChanged =
        Boolean(
          preserveCredential &&
            isStaticAuth(prepared.authMode) &&
            existing.credentialSourceRef,
        ) &&
        existing !== undefined &&
        existing.bindingEnabled !== desiredBindingEnabled;
      const policyNeedsConvergence =
        Boolean(
          preserveCredential &&
            existing &&
            isStaticAuth(prepared.authMode) &&
            existing.credentialSourceRef,
        ) &&
        (bindingChanged || existing!.lifecycleStatus !== "active");
      const integration = await this.integrations.upsertIntegration(input.userId, {
        environmentId: input.environmentId,
        serverName: input.name,
        presetId: prepared.preset?.id,
        authMode: prepared.authMode,
        credentialSourceRef: preserveCredential
          ? existing.credentialSourceRef
          : undefined,
        credentialBindingRef: preserveCredential
          ? existing.credentialBindingRef
          : undefined,
        credentialHeaderName:
          preserveCredential && existing.credentialHeaderName
            ? existing.credentialHeaderName
            : prepared.headerName,
        credentialValueTemplate:
          preserveCredential && existing.credentialValueTemplate
            ? existing.credentialValueTemplate
            : prepared.valueTemplate,
        bindingEnabled: desiredBindingEnabled,
        endpointFingerprint: prepared.endpoint.fingerprint,
        destinationDomain: prepared.endpoint.domain,
        destinationPath: prepared.endpoint.path,
        lifecycleStatus: policyNeedsConvergence ? "updating" : "active",
        credentialStatus:
          prepared.authMode === "none"
            ? "not-required"
            : preserveCredential
              ? existing.credentialStatus
              : "missing",
      });
      if (policyNeedsConvergence) {
        try {
          await this.applyEffectiveNetworkPolicy(input.environmentId);
          await this.integrations.markIntegration(
            input.userId,
            input.environmentId,
            input.name,
            {
              lifecycleStatus: "active",
              credentialStatus: integration.credentialStatus,
              lastError: null,
            },
          );
        } catch (error) {
          await this.markStaticMutationError(input, "credential_policy_failed");
          throw error;
        }
      }
      return this.decorateCurrent(input.userId, input.environmentId, inventory);
    });
  }

  async setEnvironmentMcpServerEnabled(input: {
    userId: string;
    environmentId: string;
    name: string;
    enabled: boolean;
  }) {
    return this.withMutation(input.environmentId, async () => {
      let associations = await this.integrations.listIntegrations(
        input.userId,
        input.environmentId,
      );
      await this.reconcileEnvironmentStaticCredentials(
        input.environmentId,
        associations,
      );
      associations = await this.integrations.listIntegrations(
        input.userId,
        input.environmentId,
      );
      let integration = associations.find(
        (candidate) => candidate.serverName === input.name,
      );
      if (
        !integration ||
        !isStaticAuth(integration.authMode) ||
        !integration.credentialSourceRef
      ) {
        const inventory =
          await this.codex.setEnvironmentMcpServerEnabled(input);
        return this.decorateCurrent(
          input.userId,
          input.environmentId,
          inventory,
        );
      }

      const bindingChanged = integration.bindingEnabled !== input.enabled;
      const policyNeedsConvergence =
        bindingChanged || integration.lifecycleStatus !== "active";
      if (!policyNeedsConvergence) {
        const inventory =
          await this.codex.setEnvironmentMcpServerEnabled(input);
        return this.decorateCurrent(
          input.userId,
          input.environmentId,
          inventory,
        );
      }

      let inventory: CodexMcpInventory;
      if (input.enabled) {
        // Enabling the native server before publishing the credential target
        // can cause only a temporary auth failure; it cannot expose a secret.
        inventory = await this.codex.setEnvironmentMcpServerEnabled(input);
      }
      if (bindingChanged) {
        integration = await this.integrations.setBindingEnabled(
          input.userId,
          input.environmentId,
          input.name,
          {
            expectedVersion: integrationVersion(integration),
            expectedEndpointFingerprint: integration.endpointFingerprint,
            expectedSourceRef: integration.credentialSourceRef,
            enabled: input.enabled,
          },
        );
      }
      try {
        await this.applyEffectiveNetworkPolicy(input.environmentId);
      } catch (error) {
        await this.markStaticMutationError(input, "credential_policy_failed");
        throw error;
      }
      if (!input.enabled) {
        try {
          inventory = await this.codex.setEnvironmentMcpServerEnabled(input);
        } catch (error) {
          await this.integrations
            .markIntegration(
              input.userId,
              input.environmentId,
              input.name,
              {
                lifecycleStatus: "active",
                credentialStatus: integration.credentialStatus,
                lastError: "Codex MCP enablement could not be updated.",
              },
            )
            .catch(() => undefined);
          throw error;
        }
      }
      await this.integrations.markIntegration(
        input.userId,
        input.environmentId,
        input.name,
        {
          lifecycleStatus: "active",
          credentialStatus: integration.credentialStatus,
          lastError: null,
        },
      );
      return this.decorateCurrent(
        input.userId,
        input.environmentId,
        inventory!,
      );
    });
  }

  async putEnvironmentMcpToolPolicy(input: {
    userId: string;
    environmentId: string;
    name: string;
    policy: CodexMcpToolPolicyInput;
  }) {
    return this.withMutation(input.environmentId, async () => {
      const inventory = await this.codex.listEnvironmentMcpServers(
        input.userId,
        input.environmentId,
      );
      const server = inventory.servers.find(
        (candidate) => candidate.name === input.name,
      );
      if (!server) {
        throw new HttpError(
          404,
          "codex_mcp_server_not_found",
          "The MCP server is no longer configured.",
        );
      }
      if (!server.managed || server.transport !== "streamable-http") {
        throw conflict(
          "mcp_tool_policy_unsupported",
          "Sandbox0 tool policy requires a remote MCP server owned by this Environment.",
        );
      }
      const integration = await this.integrations.getIntegration(
        input.userId,
        input.environmentId,
        input.name,
      );
      if (!remoteServerMatchesEndpoint(server, integration.endpointFingerprint)) {
        throw conflict(
          "mcp_tool_policy_endpoint_stale",
          "Save the MCP definition again before changing its tool policy.",
        );
      }
      if (isAggregatorMcpPreset(integration.presetId)) {
        throw conflict(
          "mcp_tool_policy_platform_managed",
          "This aggregator owns its tool permissions. Configure them in the aggregator platform.",
        );
      }
      const policy = validateMcpToolPolicy(server, input.policy);
      if (
        integration.toolPolicyMode === policy.mode &&
        sameStringSet(integration.allowedTools, policy.allowedTools) &&
        integration.toolPolicyStatus === "active"
      ) {
        return this.decorateCurrent(
          input.userId,
          input.environmentId,
          inventory,
        );
      }
      await this.updateToolPolicyDesired({
        userId: input.userId,
        environmentId: input.environmentId,
        integration,
        policy,
      });
      return this.decorateCurrent(
        input.userId,
        input.environmentId,
        inventory,
      );
    });
  }

  async deleteEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    return this.withMutation(input.environmentId, async () => {
      let associations = await this.integrations.listIntegrations(
        input.userId,
        input.environmentId,
      );
      await this.reconcileEnvironmentStaticCredentials(
        input.environmentId,
        associations,
      );
      associations = await this.integrations.listIntegrations(
        input.userId,
        input.environmentId,
      );
      let integration = associations.find(
        (association) => association.serverName === input.name,
      );
      if (integration?.authMode === "oauth") {
        await this.requireOAuthDefinitionMutationReady(input);
      }
      if (integration?.authMode === "oauth") {
        try {
          await this.codex.logoutEnvironmentMcpServer(input);
        } catch (error) {
          if (!isMissingMcpServer(error)) throw error;
        }
      }
      if (
        integration &&
        isStaticAuth(integration.authMode) &&
        (integration.credentialSourceRef ||
          integration.pendingCredentialSourceRef ||
          integration.retiringCredentialSourceRef)
      ) {
        await this.removeStaticCredential({
          ...input,
          preserveAssociation: true,
        });
        integration = await this.integrations.getIntegration(
          input.userId,
          input.environmentId,
          input.name,
        );
      }
      let inventory: CodexMcpInventory;
      try {
        inventory = await this.codex.deleteEnvironmentMcpServer(input);
      } catch (error) {
        if (!isMissingMcpServer(error)) throw error;
        inventory = await this.codex.listEnvironmentMcpServers(
          input.userId,
          input.environmentId,
        );
      }
      if (integration?.toolPolicyMode === "selected") {
        integration = await this.updateToolPolicyDesired({
          userId: input.userId,
          environmentId: input.environmentId,
          integration,
          policy: { mode: "all", allowedTools: [] },
        });
      } else if (integration?.toolPolicyStatus !== "active") {
        await this.applyEffectiveNetworkPolicy(input.environmentId);
        integration = await this.integrations.getIntegration(
          input.userId,
          input.environmentId,
          input.name,
        );
      }
      if (integration) {
        await this.integrations.deleteIntegration(
          input.userId,
          input.environmentId,
          input.name,
        );
      }
      return this.decorateCurrent(input.userId, input.environmentId, inventory);
    });
  }

  async putEnvironmentMcpCredential(input: {
    userId: string;
    environmentId: string;
    name: string;
    credential: CodexMcpCredentialInput;
  }) {
    return this.withMutation(input.environmentId, async () => {
      await this.reconcileStaticCredentialsForUser(
        input.userId,
        input.environmentId,
      );
      const server = await this.requireManagedRemoteServer(
        input.userId,
        input.environmentId,
        input.name,
      );
      const endpoint = remoteEndpoint(server.url);
      const existing = await this.integrations.getIntegration(
        input.userId,
        input.environmentId,
        input.name,
      );
      if (
        existing.authMode !== input.credential.method ||
        existing.endpointFingerprint !== endpoint.fingerprint
      ) {
        throw conflict(
          "mcp_credential_definition_mismatch",
          "Save the MCP definition with this authentication method before setting its credential.",
        );
      }
      const preset = resolveCredentialPreset(
        input.name,
        server,
        input.credential.presetId ?? existing.presetId,
        input.credential.method,
      );
      const projection = staticProjection(input.credential, preset);
      const pendingSourceRef = `sandpi-mcp-${randomUUID()}`;
      const pendingBindingRef = `sandpi-mcp-${randomUUID()}`;
      let pending = await this.integrations.beginStaticCredentialPending(
        input.userId,
        input.environmentId,
        input.name,
        {
          expectedVersion: integrationVersion(existing),
          expectedEndpointFingerprint: endpoint.fingerprint,
          expectedCurrentSourceRef: existing.credentialSourceRef ?? null,
          pendingSourceRef,
          pendingBindingRef,
          credentialHeaderName: projection.headerName,
          credentialValueTemplate: projection.valueTemplate,
        },
      );
      try {
        // Every replacement gets a new immutable Credential Source. The old
        // source stays bound until the new source is durably journaled and the
        // complete network policy replacement succeeds.
        await this.runtime.createStaticHeaderCredentialSource({
          name: pendingSourceRef,
          headers: { token: input.credential.secret },
        });
      } catch (error) {
        const cleaned = await this
          .deleteCredentialSourceIfPresent(pendingSourceRef)
          .then(() => true)
          .catch(() => false);
        if (cleaned) {
          await this.integrations
            .abortStaticCredentialPending(
              input.userId,
              input.environmentId,
              input.name,
              {
                expectedVersion: integrationVersion(pending),
                expectedPendingSourceRef: pendingSourceRef,
              },
            )
            .catch(() => undefined);
        }
        throw error;
      }

      try {
        pending = await this.integrations.promoteStaticCredentialPending(
          input.userId,
          input.environmentId,
          input.name,
          {
            expectedVersion: integrationVersion(pending),
            expectedEndpointFingerprint: endpoint.fingerprint,
            expectedPendingSourceRef: pendingSourceRef,
            bindingEnabled: server.enabled,
          },
        );
      } catch (error) {
        const cleaned = await this
          .deleteCredentialSourceIfPresent(pendingSourceRef)
          .then(() => true)
          .catch(() => false);
        if (cleaned) {
          await this.integrations
            .abortStaticCredentialPending(
              input.userId,
              input.environmentId,
              input.name,
              {
                expectedVersion: integrationVersion(pending),
                expectedPendingSourceRef: pendingSourceRef,
              },
            )
            .catch(() => undefined);
        }
        throw error;
      }

      try {
        await this.applyEffectiveNetworkPolicy(input.environmentId);
        if (pending.retiringCredentialSourceRef) {
          const retiringSourceRef = pending.retiringCredentialSourceRef;
          await this.deleteCredentialSourceIfPresent(retiringSourceRef);
          pending =
            await this.integrations.finishStaticCredentialRetirement(
              input.userId,
              input.environmentId,
              input.name,
              {
                expectedVersion: integrationVersion(pending),
                expectedRetiringSourceRef: retiringSourceRef,
              },
            );
        } else {
          pending = await this.integrations.markIntegration(
            input.userId,
            input.environmentId,
            input.name,
            {
              lifecycleStatus: "active",
              credentialStatus: "configured",
              lastError: null,
            },
          );
        }
      } catch (error) {
        await this.integrations
          .markIntegration(
            input.userId,
            input.environmentId,
            input.name,
            {
              lifecycleStatus: pending.retiringCredentialSourceRef
                ? "updating"
                : "error",
              lastError: "MCP credential network policy could not be applied.",
            },
          )
          .catch(() => undefined);
        throw error;
      }
      const inventory = await this.codex.testEnvironmentMcpServer({
        userId: input.userId,
        environmentId: input.environmentId,
        name: input.name,
      });
      return this.decorateCurrent(input.userId, input.environmentId, inventory);
    });
  }

  async deleteEnvironmentMcpCredential(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    return this.withMutation(input.environmentId, async () => {
      await this.reconcileStaticCredentialsForUser(
        input.userId,
        input.environmentId,
      );
      const integration = await this.integrations.getIntegration(
        input.userId,
        input.environmentId,
        input.name,
      );
      if (!isStaticAuth(integration.authMode)) {
        throw conflict(
          "mcp_static_credential_not_configured",
          "This MCP server does not use a static credential.",
        );
      }
      if (
        integration.credentialSourceRef ||
        integration.pendingCredentialSourceRef ||
        integration.retiringCredentialSourceRef
      ) {
        await this.removeStaticCredential({
          ...input,
          preserveAssociation: true,
        });
      }
      const inventory = await this.codex.testEnvironmentMcpServer({
        userId: input.userId,
        environmentId: input.environmentId,
        name: input.name,
      });
      return this.decorateCurrent(input.userId, input.environmentId, inventory);
    });
  }

  async startEnvironmentMcpOAuth(input: {
    userId: string;
    environmentId: string;
    name: string;
    login: CodexMcpOAuthLoginInput;
  }): Promise<CodexMcpOAuthFlow> {
    return this.withMutation(input.environmentId, async () => {
      await this.reconcileEnvironmentOAuthCleanup(input.environmentId);
      const server = await this.requireManagedRemoteServer(
        input.userId,
        input.environmentId,
        input.name,
      );
      const endpoint = remoteEndpoint(server.url);
      const integration = await this.integrations.getIntegration(
        input.userId,
        input.environmentId,
        input.name,
      );
      if (
        integration.authMode !== "oauth" ||
        integration.endpointFingerprint !== endpoint.fingerprint
      ) {
        throw conflict(
          "mcp_oauth_definition_mismatch",
          "Save the MCP definition with OAuth before starting authorization.",
        );
      }
      resolveOAuthPreset(
        input.name,
        server,
        input.login.presetId ?? integration.presetId,
      );
      const scopes = normalizeStringSet(server.scopes);
      const requestedScopes = normalizeStringSet(input.login.scopes);
      if (
        requestedScopes.length > 0 &&
        !sameStringSet(requestedScopes, scopes)
      ) {
        throw conflict(
          "mcp_oauth_scope_definition_mismatch",
          "Save OAuth scopes in the MCP definition before authorizing them.",
        );
      }
      const configFingerprint = oauthConfigFingerprint(
        input.name,
        endpoint,
        scopes,
      );
      this.codex.requireEnvironmentMcpOAuthPersistence();
      const created = await this.integrations.createOAuthFlow(input.userId, {
        environmentId: input.environmentId,
        serverName: input.name,
        configFingerprint,
        expiresAt: new Date(Date.now() + MCP_OAUTH_FLOW_TTL_MS),
        expectedEndpointFingerprint: endpoint.fingerprint,
      });
      if (!created.created) {
        throw conflict(
          "mcp_oauth_flow_active",
          `Authorization for ${created.flow.serverName} is already in progress.`,
          { flowId: created.flow.id },
        );
      }

      let oauthRuntime: StoredEnvironmentRuntime | undefined;
      let nativeThreadId: string | undefined;
      let nativeLoginMayBeRunning = false;
      try {
        oauthRuntime = await this.codex.environmentRuntimeForMcp(
          input.userId,
          input.environmentId,
        );
        const callback =
          await this.runtime.ensureEnvironmentMcpOAuthCallbackService(
            oauthRuntime,
            {
              port: CODEX_MCP_OAUTH_CALLBACK_PORT,
            },
          );
        await this.codex.configureEnvironmentMcpOAuthCallback({
          userId: input.userId,
          environmentId: input.environmentId,
          port: callback.port,
          url: callbackUrl(callback.publicUrl),
        });
        const correlation =
          await this.codex.createEnvironmentMcpOAuthCorrelationThread({
            userId: input.userId,
            environmentId: input.environmentId,
          });
        oauthRuntime = correlation.runtime;
        nativeThreadId = correlation.nativeThreadId;
        await this.integrations.markOAuthFlowCorrelation(
          input.userId,
          input.environmentId,
          created.flow.id,
          {
            nativeThreadId,
            runtime: {
              runtimeGeneration: oauthRuntime.runtimeGeneration,
              attemptId: oauthRuntime.attemptId,
            },
            expiresAt: new Date(Date.now() + MCP_OAUTH_FLOW_TTL_MS),
            expectedConfigFingerprint: configFingerprint,
            expectedEndpointFingerprint: endpoint.fingerprint,
          },
        );
        // The native request can start its callback listener before its RPC
        // response is observed. Any failure from this point must retain a
        // cancelled-flow quarantine for late callbacks.
        nativeLoginMayBeRunning = true;
        const login = await this.codex.beginEnvironmentMcpOAuthLogin({
          environmentId: input.environmentId,
          name: input.name,
          nativeThreadId,
          runtime: oauthRuntime,
          scopes,
          timeoutSecs: MCP_OAUTH_NATIVE_TIMEOUT_SECONDS,
        });
        const authorizationUrl = safeOAuthAuthorizationUrl(
          login.authorizationUrl,
        );
        let flow: EnvironmentMcpOAuthFlow;
        try {
          flow = await this.integrations.markOAuthFlow(
            input.userId,
            input.environmentId,
            created.flow.id,
            {
              status: "awaiting_user",
              error: null,
              expectedConfigFingerprint: configFingerprint,
            },
          );
        } catch (error) {
          const terminal = await this.terminalOAuthStartRace(
            input.userId,
            input.environmentId,
            created.flow.id,
            nativeThreadId,
          );
          if (terminal) {
            await this.reconcileEnvironmentOAuthThreadCleanup(
              input.environmentId,
              oauthRuntime,
            );
            return publicOAuthFlow(terminal);
          }
          throw error;
        }
        return publicOAuthFlow(flow, authorizationUrl);
      } catch (error) {
        const terminal = await this.terminalOAuthStartRace(
          input.userId,
          input.environmentId,
          created.flow.id,
          nativeThreadId,
        );
        if (terminal) {
          await this.reconcileEnvironmentOAuthThreadCleanup(
            input.environmentId,
            oauthRuntime,
          );
          return publicOAuthFlow(terminal);
        }
        if (nativeThreadId && oauthRuntime && !nativeLoginMayBeRunning) {
          // Correlation persistence failed before native login submission. The
          // Thread cannot be journaled on this flow, so release it immediately.
          // A crash in the narrow create-to-journal window can leave an unused
          // ephemeral Thread until the Environment runtime restarts, but no
          // native OAuth handle exists yet and it cannot change credentials.
          await this.codex
            .releaseEnvironmentMcpOAuthCorrelationThread(
              oauthRuntime,
              nativeThreadId,
            )
            .catch((cleanupError) => {
              this.logger.warn(
                {
                  environmentId: input.environmentId,
                  nativeThreadId,
                  error: safeErrorMessage(cleanupError),
                },
                "Unpersisted MCP OAuth correlation Thread cleanup deferred",
              );
            });
        }
        const terminalStatus = nativeLoginMayBeRunning
          ? "cancelled"
          : "failed";
        let transitioned: EnvironmentMcpOAuthFlow | undefined;
        try {
          transitioned = await this.integrations.markOAuthFlow(
            input.userId,
            input.environmentId,
            created.flow.id,
            {
              status: terminalStatus,
              error: "MCP OAuth could not be started.",
              expectedConfigFingerprint: configFingerprint,
            },
          );
        } catch {
          const raced = await this.terminalOAuthStartRace(
            input.userId,
            input.environmentId,
            created.flow.id,
            nativeThreadId,
          );
          if (raced) {
            await this.reconcileEnvironmentOAuthThreadCleanup(
              input.environmentId,
              oauthRuntime,
            );
            return publicOAuthFlow(raced);
          }
        }
        if (transitioned) {
          await this.integrations
            .markIntegration(
              input.userId,
              input.environmentId,
              input.name,
              {
                lifecycleStatus: "error",
                credentialStatus: "error",
                lastError: "MCP OAuth could not be started.",
              },
            )
            .catch(() => undefined);
        }
        if (
          transitioned?.status === "cancelled" &&
          nativeLoginMayBeRunning &&
          oauthRuntime
        ) {
          await this.codex
            .discardEnvironmentMcpOAuthCredential(
              oauthRuntime,
              input.name,
            )
            .then(async () => {
              const cancelled = await this.integrations.getOAuthFlow(
                input.userId,
                input.environmentId,
                created.flow.id,
              );
              await this.markOAuthCleanupCompleted(cancelled);
              await this.reconcileEnvironmentOAuthThreadCleanup(
                input.environmentId,
                oauthRuntime,
              );
            })
            .catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async getEnvironmentMcpOAuthFlow(
    userId: string,
    environmentId: string,
    flowId: string,
  ) {
    return this.withMutation(environmentId, async () => {
      await this.reconcileEnvironmentOAuthCleanup(environmentId);
      return publicOAuthFlow(
        await this.integrations.getOAuthFlow(userId, environmentId, flowId),
      );
    });
  }

  async cancelEnvironmentMcpOAuthFlow(
    userId: string,
    environmentId: string,
    flowId: string,
  ) {
    return this.withMutation(environmentId, async () => {
      await this.reconcileEnvironmentOAuthCleanup(environmentId);
      let flow = await this.integrations.getOAuthFlow(
        userId,
        environmentId,
        flowId,
      );
      if (flow.status === "starting" || flow.status === "awaiting_user") {
        flow = await this.integrations.markOAuthFlow(
          userId,
          environmentId,
          flowId,
          {
            status: "cancelled",
            error: null,
            expectedConfigFingerprint: flow.configFingerprint,
          },
        );
      }
      if (flow.status === "cancelled") {
        // Keep the cancelled row as a short quarantine for late native
        // completion events, but remove any token that won the callback race.
        const runtime = await this.codex.environmentRuntimeForMcp(
          userId,
          environmentId,
        );
        await this.codex.discardEnvironmentMcpOAuthCredential(
          runtime,
          flow.serverName,
        );
        await this.markOAuthCleanupCompleted(flow);
        await this.reconcileEnvironmentOAuthThreadCleanup(
          environmentId,
          runtime,
        );
        await this.integrations.markIntegration(
          userId,
          environmentId,
          flow.serverName,
          {
            lifecycleStatus: "active",
            credentialStatus: "missing",
            lastError: null,
          },
        );
      }
      return publicOAuthFlow(flow);
    });
  }

  async logoutEnvironmentMcpOAuth(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    return this.withMutation(input.environmentId, async () => {
      await this.reconcileEnvironmentOAuthCleanup(input.environmentId);
      const integration = await this.integrations.getIntegration(
        input.userId,
        input.environmentId,
        input.name,
      );
      if (integration.authMode !== "oauth") {
        return this.decorateCurrent(
          input.userId,
          input.environmentId,
          await this.codex.listEnvironmentMcpServers(
            input.userId,
            input.environmentId,
          ),
        );
      }
      const cancelled = await this.cancelActiveOAuthFlowRecord(input);
      const inventory = await this.codex.logoutEnvironmentMcpServer(input);
      if (cancelled) {
        await this.markOAuthCleanupCompleted(cancelled);
      }
      await this.reconcileEnvironmentOAuthThreadCleanup(input.environmentId);
      await this.integrations.markIntegration(
        input.userId,
        input.environmentId,
        input.name,
        {
          lifecycleStatus: "active",
          credentialStatus: "missing",
          lastError: null,
        },
      );
      return this.decorateCurrent(input.userId, input.environmentId, inventory);
    });
  }

  async testEnvironmentMcpServer(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    return this.withMutation(input.environmentId, async () => {
      const inventory = await this.codex.testEnvironmentMcpServer(input);
      return this.decorateCurrent(
        input.userId,
        input.environmentId,
        inventory,
      );
    });
  }

  async applyUserNetworkPolicy(input: {
    userId: string;
    environmentId: string;
    runtime: EnvironmentRuntimeRecord;
    userPolicy: NetworkPolicy;
  }) {
    // EnvironmentService already owns the MCP mutation lock followed by the
    // lifecycle lock. Re-entering either advisory lock through another pool
    // connection would deadlock.
    return this.applyEffectiveNetworkPolicyLocked(
      input.environmentId,
      input.runtime,
      input.userPolicy,
    );
  }

  async cleanupEnvironment(userId: string, environmentId: string) {
    await this.withMutation(environmentId, async () => {
      const integrations = await this.integrations.listIntegrations(
        userId,
        environmentId,
      );
      const staticIntegrations = integrations.filter(
        (integration) =>
          isStaticAuth(integration.authMode) &&
          Boolean(
            integration.credentialSourceRef ||
              integration.pendingCredentialSourceRef ||
              integration.retiringCredentialSourceRef,
          ),
      );
      if (staticIntegrations.length === 0) return;
      for (const integration of staticIntegrations) {
        await this.integrations.markIntegration(
          userId,
          environmentId,
          integration.serverName,
          { lifecycleStatus: "deleting", lastError: null },
        );
      }
      await this.applyEffectiveNetworkPolicy(
        environmentId,
        undefined,
        true,
      );
      const sourceRefs = [
        ...new Set(
          staticIntegrations.flatMap((integration) =>
            [
              integration.credentialSourceRef,
              integration.pendingCredentialSourceRef,
              integration.retiringCredentialSourceRef,
            ].filter((sourceRef): sourceRef is string => Boolean(sourceRef)),
          ),
        ),
      ];
      const cleanup = await Promise.allSettled(
        sourceRefs.map((sourceRef) =>
          this.deleteCredentialSourceIfPresent(sourceRef),
        ),
      );
      const failures = cleanup.filter(
        (result) => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new HttpError(
          502,
          "mcp_credential_cleanup_failed",
          "One or more MCP credential sources require cleanup retry.",
        );
      }
    });
  }

  async reconcilePending() {
    const [candidates, oauthCleanup, oauthThreadCleanup] = await Promise.all([
      this.integrations.listReconciliationCandidatesForRuntime(),
      this.integrations.listCancelledOAuthFlowsForRuntime(),
      this.integrations.listOAuthThreadCleanupForRuntime(),
    ]);
    const environmentIds = [
      ...new Set([
        ...candidates.map((candidate) => candidate.environmentId),
        ...oauthCleanup.map((flow) => flow.environmentId),
        ...oauthThreadCleanup.map((flow) => flow.environmentId),
      ]),
    ];
    for (const environmentId of environmentIds) {
      try {
        await this.withMutation(environmentId, async () => {
          await this.reconcileEnvironmentOAuthCleanup(environmentId);
          await this.reconcileEnvironmentStaticCredentials(
            environmentId,
            candidates.filter(
              (candidate) => candidate.environmentId === environmentId,
            ),
          );
          for (const integration of candidates.filter(
            (candidate) =>
              candidate.environmentId === environmentId &&
              candidate.authMode === "oauth" &&
              candidate.lifecycleStatus === "deleting",
          )) {
            await this.integrations.deleteIntegrationForRuntimeIfUnreferenced(
              environmentId,
              integration.serverName,
              {
                expectedVersion: integrationVersion(
                  await this.integrations.getIntegrationForRuntime(
                    environmentId,
                    integration.serverName,
                  ),
                ),
                expectedEndpointFingerprint:
                  integration.endpointFingerprint,
              },
            );
          }
          if (
            (
              await this.integrations.listToolPolicyIntegrationsForRuntime(
                environmentId,
              )
            ).some(
              (integration) => integration.toolPolicyStatus !== "active",
            )
          ) {
            await this.applyEffectiveNetworkPolicy(environmentId);
          }
        });
      } catch (error) {
        this.logger.warn(
          { environmentId, error: safeErrorMessage(error) },
          "MCP integration reconciliation deferred",
        );
      }
    }
  }

  /**
   * Replays the durable static-credential journal while the caller owns the
   * Environment MCP mutation lock. This runs on normal API traffic as well as
   * startup so a transient Sandbox0 failure does not require a process restart.
   */
  private async reconcileEnvironmentStaticCredentials(
    environmentId: string,
    knownIntegrations?: readonly EnvironmentMcpIntegration[],
  ) {
    const candidates = (
      knownIntegrations ??
      (await this.integrations.listReconciliationCandidatesForRuntime()).filter(
        (candidate) => candidate.environmentId === environmentId,
      )
    ).filter(staticIntegrationNeedsReconciliation);
    const serverNames = [
      ...new Set(candidates.map((candidate) => candidate.serverName)),
    ];
    const fresh: EnvironmentMcpIntegration[] = [];
    for (const serverName of serverNames) {
      let integration =
        await this.integrations.getIntegrationForRuntime(
          environmentId,
          serverName,
        );
      if (!staticIntegrationNeedsReconciliation(integration)) continue;
      if (integration.pendingCredentialSourceRef) {
        const pendingSourceRef = integration.pendingCredentialSourceRef;
        await this.deleteCredentialSourceIfPresent(pendingSourceRef);
        const aborted =
          await this.integrations.abortStaticCredentialPendingForRuntime(
            environmentId,
            serverName,
            {
              expectedVersion: integrationVersion(integration),
              expectedPendingSourceRef: pendingSourceRef,
            },
          );
        if (!aborted) throw reconciliationChanged();
        integration = aborted;
      }
      fresh.push(integration);
    }

    if (fresh.length > 0) {
      await this.applyEffectiveNetworkPolicy(environmentId);
    }
    for (let integration of fresh) {
      if (integration.retiringCredentialSourceRef) {
        const retiringSourceRef = integration.retiringCredentialSourceRef;
        await this.deleteCredentialSourceIfPresent(retiringSourceRef);
        const retired =
          await this.integrations.finishStaticCredentialRetirementForRuntime(
            environmentId,
            integration.serverName,
            {
              expectedVersion: integrationVersion(integration),
              expectedRetiringSourceRef: retiringSourceRef,
            },
          );
        if (!retired) throw reconciliationChanged();
        integration = retired;
      }
      if (
        integration.lifecycleStatus === "deleting" &&
        integration.credentialSourceRef
      ) {
        await this.deleteCredentialSourceIfPresent(
          integration.credentialSourceRef,
        );
        const cleared =
          await this.integrations.clearStaticCredentialForRuntime(
            environmentId,
            integration.serverName,
            {
              expectedVersion: integrationVersion(integration),
              expectedSourceRef: integration.credentialSourceRef,
            },
          );
        if (!cleared) throw reconciliationChanged();
        continue;
      }
      if (integration.lifecycleStatus !== "active") {
        const restored =
          await this.integrations.markStaticCredentialActiveForRuntime(
            environmentId,
            integration.serverName,
            {
              expectedVersion: integrationVersion(integration),
              expectedEndpointFingerprint: integration.endpointFingerprint,
              expectedSourceRef: integration.credentialSourceRef ?? null,
              expectedBindingEnabled: integration.bindingEnabled === true,
            },
          );
        if (!restored) throw reconciliationChanged();
      }
    }
  }

  private async reconcileStaticCredentialsForUser(
    userId: string,
    environmentId: string,
  ) {
    await this.reconcileEnvironmentStaticCredentials(
      environmentId,
      await this.integrations.listIntegrations(userId, environmentId),
    );
  }

  async handleCodexMcpNotification(
    environmentId: string,
    runtime: StoredEnvironmentRuntime,
    message: Record<string, unknown>,
    event: CodexNativeEventIdentity & { occurredAt: string },
  ) {
    if (message.method !== "mcpServer/oauthLogin/completed") return;
    const params = objectRecord(message.params);
    const serverName = objectString(params, "name");
    const nativeThreadId = objectString(params, "threadId");
    const success = objectBoolean(params, "success");
    const occurredAt = new Date(event.occurredAt);
    if (
      !serverName ||
      !MCP_SERVER_NAME.test(serverName) ||
      !nativeThreadId?.trim() ||
      success === undefined ||
      !Number.isFinite(occurredAt.getTime())
    ) {
      // Native protocol records are untrusted input. Ambiguous notifications
      // cannot be associated with whichever flow happens to be active.
      return;
    }
    if (
      await this.integrations.hasOAuthNativeEventForRuntime(
        environmentId,
        event,
      )
    ) {
      return;
    }

    const flow =
      await this.integrations.findOAuthFlowByNativeThreadForRuntime(
        environmentId,
        serverName,
        nativeThreadId,
      );
    const flowRuntimeMatches =
      flow !== undefined && oauthFlowMatchesNativeEvent(flow, event);
    if (
      flow &&
      flowRuntimeMatches &&
      (flow.status === "starting" || flow.status === "awaiting_user")
    ) {
      if (success) {
        // Persist first, then atomically publish the terminal flow and event.
        // A persistence failure leaves the cursor behind this record so the
        // whole operation is retried without declaring a false failure.
        await this.codex.persistEnvironmentMcpOAuthCredential(runtime);
      }
      const applied =
        await this.integrations.applyOAuthNativeTerminalEventForRuntime(
          environmentId,
          serverName,
          {
            event,
            occurredAt,
            nativeThreadId,
            success,
            error: success ? null : "MCP OAuth authorization failed.",
            expectedConfigFingerprint: flow.configFingerprint,
            expectedEndpointFingerprint:
              oauthFlowEndpointFingerprint(flow),
          },
        );
      if (
        applied.disposition === "applied" ||
        applied.disposition === "duplicate"
      ) {
        // Thread unsubscription is intentionally deferred to normal API/startup
        // reconciliation. Awaiting app-server RPC here would deadlock its event
        // consumer against the response this worker itself must decode.
        return;
      }
    } else if (
      flow &&
      flowRuntimeMatches &&
      ((flow.status === "completed" && success) ||
        (flow.status === "failed" && !success))
    ) {
      await this.integrations.recordOAuthNativeEventForRuntime(
        environmentId,
        serverName,
        {
          event,
          occurredAt,
          success,
          disposition: "terminal-replay",
        },
      );
      return;
    }

    if (success) {
      // A successful completion that cannot win the exact flow/runtime/thread
      // CAS may already have written this server's shared native credential
      // slot. Remove it and invalidate any newer authorization for that slot.
      await this.codex.discardEnvironmentMcpOAuthCredential(
        runtime,
        serverName,
      );
      if (
        flow &&
        (flow.status === "cancelled" || flow.status === "expired") &&
        !flow.cleanupCompletedAt
      ) {
        await this.markOAuthCleanupCompleted(flow);
      }
      await this.invalidateOAuthAfterStaleSuccess(
        environmentId,
        serverName,
      );
    }
    await this.integrations.recordOAuthNativeEventForRuntime(
      environmentId,
      serverName,
      {
        event,
        occurredAt,
        success,
        disposition: success ? "stale-cleaned" : "stale-ignored",
      },
    );
  }

  private async requireManagedRemoteServer(
    userId: string,
    environmentId: string,
    name: string,
  ) {
    const inventory = await this.codex.listEnvironmentMcpServers(
      userId,
      environmentId,
    );
    const server = inventory.servers.find((candidate) => candidate.name === name);
    if (!server) {
      throw new HttpError(
        404,
        "codex_mcp_server_not_found",
        "The MCP server is no longer configured.",
      );
    }
    if (!server.managed || server.transport !== "streamable-http") {
      throw conflict(
        "mcp_remote_credential_unsupported",
        "Credentials can be managed only for a remote MCP server owned by this Environment.",
      );
    }
    return server;
  }

  private async readEnvironmentMcpServers(
    userId: string,
    environmentId: string,
  ) {
    const inventory = await this.codex.listEnvironmentMcpServers(
      userId,
      environmentId,
    );
    await this.reconcileEnvironmentOAuthCleanup(environmentId);
    let associations = await this.integrations.listIntegrations(
      userId,
      environmentId,
    );
    await this.reconcileEnvironmentStaticCredentials(
      environmentId,
      associations,
    );
    associations = await this.integrations.listIntegrations(
      userId,
      environmentId,
    );
    let removedDeletingOAuth = false;
    for (const integration of associations) {
      if (
        integration.authMode !== "oauth" ||
        integration.lifecycleStatus !== "deleting"
      ) {
        continue;
      }
      const deleted =
        await this.integrations.deleteIntegrationForRuntimeIfUnreferenced(
          environmentId,
          integration.serverName,
          {
            expectedVersion: integrationVersion(integration),
            expectedEndpointFingerprint:
              integration.endpointFingerprint,
          },
        );
      removedDeletingOAuth ||= Boolean(deleted);
    }
    if (removedDeletingOAuth) {
      associations = await this.integrations.listIntegrations(
        userId,
        environmentId,
      );
    }
    const converging: EnvironmentMcpIntegration[] = [];
    for (const integration of associations) {
      if (
        !isStaticAuth(integration.authMode) ||
        !integration.credentialSourceRef ||
        !integration.credentialBindingRef ||
        integration.pendingCredentialSourceRef ||
        integration.retiringCredentialSourceRef ||
        integration.lifecycleStatus === "deleting"
      ) {
        continue;
      }
      const server = inventory.servers.find(
        (candidate) => candidate.name === integration.serverName,
      );
      const desiredBindingEnabled = Boolean(
        server &&
          server.enabled &&
          server.managed &&
          server.transport === "streamable-http" &&
          remoteServerMatchesEndpoint(server, integration.endpointFingerprint),
      );
      let next = integration;
      if (Boolean(integration.bindingEnabled) !== desiredBindingEnabled) {
        next = await this.integrations.setBindingEnabled(
          userId,
          environmentId,
          integration.serverName,
          {
            expectedVersion: integrationVersion(integration),
            expectedEndpointFingerprint: integration.endpointFingerprint,
            expectedSourceRef: integration.credentialSourceRef,
            enabled: desiredBindingEnabled,
          },
        );
      }
      if (
        next.lifecycleStatus !== "active" ||
        Boolean(integration.bindingEnabled) !== desiredBindingEnabled
      ) {
        converging.push(next);
      }
    }
    if (converging.length > 0) {
      try {
        await this.applyEffectiveNetworkPolicy(environmentId);
        for (const integration of converging) {
          await this.integrations.markIntegration(
            userId,
            environmentId,
            integration.serverName,
            {
              lifecycleStatus: "active",
              credentialStatus: integration.credentialStatus,
              lastError: null,
            },
          );
        }
      } catch (error) {
        await Promise.allSettled(
          converging.map((integration) =>
            this.markStaticMutationError(
              {
                userId,
                environmentId,
                name: integration.serverName,
              },
              "credential_policy_failed",
            ),
          ),
        );
        throw error;
      }
      associations = await this.integrations.listIntegrations(
        userId,
        environmentId,
      );
    }
    if (
      associations.some(
        (integration) => integration.toolPolicyStatus !== "active",
      )
    ) {
      await this.applyEffectiveNetworkPolicy(environmentId);
      associations = await this.integrations.listIntegrations(
        userId,
        environmentId,
      );
    }
    const activeOAuthFlow = await this.integrations.findBlockingOAuthFlow(
      userId,
      environmentId,
    );
    return {
      ...decorateInventory(inventory, associations),
      ...(activeOAuthFlow
        ? { activeOAuthFlow: publicOAuthFlow(activeOAuthFlow) }
        : {}),
    };
  }

  private async decorateCurrent(
    userId: string,
    environmentId: string,
    inventory: CodexMcpInventory,
  ) {
    return decorateInventory(
      inventory,
      await this.integrations.listIntegrations(userId, environmentId),
    );
  }

  private async updateToolPolicyDesired(input: {
    userId: string;
    environmentId: string;
    integration: EnvironmentMcpIntegration;
    policy: CodexMcpToolPolicyInput;
  }) {
    const pending = await this.integrations.setToolPolicy(
      input.userId,
      input.environmentId,
      input.integration.serverName,
      {
        expectedVersion: integrationVersion(input.integration),
        expectedEndpointFingerprint: input.integration.endpointFingerprint,
        mode: input.policy.mode,
        allowedTools: input.policy.allowedTools,
      },
    );
    try {
      await this.applyEffectiveNetworkPolicy(input.environmentId);
    } catch (error) {
      await this.integrations
        .markToolPolicyErrorForRuntime(
          input.environmentId,
          input.integration.serverName,
          {
            expectedEndpointFingerprint: input.integration.endpointFingerprint,
            error: "Sandbox0 MCP tool policy could not be applied.",
          },
        )
        .catch(() => undefined);
      throw error;
    }
    return (
      (await this.integrations.getIntegration(
        input.userId,
        input.environmentId,
        input.integration.serverName,
      )) ?? pending
    );
  }

  private async applyEffectiveNetworkPolicy(
    environmentId: string,
    userPolicy?: NetworkPolicy,
    allowTerminated = false,
  ) {
    return this.withLifecycleMutation(environmentId, async (scopedStore) => {
      const runtime = await scopedStore.environmentRuntime(environmentId);
      if (runtime.desiredState === "terminated" && !allowTerminated) {
        throw conflict(
          "environment_terminated",
          "The Environment is being deleted.",
        );
      }
      return this.applyEffectiveNetworkPolicyLocked(
        environmentId,
        runtime,
        userPolicy,
        scopedStore,
      );
    });
  }

  private async applyEffectiveNetworkPolicyLocked(
    environmentId: string,
    runtime: EnvironmentRuntimeRecord,
    userPolicy?: NetworkPolicy,
    scopedStore: SandpiStore = this.store,
  ) {
    const [environment, managed, toolPolicies] = await Promise.all([
      userPolicy
        ? Promise.resolve(undefined)
        : scopedStore.getEnvironmentById(environmentId),
      this.integrations.listActiveStaticIntegrationsForRuntime(environmentId),
      this.integrations.listToolPolicyIntegrationsForRuntime(environmentId),
    ]);
    await this.runtime.applyEnvironmentSandboxNetworkPolicy(
      runtime,
      toSandbox0NetworkPolicy(
        userPolicy ?? environment!.networkPolicy,
        managed.map(toManagedMcpCredentialBinding),
        toolPolicies.map(toManagedMcpToolPolicy),
      ),
    );
    await this.integrations.markToolPoliciesActiveForRuntime(environmentId);
  }

  private async removeStaticCredential(input: {
    userId: string;
    environmentId: string;
    name: string;
    preserveAssociation: boolean;
  }) {
    let integration = await this.integrations.getIntegration(
      input.userId,
      input.environmentId,
      input.name,
    );

    const initialPendingSourceRef =
      integration.pendingCredentialSourceRef;
    if (initialPendingSourceRef) {
      if (integration.lifecycleStatus !== "updating") {
        integration = await this.integrations.markIntegration(
          input.userId,
          input.environmentId,
          input.name,
          { lifecycleStatus: "updating", lastError: null },
        );
      }
      const pendingSourceRef = initialPendingSourceRef;
      await this.deleteCredentialSourceIfPresent(pendingSourceRef);
      integration = await this.integrations.abortStaticCredentialPending(
        input.userId,
        input.environmentId,
        input.name,
        {
          expectedVersion: integrationVersion(integration),
          expectedPendingSourceRef: pendingSourceRef,
        },
      );
    }

    const initialRetiringSourceRef =
      integration.retiringCredentialSourceRef;
    if (initialRetiringSourceRef) {
      if (integration.lifecycleStatus !== "updating") {
        integration = await this.integrations.markIntegration(
          input.userId,
          input.environmentId,
          input.name,
          { lifecycleStatus: "updating", lastError: null },
        );
      }
      await this.applyEffectiveNetworkPolicy(input.environmentId);
      const retiringSourceRef = initialRetiringSourceRef;
      await this.deleteCredentialSourceIfPresent(retiringSourceRef);
      integration =
        await this.integrations.finishStaticCredentialRetirement(
          input.userId,
          input.environmentId,
          input.name,
          {
            expectedVersion: integrationVersion(integration),
            expectedRetiringSourceRef: retiringSourceRef,
          },
        );
    }

    const sourceRef = integration.credentialSourceRef;
    if (sourceRef) {
      integration = await this.integrations.markIntegration(
        input.userId,
        input.environmentId,
        input.name,
        { lifecycleStatus: "deleting", lastError: null },
      );
      try {
        await this.applyEffectiveNetworkPolicy(input.environmentId);
        await this.deleteCredentialSourceIfPresent(sourceRef);
        const cleared =
          await this.integrations.clearStaticCredentialForRuntime(
            input.environmentId,
            input.name,
            {
              expectedVersion: integrationVersion(integration),
              expectedSourceRef: sourceRef,
            },
          );
        if (!cleared) {
          throw conflict(
            "mcp_integration_changed",
            "The MCP integration changed while its credential was removed.",
          );
        }
        integration = cleared;
      } catch (error) {
        await this.integrations
          .markIntegration(
            input.userId,
            input.environmentId,
            input.name,
            {
              lifecycleStatus: "deleting",
              lastError: "MCP credential cleanup requires retry.",
            },
          )
          .catch(() => undefined);
        throw error;
      }
    } else if (
      input.preserveAssociation &&
      (integration.lifecycleStatus !== "active" ||
        integration.credentialStatus !== "missing")
    ) {
      integration = await this.integrations.markIntegration(
        input.userId,
        input.environmentId,
        input.name,
        {
          lifecycleStatus: "active",
          credentialStatus: "missing",
          lastError: null,
        },
      );
    }

    if (!input.preserveAssociation) {
      await this.integrations.deleteIntegration(
        input.userId,
        input.environmentId,
        input.name,
      );
    }
  }

  private async markStaticMutationError(
    input: { userId: string; environmentId: string; name: string },
    reason: string,
  ) {
    await this.integrations
      .markIntegration(input.userId, input.environmentId, input.name, {
        lifecycleStatus: "error",
        lastError:
          reason === "credential_rotation_failed"
            ? "MCP credential rotation failed."
            : "MCP credential network policy could not be applied.",
      })
      .catch(() => undefined);
  }

  private async cancelActiveOAuthFlowRecord(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    const blocking = await this.integrations.findBlockingOAuthFlow(
      input.userId,
      input.environmentId,
    );
    if (blocking?.serverName !== input.name) return undefined;
    if (
      blocking.status === "cancelled" ||
      blocking.status === "expired"
    ) {
      return blocking;
    }
    return this.integrations.markOAuthFlow(
      input.userId,
      input.environmentId,
      blocking.id,
      {
        status: "cancelled",
        error: null,
        expectedConfigFingerprint: blocking.configFingerprint,
      },
    );
  }

  private async requireOAuthDefinitionMutationReady(input: {
    userId: string;
    environmentId: string;
    name: string;
  }) {
    await this.reconcileEnvironmentOAuthCleanup(input.environmentId);
    let blocking = await this.integrations.findBlockingOAuthFlow(
      input.userId,
      input.environmentId,
    );
    if (blocking?.serverName !== input.name) return;
    if (
      blocking.status === "starting" ||
      blocking.status === "awaiting_user"
    ) {
      blocking = await this.integrations.markOAuthFlow(
        input.userId,
        input.environmentId,
        blocking.id,
        {
          status: "cancelled",
          error: null,
          expectedConfigFingerprint: blocking.configFingerprint,
        },
      );
    }
    let runtime: StoredEnvironmentRuntime | undefined;
    if (!blocking.cleanupCompletedAt) {
      runtime = await this.codex.environmentRuntimeForMcp(
        input.userId,
        input.environmentId,
      );
      await this.codex.discardEnvironmentMcpOAuthCredential(
        runtime,
        input.name,
      );
      blocking = await this.markOAuthCleanupCompleted(blocking);
    }
    await this.reconcileEnvironmentOAuthThreadCleanup(
      input.environmentId,
      runtime,
    );
    throw conflict(
      "mcp_oauth_flow_quarantined",
      "Wait for the previous MCP OAuth attempt to expire before changing this server.",
      {
        flowId: blocking.id,
        retryAt: blocking.expiresAt.toISOString(),
      },
    );
  }

  private async markOAuthCleanupCompleted(flow: EnvironmentMcpOAuthFlow) {
    if (flow.cleanupCompletedAt) return flow;
    const completed =
      await this.integrations.markOAuthFlowCleanupCompletedForRuntime(
        flow.environmentId,
        flow.serverName,
        {
          flowId: flow.id,
          expectedConfigFingerprint: flow.configFingerprint,
          expectedEndpointFingerprint:
            oauthFlowEndpointFingerprint(flow),
        },
      );
    if (completed) return completed;
    const latest = await this.integrations.findLatestOAuthFlowForRuntime(
      flow.environmentId,
      flow.serverName,
    );
    if (latest?.id === flow.id && latest.cleanupCompletedAt) return latest;
    throw conflict(
      "mcp_oauth_flow_changed",
      "The MCP OAuth authorization changed during credential cleanup.",
    );
  }

  private async invalidateOAuthAfterStaleSuccess(
    environmentId: string,
    serverName: string,
  ) {
    const active =
      await this.integrations.findActiveOAuthFlowForRuntime(environmentId);
    if (active?.serverName === serverName) {
      const failed = await this.integrations.markOAuthFlowForRuntime(
        environmentId,
        serverName,
        {
          status: "failed",
          error:
            "A stale MCP OAuth completion changed the native credential slot.",
          expectedConfigFingerprint: active.configFingerprint,
          expectedEndpointFingerprint:
            oauthFlowEndpointFingerprint(active),
        },
      );
      if (failed) return;
    }
    try {
      const integration =
        await this.integrations.getIntegrationForRuntime(
          environmentId,
          serverName,
        );
      if (integration.authMode !== "oauth") return;
      await this.integrations.markIntegrationForRuntime(
        environmentId,
        serverName,
        {
          lifecycleStatus: "active",
          credentialStatus: "reauth-required",
          lastError:
            "A stale MCP OAuth completion was discarded. Reconnect this server.",
          expectedEndpointFingerprint: integration.endpointFingerprint,
        },
      );
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === "mcp_integration_not_found"
      ) {
        return;
      }
      throw error;
    }
  }

  private async terminalOAuthStartRace(
    userId: string,
    environmentId: string,
    flowId: string,
    nativeThreadId: string | undefined,
  ) {
    if (!nativeThreadId) return undefined;
    let flow: EnvironmentMcpOAuthFlow;
    try {
      flow = await this.integrations.getOAuthFlow(
        userId,
        environmentId,
        flowId,
      );
    } catch {
      return undefined;
    }
    return flow.nativeThreadId === nativeThreadId &&
      isTerminalOAuthStatus(flow.status)
      ? flow
      : undefined;
  }

  private async reconcileEnvironmentOAuthCleanup(
    environmentId: string,
    runtime?: StoredEnvironmentRuntime,
  ) {
    await this.integrations.expireOAuthFlows(environmentId);
    const [credentialCleanup, threadCleanup] = await Promise.all([
      this.integrations.listCancelledOAuthFlowsForRuntime(environmentId),
      this.integrations.listOAuthThreadCleanupForRuntime(environmentId),
    ]);
    if (credentialCleanup.length === 0 && threadCleanup.length === 0) return;
    const environmentRuntime =
      runtime ?? (await this.store.environmentRuntime(environmentId));
    for (const flow of credentialCleanup) {
      await this.codex.discardEnvironmentMcpOAuthCredential(
        environmentRuntime,
        flow.serverName,
      );
      await this.markOAuthCleanupCompleted(flow);
    }
    await this.reconcileEnvironmentOAuthThreadCleanup(
      environmentId,
      environmentRuntime,
      threadCleanup,
    );
    await this.integrations.expireOAuthFlows(environmentId);
  }

  private async reconcileEnvironmentOAuthThreadCleanup(
    environmentId: string,
    runtime?: StoredEnvironmentRuntime,
    knownFlows?: readonly EnvironmentMcpOAuthFlow[],
  ) {
    const pending =
      knownFlows ??
      (await this.integrations.listOAuthThreadCleanupForRuntime(
        environmentId,
      ));
    if (pending.length === 0) return;
    const environmentRuntime =
      runtime ?? (await this.store.environmentRuntime(environmentId));
    for (const flow of pending) {
      const nativeThreadId = flow.nativeThreadId;
      const nativeRuntime = flow.nativeRuntime;
      if (!nativeThreadId || !nativeRuntime) {
        throw new Error(
          "Pending MCP OAuth Thread cleanup has no native correlation.",
        );
      }
      const sameRuntime =
        nativeRuntime.runtimeGeneration ===
          environmentRuntime.runtimeGeneration &&
        (nativeRuntime.attemptId ?? "") ===
          (environmentRuntime.attemptId ?? "");
      if (
        sameRuntime &&
        environmentRuntime.desiredState === "running" &&
        environmentRuntime.observedState === "running"
      ) {
        await this.codex.releaseEnvironmentMcpOAuthCorrelationThread(
          environmentRuntime,
          nativeThreadId,
        );
      }
      const completed =
        await this.integrations.markOAuthThreadCleanupCompletedForRuntime(
          environmentId,
          flow.serverName,
          {
            flowId: flow.id,
            nativeThreadId,
            expectedConfigFingerprint: flow.configFingerprint,
            expectedEndpointFingerprint:
              oauthFlowEndpointFingerprint(flow),
          },
        );
      if (completed) continue;
      const latest =
        await this.integrations.findOAuthFlowByNativeThreadForRuntime(
          environmentId,
          flow.serverName,
          nativeThreadId,
        );
      if (!latest?.nativeThreadCleanupCompletedAt) {
        throw conflict(
          "mcp_oauth_thread_cleanup_changed",
          "The MCP OAuth correlation Thread changed during cleanup.",
        );
      }
    }
  }

  private async deleteCredentialSourceIfPresent(sourceRef: string) {
    try {
      await this.runtime.deleteCredentialSource(sourceRef);
    } catch (error) {
      if (!isMissingCredentialSource(error)) throw error;
    }
  }

  private async withLifecycleMutation<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + MCP_MUTATION_LOCK_TIMEOUT_MS;
    const lockStore = this.lockScope.getStore() ?? this.store;
    while (Date.now() < deadline) {
      const result = await lockStore.withEnvironmentLifecycleLock(
        environmentId,
        (lockedStore) => operation(lockedStore ?? this.store),
      );
      if (result.acquired) return result.value;
      await delay(100);
    }
    throw new HttpError(
      503,
      "environment_lifecycle_busy",
      "Timed out waiting to update the Environment MCP network policy.",
    );
  }

  private async withMutation<T>(
    environmentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutations.get(environmentId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => this.withDistributedMutation(environmentId, operation));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(environmentId, tail);
    try {
      return await result;
    } finally {
      if (this.mutations.get(environmentId) === tail) {
        this.mutations.delete(environmentId);
      }
    }
  }

  private async withDistributedMutation<T>(
    environmentId: string,
    operation: () => Promise<T>,
  ) {
    const deadline = Date.now() + MCP_MUTATION_LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await this.store.withEnvironmentMcpMutationLock(
        environmentId,
        (lockedStore) => {
          const scopedStore = lockedStore ?? this.store;
          return this.lockScope.run(scopedStore, () =>
            this.codex.withAdvisoryLockStore(scopedStore, operation),
          );
        },
      );
      if (result.acquired) return result.value;
      await delay(100);
    }
    throw new HttpError(
      503,
      "mcp_integration_busy",
      "Timed out waiting to update the Environment MCP integration.",
    );
  }
}

function prepareDefinition(
  name: string,
  server: CodexMcpServerInput,
  metadata: CodexMcpDefinitionMetadata,
  existing?: EnvironmentMcpIntegration,
) {
  requireServerName(name);
  const preset = resolvePreset(metadata.presetId);
  if (server.transport === "stdio") {
    if (preset && preset.transport !== "stdio") {
      throw new HttpError(
        400,
        "mcp_preset_transport_mismatch",
        "The selected MCP preset does not use STDIO.",
      );
    }
    if (metadata.authMode && metadata.authMode !== "none") {
      throw new HttpError(
        400,
        "mcp_local_auth_unsupported",
        "Local STDIO MCP credentials are not supported by this integration.",
      );
    }
    return undefined;
  }

  const endpoint = remoteEndpoint(server.url);
  const authMode = metadata.authMode ?? "none";
  if (
    !metadata.networkApproved &&
    existing?.endpointFingerprint !== endpoint.fingerprint
  ) {
    throw new HttpError(
      400,
      "mcp_network_destination_not_approved",
      "Review and authorize the remote MCP network destination.",
    );
  }
  validateRemotePreset(name, server, preset, authMode);
  const projection = definitionProjection(authMode, preset);
  return {
    preset,
    authMode,
    endpoint,
    headerName: projection.headerName,
    valueTemplate: projection.valueTemplate,
  };
}

function resolvePreset(presetId: string | undefined) {
  if (!presetId) return undefined;
  const preset = CODEX_MCP_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new HttpError(
      400,
      "mcp_preset_not_found",
      "The selected MCP preset is not available.",
    );
  }
  return preset;
}

function validateRemotePreset(
  name: string,
  server: CodexMcpServerInput | CodexMcpServer,
  preset: CodexMcpPreset | undefined,
  authMode: CodexMcpRemoteAuthMethod,
) {
  if (!preset) return;
  if (preset.transport !== "streamable-http" || server.transport !== preset.transport) {
    throw new HttpError(
      400,
      "mcp_preset_transport_mismatch",
      "The selected MCP preset does not use Streamable HTTP.",
    );
  }
  if (
    name !== preset.name ||
    remoteEndpoint(server.url).canonicalUrl !== remoteEndpoint(preset.url).canonicalUrl
  ) {
    throw new HttpError(
      400,
      "mcp_preset_definition_mismatch",
      "The MCP name or endpoint no longer matches the selected preset. Use a custom server instead.",
    );
  }
  const allowed =
    authMode === "none"
      ? preset.auth.requirement !== "required"
      : preset.auth.methods.includes(
          authMode as Exclude<CodexMcpRemoteAuthMethod, "none">,
        );
  if (!allowed) {
    throw new HttpError(
      400,
      "mcp_preset_auth_mismatch",
      "The selected authentication method is not supported by this MCP preset.",
    );
  }
}

function resolveCredentialPreset(
  name: string,
  server: CodexMcpServer,
  presetId: string | undefined,
  method: "bearer" | "header",
) {
  const preset = resolvePreset(presetId);
  validateRemotePreset(name, server, preset, method);
  return preset;
}

function resolveOAuthPreset(
  name: string,
  server: CodexMcpServer,
  presetId: string | undefined,
) {
  const preset = resolvePreset(presetId);
  validateRemotePreset(name, server, preset, "oauth");
  return preset;
}

function definitionProjection(
  authMode: McpIntegrationAuthMode,
  preset?: CodexMcpPreset,
) {
  if (authMode === "bearer") {
    return {
      headerName: "Authorization",
      valueTemplate: "Bearer {{ .token }}",
    };
  }
  if (authMode === "header") {
    return {
      headerName: preset?.auth.headerName ?? "X-API-Key",
      valueTemplate: managedValueTemplate(preset?.auth.valueTemplate),
    };
  }
  return {};
}

function staticProjection(
  input: CodexMcpCredentialInput,
  preset?: CodexMcpPreset,
) {
  if (/[\u0000\r\n]/.test(input.secret)) {
    throw new HttpError(
      400,
      "mcp_credential_invalid",
      "MCP credentials cannot contain NUL, CR, or LF characters.",
    );
  }
  if (input.method === "bearer") {
    if (
      (input.headerName && input.headerName !== "Authorization") ||
      (input.valueTemplate &&
        input.valueTemplate.trim() !== "Bearer {{ .token }}")
    ) {
      throw new HttpError(
        400,
        "mcp_credential_projection_invalid",
        "Bearer credentials use the managed Authorization header.",
      );
    }
    return {
      headerName: "Authorization",
      valueTemplate: "Bearer {{ .token }}",
    };
  }
  const presetHeader = preset?.auth.headerName;
  const headerName = (presetHeader ?? input.headerName)?.trim();
  if (!headerName) {
    throw new HttpError(
      400,
      "mcp_credential_header_required",
      "A custom API-key credential requires a header name.",
    );
  }
  if (presetHeader && input.headerName && input.headerName.trim() !== presetHeader) {
    throw new HttpError(
      400,
      "mcp_credential_projection_invalid",
      "The credential header does not match the selected preset.",
    );
  }
  const presetTemplate = preset?.auth.valueTemplate;
  if (
    presetTemplate &&
    input.valueTemplate &&
    input.valueTemplate.trim() !== presetTemplate
  ) {
    throw new HttpError(
      400,
      "mcp_credential_projection_invalid",
      "The credential value template does not match the selected preset.",
    );
  }
  return {
    headerName,
    valueTemplate: managedValueTemplate(
      presetTemplate ?? input.valueTemplate,
    ),
  };
}

function managedValueTemplate(value: string | undefined) {
  const normalized = value?.trim() || "{{ .token }}";
  const match = MANAGED_TEMPLATE.exec(normalized);
  if (!match) {
    throw new HttpError(
      400,
      "mcp_credential_projection_invalid",
      "The credential template may contain only one managed token placeholder.",
    );
  }
  return buildMcpCredentialValueTemplate(match[1]);
}

function remoteEndpoint(value: string | undefined): RemoteEndpoint {
  if (!value) {
    throw new HttpError(
      400,
      "mcp_remote_url_required",
      "A remote MCP server requires a URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(
      400,
      "mcp_remote_url_invalid",
      "The remote MCP URL is invalid.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash
  ) {
    throw new HttpError(
      400,
      "mcp_remote_url_unsafe",
      "Managed remote MCP servers require HTTPS on port 443 without embedded credentials or fragments.",
    );
  }
  url.hostname = url.hostname.toLowerCase();
  url.port = "";
  const canonicalUrl = url.toString();
  return {
    canonicalUrl,
    fingerprint: sha256(canonicalUrl),
    domain: url.hostname,
    path: url.pathname || "/",
  };
}

function oauthConfigFingerprint(
  name: string,
  endpoint: RemoteEndpoint,
  scopes: readonly string[],
) {
  return sha256(
    JSON.stringify({
      name,
      endpoint: endpoint.canonicalUrl,
      scopes,
    }),
  );
}

function decorateInventory(
  inventory: CodexMcpInventory,
  integrations: readonly EnvironmentMcpIntegration[],
): CodexMcpInventory {
  const byName = new Map(
    integrations.map((integration) => [integration.serverName, integration]),
  );
  return {
    servers: inventory.servers.map((server) => {
      const integration = byName.get(server.name);
      if (!integration) return server;
      const currentFingerprint =
        server.transport === "streamable-http" && server.url
          ? remoteEndpoint(server.url).fingerprint
          : undefined;
      const drifted =
        currentFingerprint !== undefined &&
        currentFingerprint !== integration.endpointFingerprint;
      const credentialState = integrationCredentialState(
        integration,
        server,
        drifted,
      );
      const readiness = integrationReadiness(
        integration,
        server,
        drifted,
      );
      const toolPolicy = isAggregatorMcpPreset(integration.presetId)
        ? {
            enforcement: "platform" as const,
            allowedTools: [],
          }
        : {
            enforcement: "sandbox0" as const,
            mode: integration.toolPolicyMode,
            allowedTools: [...integration.allowedTools],
            status: drifted ? ("error" as const) : integration.toolPolicyStatus,
            ...((drifted
              ? "The MCP endpoint changed outside Sandpi; save it again before relying on its tool policy."
              : integration.toolPolicyError)
              ? {
                  error: drifted
                    ? "The MCP endpoint changed outside Sandpi; save it again before relying on its tool policy."
                    : integration.toolPolicyError,
                }
              : {}),
          };
      return {
        ...server,
        presetId: integration.presetId,
        authMode: integration.authMode,
        credentialState,
        readiness,
        toolPolicy,
        startupError: integration.lastError ?? server.startupError,
      };
    }),
  };
}

function toManagedMcpToolPolicy(
  integration: EnvironmentMcpIntegration,
): ManagedMcpToolPolicy {
  const delegated = isAggregatorMcpPreset(integration.presetId);
  return {
    serverName: integration.serverName,
    destinationDomain: integration.destinationDomain,
    destinationPath: integration.destinationPath,
    mode: delegated ? "delegated" : integration.toolPolicyMode,
    allowedTools:
      !delegated && integration.toolPolicyMode === "selected"
        ? integration.allowedTools
        : [],
  };
}

function validateMcpToolPolicy(
  server: CodexMcpServer,
  input: CodexMcpToolPolicyInput,
): CodexMcpToolPolicyInput {
  const allowedTools = [
    ...new Set(
      input.allowedTools.map((value) => {
        const name = value.trim();
        if (!name || name.length > 256 || name.includes("\0")) {
          throw new HttpError(
            400,
            "mcp_tool_policy_invalid",
            "MCP tool names must be 1 to 256 safe characters.",
          );
        }
        return name;
      }),
    ),
  ].sort();
  if (input.mode === "all") {
    if (allowedTools.length > 0) {
      throw new HttpError(
        400,
        "mcp_tool_policy_invalid",
        "All-tools mode cannot contain an allowlist.",
      );
    }
    return { mode: "all", allowedTools: [] };
  }
  if (allowedTools.length === 0) {
    throw new HttpError(
      400,
      "mcp_tool_policy_empty",
      "Select at least one MCP tool, or disable the MCP server instead.",
    );
  }
  const advertised = new Set(server.tools.map((tool) => tool.name));
  const unknown = allowedTools.filter((name) => !advertised.has(name));
  if (unknown.length > 0) {
    throw conflict(
      "mcp_tool_inventory_changed",
      "The MCP tool inventory changed. Refresh it before saving the policy.",
    );
  }
  return { mode: "selected", allowedTools };
}

function integrationCredentialState(
  integration: EnvironmentMcpIntegration,
  server: CodexMcpServer,
  drifted: boolean,
): CodexMcpCredentialState {
  if (integration.authMode === "none") return "public";
  if (drifted) return "reauth-required";
  if (isStaticAuth(integration.authMode)) {
    return integration.credentialSourceRef &&
      (integration.credentialStatus === "configured" ||
        integration.credentialStatus === "authorized")
      ? "key-configured"
      : "key-missing";
  }
  if (integration.credentialStatus === "error") {
    return "reauth-required";
  }
  if (
    integration.credentialStatus === "reauth-required" ||
    (integration.credentialStatus === "authorized" &&
      server.authStatus === "notLoggedIn")
  ) {
    return "reauth-required";
  }
  if (
    integration.credentialStatus === "authorized" ||
    server.authStatus === "oAuth"
  ) {
    return "oauth-authorized";
  }
  return "oauth-required";
}

function integrationReadiness(
  integration: EnvironmentMcpIntegration,
  server: CodexMcpServer,
  drifted: boolean,
): CodexMcpReadiness {
  if (drifted) return "stale";
  if (
    integration.lifecycleStatus === "error" ||
    integration.credentialStatus === "error" ||
    server.startupError
  ) {
    return "failed";
  }
  if (!server.enabled) return "disabled";
  if (server.hasServerInfo || server.runtimeStatus === "connected") return "ready";
  if (integration.credentialStatus === "authorizing") return "checking";
  return server.readiness ?? "unknown";
}

function publicOAuthFlow(
  flow: EnvironmentMcpOAuthFlow,
  authorizationUrl?: string,
): CodexMcpOAuthFlow {
  return {
    id: flow.id,
    serverName: flow.serverName,
    status: flow.status,
    ...(authorizationUrl ? { authorizationUrl } : {}),
    expiresAt: flow.expiresAt.toISOString(),
    ...(flow.error ? { error: flow.error } : {}),
  };
}

function callbackUrl(publicUrl: string) {
  let published: URL;
  try {
    published = new URL(publicUrl);
  } catch {
    throw invalidOAuthCallbackUrl();
  }
  if (
    published.protocol !== "https:" ||
    published.username ||
    published.password ||
    published.search ||
    published.hash ||
    (published.pathname !== "/" && published.pathname !== "")
  ) {
    throw invalidOAuthCallbackUrl();
  }
  return new URL(
    `${CODEX_MCP_OAUTH_CALLBACK_BASE_PATH}/`,
    published.origin,
  ).toString();
}

function invalidOAuthCallbackUrl() {
  return new HttpError(
    502,
    "sandbox0_mcp_oauth_callback_url_invalid",
    "Sandbox0 returned an unsafe MCP OAuth callback URL.",
  );
}

function safeOAuthAuthorizationUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidOAuthAuthorizationUrl();
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw invalidOAuthAuthorizationUrl();
  }
  return url.toString();
}

function invalidOAuthAuthorizationUrl() {
  return new HttpError(
    502,
    "codex_mcp_oauth_authorization_url_invalid",
    "Codex returned an invalid MCP OAuth authorization URL.",
  );
}

function isStaticAuth(
  value: McpIntegrationAuthMode,
): value is "bearer" | "header" {
  return value === "bearer" || value === "header";
}

function staticIntegrationNeedsReconciliation(
  integration: EnvironmentMcpIntegration,
) {
  return (
    isStaticAuth(integration.authMode) &&
    (integration.lifecycleStatus !== "active" ||
      integration.credentialStatus === "error" ||
      Boolean(integration.pendingCredentialSourceRef) ||
      Boolean(integration.retiringCredentialSourceRef))
  );
}

function reconciliationChanged() {
  return conflict(
    "mcp_integration_changed",
    "The MCP integration changed during reconciliation.",
  );
}

function integrationVersion(integration: EnvironmentMcpIntegration) {
  if (
    !Number.isSafeInteger(integration.version) ||
    (integration.version ?? 0) <= 0
  ) {
    throw new Error("MCP integration has no valid mutation version.");
  }
  return integration.version!;
}

function oauthFlowEndpointFingerprint(flow: EnvironmentMcpOAuthFlow) {
  if (!flow.endpointFingerprint) {
    throw new Error("MCP OAuth flow has no endpoint fingerprint.");
  }
  return flow.endpointFingerprint;
}

function oauthFlowMatchesNativeEvent(
  flow: EnvironmentMcpOAuthFlow,
  event: CodexNativeEventIdentity,
) {
  return (
    flow.nativeRuntime?.runtimeGeneration === event.runtimeGeneration &&
    (flow.nativeRuntime.attemptId ?? "") === (event.attemptId ?? "")
  );
}

function isTerminalOAuthStatus(
  status: EnvironmentMcpOAuthFlow["status"],
) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

function remoteServerMatchesEndpoint(
  server: CodexMcpServer,
  endpointFingerprint: string,
) {
  try {
    return remoteEndpoint(server.url).fingerprint === endpointFingerprint;
  } catch {
    return false;
  }
}

function normalizeStringSet(values: readonly string[] | undefined) {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim()).filter(Boolean),
    ),
  ].sort();
}

function sameStringSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) {
  const normalizedLeft = normalizeStringSet(left);
  const normalizedRight = normalizeStringSet(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function requireServerName(value: string) {
  if (!MCP_SERVER_NAME.test(value.trim())) {
    throw new HttpError(
      400,
      "invalid_codex_mcp_server_name",
      "MCP server names may contain letters, numbers, hyphens and underscores.",
    );
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function objectString(
  value: Record<string, unknown> | undefined,
  key: string,
) {
  const item = value?.[key];
  return typeof item === "string" && item ? item : undefined;
}

function objectBoolean(
  value: Record<string, unknown> | undefined,
  key: string,
) {
  const item = value?.[key];
  return typeof item === "boolean" ? item : undefined;
}

function safeErrorMessage(error: unknown) {
  return error instanceof HttpError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.name
      : "unknown error";
}

function isMissingCredentialSource(error: unknown) {
  return (
    error instanceof HttpError &&
    (error.statusCode === 404 ||
      error.code === "sandbox0_not_found" ||
      error.code === "sandbox0_credential_source_not_found")
  );
}

function isMissingMcpServer(error: unknown) {
  return (
    error instanceof HttpError &&
    (error.statusCode === 404 ||
      error.code === "codex_mcp_server_not_found" ||
      error.code === "codex_mcp_server_not_managed")
  );
}
