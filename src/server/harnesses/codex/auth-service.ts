import { setTimeout as delay } from "node:timers/promises";

import type {
  CodexAccountPlanType,
  CodexAccountSummary,
} from "@/harnesses/codex/environment-tools";
import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { SecretBox, type EncryptedValue } from "@/server/secrets";
import { SandpiStore } from "@/server/store";
import {
  CodexAuthStore,
  type CodexDeviceAuthFlow,
  publicCodexDeviceAuthFlow,
} from "./auth-store";
import type { CodexCredentialMaterial } from "./service";
import {
  decodeCodexSupervisorEvents,
  type DecodedCodexRecord,
  type SupervisorOutputEvent,
} from "./jsonl";

const LOGIN_FLOW_LIFETIME_MS = 20 * 60 * 1_000;
const RPC_TIMEOUT_MS = 30_000;
const WORKER_INTERVAL_MS = 1_000;
const CREDENTIAL_ASSOCIATED_DATA_PREFIX = "sandpi:codex:environment-credential:";
const CODEX_ACCOUNT_PLAN_TYPES = new Set<CodexAccountPlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

interface AuthLogger {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export class CodexEnvironmentAuthService {
  private readonly workers = new Map<string, AbortController>();
  private readonly operations = new Map<string, Promise<CodexDeviceAuthFlow>>();

  constructor(
    private readonly store: SandpiStore,
    private readonly authStore: CodexAuthStore,
    private readonly runtime: RuntimeAdapter,
    private readonly secretBox: SecretBox | undefined,
    private readonly logger: AuthLogger,
  ) {}

  async startDeviceLogin(userId: string, environmentId: string) {
    this.requireEncryption();
    const environment = await this.store.getManageableEnvironment(
      userId,
      environmentId,
    );

    const expired = await this.authStore.findExpiredFlow(userId, environmentId);
    if (expired) await this.expireAndCleanup(expired);

    const { flow: initial, created } = await this.authStore.createFlow({
      userId,
      environmentId,
      expiresAt: new Date(Date.now() + LOGIN_FLOW_LIFETIME_MS),
    });
    if (!created) {
      const flow = await this.refresh(initial.id);
      this.ensureWorker(flow.id);
      return publicCodexDeviceAuthFlow(flow);
    }

    let flow = initial;
    try {
      const runtime = await this.runtime.provisionCodexAuth(environment, flow.id);
      flow = await this.authStore.attachRuntime(flow.id, runtime);
      flow = await this.refresh(flow.id);
      this.ensureWorker(flow.id);
      return publicCodexDeviceAuthFlow(flow);
    } catch (error) {
      if (flow.runtime) await this.cleanup(flow);
      await this.authStore.markTerminal(
        flow.id,
        "failed",
        errorMessage(error),
      );
      throw error;
    }
  }

  async getDeviceLogin(userId: string, environmentId: string, flowId: string) {
    await this.authStore.getFlow(userId, environmentId, flowId);
    const flow = await this.refresh(flowId);
    if (isActive(flow)) this.ensureWorker(flow.id);
    return publicCodexDeviceAuthFlow(flow);
  }

  async activeDeviceLogin(userId: string, environmentId: string) {
    const expired = await this.authStore.findExpiredFlow(userId, environmentId);
    if (expired) await this.expireAndCleanup(expired);
    const active = await this.authStore.findActiveFlow(userId, environmentId);
    if (!active) return undefined;
    const flow = await this.refresh(active.id);
    if (isActive(flow)) this.ensureWorker(flow.id);
    return publicCodexDeviceAuthFlow(flow);
  }

  async cancelDeviceLogin(userId: string, environmentId: string, flowId: string) {
    let flow = await this.authStore.getFlow(userId, environmentId, flowId);
    if (!isActive(flow)) return publicCodexDeviceAuthFlow(flow);

    const worker = this.workers.get(flow.id);
    worker?.abort();
    this.workers.delete(flow.id);
    if (flow.runtime && flow.nativeLoginId) {
      await this.runtime
        .writeCodexAuthMessage(
          flow.runtime,
          {
            method: "account/login/cancel",
            id: `account-login-cancel:${flow.id}`,
            params: { loginId: flow.nativeLoginId },
          },
          `account-login-cancel:${flow.id}`,
        )
        .catch(() => undefined);
    }
    flow = await this.authStore.markTerminal(flow.id, "cancelled");
    await this.cleanup(flow);
    return publicCodexDeviceAuthFlow(flow);
  }

  async cancelEnvironmentDeviceLogin(userId: string, environmentId: string) {
    const active = await this.authStore.findActiveFlow(userId, environmentId);
    if (!active) return;
    await this.cancelDeviceLogin(userId, environmentId, active.id);
  }

  async credentialForEnvironment(userId: string, environmentId: string) {
    this.requireEncryption();
    const stored = await this.authStore.getCredential(userId, environmentId);
    if (!stored) {
      throw new HttpError(
        409,
        "codex_not_connected",
        "Connect this environment to ChatGPT before creating a session.",
      );
    }
    return this.materializeCredential(environmentId, stored);
  }

  async credentialForEnvironmentRuntime(environmentId: string) {
    const stored = await this.authStore.getCredentialForEnvironmentRuntime(
      environmentId,
    );
    if (!stored) {
      throw new HttpError(409, "codex_not_connected", "Codex is not connected.");
    }
    return this.materializeCredential(stored.environmentId, stored);
  }

  async markCredentialMaterialized(
    environmentId: string,
    credential: CodexCredentialMaterial,
  ) {
    await this.authStore.markCredentialMaterialized(
      environmentId,
      credential.sourceId,
      credential.revision,
    );
  }

  async syncCredentialFromRuntime(environmentId: string, authJson: string) {
    validateCodexCredentialJson(authJson);
    const stored = await this.authStore.getCredentialForEnvironmentRuntime(
      environmentId,
    );
    if (!stored) return;
    const current = this.decryptCredential(stored.environmentId, stored.encrypted);
    if (current === authJson) {
      await this.authStore.markCredentialMaterialized(
        environmentId,
        stored.sourceId,
        stored.revision,
      );
      return undefined;
    }
    const encrypted = this.requireEncryption().encrypt(
      authJson,
      codexCredentialAssociatedData(stored.environmentId),
    );
    const result = await this.authStore.replaceCredentialFromEnvironment(
      environmentId,
      stored.bindingSourceId,
      encrypted,
    );
    if (result.replaced) return undefined;
    return this.materializeCredential(stored.environmentId, result.credential);
  }

  async accountForEnvironment(
    userId: string,
    environmentId: string,
  ): Promise<CodexAccountSummary | null> {
    const environment = await this.store.getEnvironment(userId, environmentId);
    if (environment.codingAgent.harness !== "codex") {
      throw new HttpError(
        409,
        "environment_harness_mismatch",
        "This Environment is not bound to the Codex harness.",
      );
    }
    const stored = await this.authStore.getCredential(userId, environmentId);
    if (!stored) return null;
    return publicAccountMetadata(
      stored.metadata,
      environment.codingAgent.lastVerified,
    );
  }

  async resumePending() {
    for (const flow of await this.authStore.expiredFlows()) {
      await this.expireAndCleanup(flow);
    }
    // A provisioning row has no durable Sandbox0 coordinates yet. Its sandbox
    // is bounded by hard TTL, while failing the row immediately unblocks retry.
    await this.authStore.failInterruptedProvisioningFlows();
    const flows = await this.authStore.resumableFlows();
    for (const flow of flows) this.ensureWorker(flow.id);
  }

  private async expireAndCleanup(flow: CodexDeviceAuthFlow) {
    const expired = await this.authStore.markTerminal(
      flow.id,
      "expired",
      "The device-code login expired.",
    );
    await this.cleanup(expired);
  }

  async close() {
    for (const controller of this.workers.values()) controller.abort();
    this.workers.clear();
  }

  private requireEncryption() {
    if (!this.secretBox) {
      throw new HttpError(
        503,
        "credential_encryption_not_configured",
        "SANDPI_SECRET_KEY must be configured before connecting Codex.",
      );
    }
    return this.secretBox;
  }

  private decryptCredential(environmentId: string, encrypted: EncryptedValue) {
    try {
      const authJson = this.requireEncryption().decrypt(
        encrypted,
        codexCredentialAssociatedData(environmentId),
      );
      validateCodexCredentialJson(authJson);
      return authJson;
    } catch {
      throw new HttpError(
        500,
        "codex_credential_unreadable",
        "The environment's Codex credentials cannot be decrypted.",
      );
    }
  }

  private materializeCredential(
    environmentId: string,
    stored: {
      sourceId: string;
      revision: number;
      encrypted: EncryptedValue;
    },
  ): CodexCredentialMaterial {
    return {
      sourceId: stored.sourceId,
      revision: stored.revision,
      authJson: this.decryptCredential(environmentId, stored.encrypted),
    };
  }

  private ensureWorker(flowId: string) {
    if (this.workers.has(flowId)) return;
    const controller = new AbortController();
    this.workers.set(flowId, controller);
    void this.runWorker(flowId, controller.signal).finally(() => {
      if (this.workers.get(flowId) === controller) this.workers.delete(flowId);
    });
  }

  private async runWorker(flowId: string, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const flow = await this.refresh(flowId);
        if (!isActive(flow)) return;
      } catch (error) {
        this.logger.error(
          { flowId, error: errorMessage(error) },
          "Codex device login polling failed",
        );
      }
      await delay(WORKER_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
    }
  }

  private refresh(flowId: string) {
    const previous = this.operations.get(flowId) ?? Promise.resolve(undefined);
    const operation = previous
      .catch(() => undefined)
      .then(() => this.advance(flowId));
    this.operations.set(flowId, operation);
    void operation.then(
      () => {
        if (this.operations.get(flowId) === operation) this.operations.delete(flowId);
      },
      () => {
        if (this.operations.get(flowId) === operation) this.operations.delete(flowId);
      },
    );
    return operation;
  }

  private async advance(flowId: string): Promise<CodexDeviceAuthFlow> {
    let flow = await this.authStore.getFlowById(flowId);
    if (!isActive(flow)) return flow;
    if (flow.expiresAt.getTime() <= Date.now()) {
      flow = await this.authStore.markTerminal(
        flow.id,
        "expired",
        "The device-code login expired.",
      );
      await this.cleanup(flow);
      return flow;
    }
    if (!flow.runtime) return flow;

    if (flow.status === "starting") {
      const initialized = await this.rpc(flow, `initialize:${flow.id}`, {
        method: "initialize",
        id: `initialize:${flow.id}`,
        params: {
          clientInfo: { name: "sandpi", title: "Sandpi", version: "0.1.0" },
        },
      });
      if (initialized.error) throw rpcError("codex_initialize_failed", initialized.error);
      flow = await this.authStore.getFlowById(flow.id);
      await this.runtime.writeCodexAuthMessage(
        flow.runtime!,
        { method: "initialized", params: {} },
        `initialized:${flow.id}`,
      );
      const login = await this.rpc(flow, `account-login:${flow.id}`, {
        method: "account/login/start",
        id: `account-login:${flow.id}`,
        params: { type: "chatgptDeviceCode" },
      });
      if (login.error) throw rpcError("codex_login_start_failed", login.error);
      const device = deviceLoginResponse(login.result);
      flow = await this.authStore.markAwaitingUser(flow.id, device);
    }

    flow = await this.ingest(flow);
    const completion = loginCompletion(flow);
    if (!completion) return flow;
    if (!completion.success) {
      const failed = await this.authStore.markTerminal(
        flow.id,
        "failed",
        completion.error ?? "Codex login failed.",
      );
      await this.cleanup(failed);
      return failed;
    }

    const account = await this.rpc(flow, `account-read:${flow.id}`, {
      method: "account/read",
      id: `account-read:${flow.id}`,
      params: { refreshToken: false },
    });
    if (account.error) throw rpcError("codex_account_read_failed", account.error);
    flow = await this.authStore.getFlowById(flow.id);
    const authJson = await this.runtime.readCodexAuthJson(flow.runtime!);
    validateCodexCredentialJson(authJson);
    const encrypted = this.requireEncryption().encrypt(
      authJson,
      codexCredentialAssociatedData(flow.environmentId),
    );
    const completed = await this.authStore.completeWithCredential({
      flowId: flow.id,
      environmentId: flow.environmentId,
      encrypted,
      metadata: accountMetadata(account.result),
    });
    await this.cleanup(completed);
    return completed;
  }

  private async rpc(
    initial: CodexDeviceAuthFlow,
    requestId: string,
    message: Record<string, unknown>,
  ) {
    let flow = initial;
    const existing = rpcResponse(flow, requestId);
    if (existing) return existing;
    if (!flow.runtime) throw new Error("Codex login runtime is unavailable");
    await this.runtime.writeCodexAuthMessage(
      flow.runtime,
      message,
      `rpc:${requestId}`,
    );
    const deadline = Date.now() + RPC_TIMEOUT_MS;
    while (Date.now() < deadline) {
      flow = await this.ingest(flow);
      const response = rpcResponse(flow, requestId);
      if (response) return response;
      await delay(200);
    }
    throw new HttpError(
      504,
      "codex_auth_rpc_timeout",
      `Codex did not answer ${String(message.method)} in time.`,
    );
  }

  private async ingest(initial: CodexDeviceAuthFlow) {
    if (!initial.runtime) return initial;
    const page = await this.runtime.listCodexAuthEvents(
      initial.runtime,
      initial.decoder.supervisorCursor,
    );
    const events = page.events
      .map(supervisorOutputEvent)
      .filter((event): event is SupervisorOutputEvent => event !== undefined);
    if (events.length === 0) return this.authStore.getFlowById(initial.id);
    const decoded = decodeCodexSupervisorEvents(initial.decoder, events);
    if (decoded.invalidRecords.length > 0) {
      this.logger.warn(
        { flowId: initial.id, count: decoded.invalidRecords.length },
        "Codex device login emitted invalid JSONL records",
      );
    }
    return this.authStore.persistProtocol(
      initial.id,
      decoded.state,
      decoded.records.filter(keepAuthProtocolRecord).map((record) => record.message),
    );
  }

  private async cleanup(flow: CodexDeviceAuthFlow) {
    if (!flow.runtime) return;
    try {
      await this.runtime.deleteCodexAuthResources(flow.runtime);
    } catch (error) {
      this.logger.warn(
        { flowId: flow.id, error: errorMessage(error) },
        "Codex device login sandbox cleanup failed",
      );
    }
  }
}

function keepAuthProtocolRecord(record: DecodedCodexRecord) {
  if ("id" in record.message) return true;
  return record.message.method === "account/login/completed";
}

function rpcResponse(flow: CodexDeviceAuthFlow, requestId: string) {
  return flow.protocolMessages.find(
    (message) => message.id === requestId && !("method" in message),
  );
}

function deviceLoginResponse(value: unknown) {
  if (!isRecord(value) || value.type !== "chatgptDeviceCode") {
    throw new HttpError(
      502,
      "codex_login_response_invalid",
      "Codex returned an invalid device-code response.",
    );
  }
  const nativeLoginId = value.loginId;
  const verificationUrl = value.verificationUrl;
  const userCode = value.userCode;
  if (
    typeof nativeLoginId !== "string" ||
    typeof verificationUrl !== "string" ||
    typeof userCode !== "string"
  ) {
    throw new HttpError(
      502,
      "codex_login_response_invalid",
      "Codex returned an incomplete device-code response.",
    );
  }
  return { nativeLoginId, verificationUrl, userCode };
}

function loginCompletion(flow: CodexDeviceAuthFlow) {
  const message = [...flow.protocolMessages]
    .reverse()
    .find((candidate) => candidate.method === "account/login/completed");
  if (!message || !isRecord(message.params)) return undefined;
  if (
    flow.nativeLoginId &&
    message.params.loginId !== null &&
    message.params.loginId !== flow.nativeLoginId
  ) {
    return undefined;
  }
  return {
    success: message.params.success === true,
    error:
      typeof message.params.error === "string" ? message.params.error : undefined,
  };
}

function accountMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.account)) {
    return { type: "chatgpt" };
  }
  const account = value.account;
  return {
    type: account.type === "chatgpt" ? "chatgpt" : "unknown",
    ...(typeof account.email === "string" ? { email: account.email } : {}),
    ...(typeof account.planType === "string" ? { planType: account.planType } : {}),
  };
}

function publicAccountMetadata(
  metadata: Record<string, unknown>,
  lastVerified: CodexAccountSummary["lastVerified"],
): CodexAccountSummary {
  const email = boundedMetadataString(metadata.email, 320);
  const planType =
    typeof metadata.planType === "string" &&
    CODEX_ACCOUNT_PLAN_TYPES.has(metadata.planType as CodexAccountPlanType)
      ? (metadata.planType as CodexAccountPlanType)
      : undefined;
  return {
    type: metadata.type === "chatgpt" ? "chatgpt" : "unknown",
    ...(email ? { email } : {}),
    ...(planType ? { planType } : {}),
    ...(lastVerified === undefined ? {} : { lastVerified }),
  };
}

function boundedMetadataString(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength
    ? normalized
    : undefined;
}

export function validateCodexCredentialJson(authJson: string) {
  const value = JSON.parse(authJson) as unknown;
  if (!isRecord(value)) throw new Error("Codex auth.json must contain an object");
}

function supervisorOutputEvent(value: unknown): SupervisorOutputEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.seq !== "number" ||
    typeof value.runtimeGeneration !== "number" ||
    typeof value.type !== "string" ||
    typeof value.occurredAt !== "string"
  ) {
    return undefined;
  }
  return value as unknown as SupervisorOutputEvent;
}

function rpcError(code: string, value: unknown) {
  const message = isRecord(value) && typeof value.message === "string"
    ? value.message
    : "Codex returned an RPC error.";
  return new HttpError(502, code, message);
}

export function codexCredentialAssociatedData(environmentId: string) {
  return `${CREDENTIAL_ASSOCIATED_DATA_PREFIX}${environmentId}`;
}

function isActive(flow: CodexDeviceAuthFlow) {
  return ["provisioning", "starting", "awaiting_user"].includes(flow.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
