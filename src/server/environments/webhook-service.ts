import { randomBytes, randomUUID } from "node:crypto";

import type {
  EnvironmentWebhook,
  EnvironmentWebhookCondition,
  EnvironmentWebhookCooldownPolicy,
  EnvironmentWebhookSetup,
  EnvironmentWebhookTarget,
  EnvironmentWebhookTriggerPolicy,
} from "@/lib/types";
import { GITHUB_WEBHOOK_EVENT_TYPE_VALUES } from "@/lib/github-webhooks";
import { EnvironmentAutomationExecutor } from "@/server/automations/executor";
import type { CodexService } from "@/server/harnesses/codex/service";
import { HttpError } from "@/server/http-error";
import type { SecretBox } from "@/server/secrets";
import type { SandpiStore } from "@/server/store";
import {
  normalizeAuthenticatedWebhookRequest,
  type NormalizedWebhookEvent,
} from "./webhook-ingress";
import {
  EnvironmentWebhookStore,
  publicEnvironmentWebhook,
  type StoredEnvironmentWebhook,
  type WebhookMutableConfiguration,
  type WebhookSourceConfiguration,
} from "./webhook-store";

interface WebhookLogger {
  warn(fields: object, message: string): void;
}

interface WebhookCodex {
  ensureAutomationSession(
    input: Parameters<CodexService["ensureAutomationSession"]>[0],
  ): ReturnType<CodexService["ensureAutomationSession"]>;
  startTurn(
    input: Parameters<CodexService["startTurn"]>[0],
  ): ReturnType<CodexService["startTurn"]>;
  readAutomationTurnStatus(
    input: Parameters<CodexService["readAutomationTurnStatus"]>[0],
  ): ReturnType<CodexService["readAutomationTurnStatus"]>;
}

export interface EnvironmentWebhookConfiguration
  extends Omit<WebhookMutableConfiguration, "source"> {
  source?: WebhookSourceConfiguration;
  secret?: string;
}

const WEBHOOK_POLL_INTERVAL_MS = 2_000;
const WEBHOOK_RUN_LEASE_MS = 30_000;
const MAX_NORMALIZED_EVENT_BYTES = 64 * 1024;

/** Owns Webhook management, verified ingress, and native Turn reconciliation. */
export class EnvironmentWebhookService {
  private timer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private closed = false;
  private started = false;
  private readonly executor: EnvironmentAutomationExecutor;

  constructor(
    private readonly webhooks: EnvironmentWebhookStore,
    private readonly store: SandpiStore,
    codex: WebhookCodex,
    private readonly secretBox: SecretBox | undefined,
    private readonly publicUrl: URL,
    private readonly logger: WebhookLogger,
    private readonly options: {
      pollIntervalMs?: number;
      runLeaseMs?: number;
      runningRecheckMs?: number;
      transientRetryMs?: number;
      batchSize?: number;
      now?: () => Date;
    } = {},
  ) {
    this.executor = new EnvironmentAutomationExecutor(
      store,
      codex,
      logger,
      options,
    );
  }

  async start() {
    if (this.started) return;
    this.started = true;
    void this.reconcileOnce().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Initial Environment Webhook reconciliation deferred",
      );
    });
    this.schedule();
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.reconciliation;
  }

  async list(userId: string, environmentId: string) {
    await this.store.getEnvironment(userId, environmentId);
    return (await this.webhooks.list(userId, environmentId)).map((webhook) =>
      this.publicWebhook(webhook),
    );
  }

  async create(
    userId: string,
    environmentId: string,
    input: EnvironmentWebhookConfiguration,
  ): Promise<EnvironmentWebhookSetup> {
    const id = `webhook_${randomUUID()}`;
    const configuration = await this.normalizeConfiguration(
      userId,
      environmentId,
      input,
    );
    if (configuration.source.kind === "github" && input.secret) {
      throw githubSecretUnsupported();
    }
    const secret =
      configuration.source.kind === "custom"
        ? configuredSecret(input.secret)
        : undefined;
    const webhook = await this.webhooks.create({
      id,
      userId,
      environmentId,
      ...(secret
        ? {
            endpointId: `hook_${randomUUID()}`,
            secret: this.requireSecretBox().encrypt(
              secret.value,
              secretAssociatedData(id),
            ),
          }
        : {}),
      configuration,
    });
    return {
      webhook: this.publicWebhook(webhook),
      ...(secret?.generated ? { setupSecret: secret.value } : {}),
    };
  }

  async update(
    userId: string,
    environmentId: string,
    webhookId: string,
    input: EnvironmentWebhookConfiguration,
  ): Promise<EnvironmentWebhookSetup> {
    const current = await this.webhooks.get(userId, environmentId, webhookId);
    const configuration = await this.normalizeConfiguration(
      userId,
      environmentId,
      input,
    );
    if (current.source.kind !== configuration.source.kind) {
      throw new HttpError(
        400,
        "environment_webhook_source_immutable",
        "Create a new Webhook to change its source.",
      );
    }
    if (configuration.source.kind === "github" && input.secret) {
      throw githubSecretUnsupported();
    }
    let setupSecret: string | undefined;
    let encryptedSecret;
    if (input.secret) {
      const secret = configuredSecret(input.secret);
      encryptedSecret = this.requireSecretBox().encrypt(
        secret.value,
        secretAssociatedData(current.id),
      );
      if (secret.generated) setupSecret = secret.value;
    }
    const webhook = await this.webhooks.update({
      userId,
      environmentId,
      webhookId,
      expectedRevision: current.revision,
      configuration,
      resetTriggerState:
        triggerPolicyFingerprint(current.triggerPolicy) !==
        triggerPolicyFingerprint(configuration.triggerPolicy),
      ...(encryptedSecret ? { secret: encryptedSecret } : {}),
    });
    this.wake();
    return {
      webhook: this.publicWebhook(webhook),
      ...(setupSecret ? { setupSecret } : {}),
    };
  }

  async rotateSecret(
    userId: string,
    environmentId: string,
    webhookId: string,
    suppliedSecret?: string,
  ): Promise<EnvironmentWebhookSetup> {
    const current = await this.webhooks.get(userId, environmentId, webhookId);
    if (current.source.kind !== "custom") {
      throw githubSecretUnsupported();
    }
    const secret = configuredSecret(suppliedSecret);
    const webhook = await this.webhooks.update({
      userId,
      environmentId,
      webhookId,
      expectedRevision: current.revision,
      configuration: { ...current, source: { kind: "custom" } },
      secret: this.requireSecretBox().encrypt(
        secret.value,
        secretAssociatedData(current.id),
      ),
    });
    return {
      webhook: this.publicWebhook(webhook),
      ...(secret.generated ? { setupSecret: secret.value } : {}),
    };
  }

  async delete(userId: string, environmentId: string, webhookId: string) {
    await this.webhooks.delete(userId, environmentId, webhookId);
  }

  async listRuns(
    userId: string,
    environmentId: string,
    webhookId: string,
    limit?: number,
  ) {
    await this.webhooks.get(userId, environmentId, webhookId);
    return this.webhooks.listRuns(userId, environmentId, webhookId, limit);
  }

  async listDeliveries(
    userId: string,
    environmentId: string,
    webhookId: string,
    limit?: number,
  ) {
    await this.webhooks.get(userId, environmentId, webhookId);
    return this.webhooks.listDeliveries(
      userId,
      environmentId,
      webhookId,
      limit,
    );
  }

  async receive(input: {
    endpointId: string;
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
    contentType?: string;
    queryToken?: string;
  }): Promise<{ statusCode: 200 | 202; body: unknown }> {
    let webhook = await this.webhooks.getByEndpoint(input.endpointId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (webhook.source.kind !== "custom" || !webhook.secret) {
        throw new HttpError(
          404,
          "environment_webhook_not_found",
          "Webhook not found.",
        );
      }
      const secret = this.requireSecretBox().decrypt(
        webhook.secret,
        secretAssociatedData(webhook.id),
      );
      const event = normalizeAuthenticatedWebhookRequest({
        secret,
        rawBody: input.rawBody,
        headers: input.headers,
        contentType: input.contentType,
        queryToken: input.queryToken,
        now: this.now(),
      });
      const result = await this.acceptVerifiedEvent(webhook, event);
      if (result.kind === "stale") {
        webhook = await this.webhooks.getByEndpoint(input.endpointId);
        continue;
      }
      return {
        statusCode:
          result.kind === "duplicate" ? 200 : 202,
        body: {
          status: result.kind,
          deliveryId: event.deliveryId,
          ...(result.kind === "queued" ? { runId: result.runId } : {}),
        },
      };
    }
    throw new HttpError(
      409,
      "environment_webhook_changed",
      "The Webhook changed while the delivery was being accepted; retry it.",
    );
  }

  async getEnabledForProvider(webhookId: string) {
    const webhook = await this.webhooks.getEnabledById(webhookId);
    if (webhook.source.kind !== "github") {
      throw new HttpError(
        404,
        "environment_webhook_not_found",
        "Webhook not found.",
      );
    }
    return webhook;
  }

  async acceptVerifiedEvent(
    webhook: StoredEnvironmentWebhook,
    receivedEvent: NormalizedWebhookEvent,
  ) {
    const event = boundedWebhookEvent(
      configuredEventCoordinates(webhook, receivedEvent),
    );
    const match = webhookEventMatches(webhook.triggerPolicy, event);
    const result = await this.webhooks.ingestDelivery({
      webhook,
      event,
      matched: match.matched,
      filterReason: match.reason,
      now: this.now(),
    });
    if (result.kind !== "stale") this.wake();
    return result;
  }

  async reconcileOnce() {
    if (this.closed) return;
    if (this.reconciliation) return this.reconciliation;
    const run = this.reconcile().finally(() => {
      if (this.reconciliation === run) this.reconciliation = undefined;
    });
    this.reconciliation = run;
    return run;
  }

  private async normalizeConfiguration(
    userId: string,
    environmentId: string,
    input: EnvironmentWebhookConfiguration,
  ): Promise<WebhookMutableConfiguration> {
    await this.store.getEnvironment(userId, environmentId);
    if (input.target.kind === "session") {
      const session = await this.store.getSession(userId, input.target.sessionId);
      if (session.environmentId !== environmentId) {
        throw new HttpError(
          400,
          "environment_webhook_target_invalid",
          "The target Session must belong to this Environment.",
        );
      }
      if (session.archived) {
        throw new HttpError(
          409,
          "environment_webhook_target_archived",
          "Unarchive the target Session before using it as a Webhook target.",
        );
      }
    }
    const source = normalizedSource(input.source);
    const statePath =
      input.triggerPolicy.mode === "stateChange"
        ? input.triggerPolicy.statePath?.trim() ||
          (source.kind === "github" ? "/stateValue" : "/payload/status")
        : input.triggerPolicy.statePath?.trim();
    const eventTypes = Array.from(
      new Set(input.triggerPolicy.eventTypes.map((value) => value.trim())),
    ).filter(Boolean);
    if (source.kind === "github") {
      if (!eventTypes.length) {
        throw new HttpError(
          400,
          "environment_webhook_github_events_required",
          "Select at least one GitHub event.",
        );
      }
      const unsupported = eventTypes.filter(
        (eventType) => !GITHUB_WEBHOOK_EVENT_TYPE_VALUES.has(eventType),
      );
      if (unsupported.length) {
        throw new HttpError(
          400,
          "environment_webhook_github_events_unsupported",
          `Unsupported GitHub event types: ${unsupported.join(", ")}.`,
        );
      }
    }
    return {
      source,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      triggerPolicy: {
        mode: input.triggerPolicy.mode,
        eventTypes,
        conditions: input.triggerPolicy.conditions.map(normalizedCondition),
        ...(statePath ? { statePath } : {}),
        ...(input.triggerPolicy.groupKeyPath?.trim()
          ? { groupKeyPath: input.triggerPolicy.groupKeyPath.trim() }
          : {}),
      },
      cooldownPolicy: input.cooldownPolicy,
      target: input.target,
      overlapPolicy: input.overlapPolicy,
      maxConcurrentRuns:
        input.target.kind === "session" ? 1 : input.maxConcurrentRuns,
      maxPendingRuns: input.maxPendingRuns,
      enabled: input.enabled,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.modelId?.trim() ? { modelId: input.modelId.trim() } : {}),
      ...(input.reasoningEffort?.trim()
        ? { reasoningEffort: input.reasoningEffort.trim() }
        : {}),
      ...(input.collaborationMode
        ? { collaborationMode: input.collaborationMode }
        : {}),
      ...(input.serviceTier?.trim()
        ? { serviceTier: input.serviceTier.trim() }
        : {}),
    };
  }

  private schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.reconcileOnce()
        .catch((error) => {
          this.logger.warn(
            { error: errorMessage(error) },
            "Environment Webhook reconciliation failed",
          );
        })
        .finally(() => this.schedule());
    }, this.options.pollIntervalMs ?? WEBHOOK_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  private wake() {
    if (!this.started || this.closed) return;
    void this.reconcileOnce().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Environment Webhook wake-up reconciliation failed",
      );
    });
  }

  private async reconcile() {
    const limit = this.options.batchSize ?? 50;
    const bucketKeys = await this.webhooks.dueBucketKeys(this.now(), limit);
    for (const key of bucketKeys) {
      await this.webhooks.releaseDueBucket({ ...key, now: this.now() });
    }
    const runIds = await this.webhooks.dueRunIds(this.now(), limit);
    for (const runId of runIds) await this.reconcileRun(runId);
  }

  private async reconcileRun(runId: string) {
    const now = this.now();
    const claimed = await this.webhooks.claimRunLease(
      runId,
      randomUUID(),
      new Date(
        now.getTime() +
          (this.options.runLeaseMs ?? WEBHOOK_RUN_LEASE_MS),
      ),
      now,
    );
    if (!claimed) return;
    await this.executor.execute({
      definition: {
        id: claimed.webhook.id,
        sourceKind: "webhook",
        environmentId: claimed.webhook.environmentId,
        createdByUserId: claimed.webhook.createdByUserId,
        name: claimed.webhook.name,
        overlapPolicy: claimed.run.overlapPolicy,
      },
      run: claimed.run,
      persistence: {
        markRunning: (run) => this.webhooks.markRunRunning(run),
        defer: (run) => this.webhooks.deferRun(run),
        finish: (run) => this.webhooks.finishRun(run),
      },
    });
  }

  private publicWebhook(webhook: StoredEnvironmentWebhook): EnvironmentWebhook {
    return publicEnvironmentWebhook(
      webhook,
      webhook.endpointId
        ? new URL(
            `/api/v1/webhooks/${encodeURIComponent(webhook.endpointId)}`,
            this.publicUrl,
          ).toString()
        : undefined,
    );
  }

  private requireSecretBox() {
    if (!this.secretBox) {
      throw new HttpError(
        409,
        "credential_encryption_not_configured",
        "SANDPI_SECRET_KEY must be configured before creating Webhooks.",
      );
    }
    return this.secretBox;
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }
}

export function webhookEventMatches(
  policy: EnvironmentWebhookTriggerPolicy,
  event: NormalizedWebhookEvent,
): { matched: boolean; reason?: string } {
  if (policy.eventTypes.length && !policy.eventTypes.includes(event.eventType)) {
    return {
      matched: false,
      reason: `Event type ${event.eventType} is not enabled.`,
    };
  }
  for (const condition of policy.conditions) {
    if (!conditionMatches(event, condition)) {
      return {
        matched: false,
        reason: `Condition ${condition.path} ${condition.operator} did not match.`,
      };
    }
  }
  return { matched: true };
}

function configuredEventCoordinates(
  webhook: StoredEnvironmentWebhook,
  event: NormalizedWebhookEvent,
) {
  const envelope = event as unknown as Record<string, unknown>;
  const configuredGroup = webhook.triggerPolicy.groupKeyPath
    ? scalarValue(jsonPointer(envelope, webhook.triggerPolicy.groupKeyPath))
    : undefined;
  const configuredState = webhook.triggerPolicy.statePath
    ? scalarValue(jsonPointer(envelope, webhook.triggerPolicy.statePath))
    : event.stateValue;
  return {
    ...event,
    groupKey: boundedText(configuredGroup ?? event.groupKey, 500),
    ...(configuredState !== undefined ? { stateValue: configuredState } : {}),
  };
}

function conditionMatches(
  event: NormalizedWebhookEvent,
  condition: EnvironmentWebhookCondition,
) {
  const actual = jsonPointer(
    event as unknown as Record<string, unknown>,
    condition.path,
  );
  if (condition.operator === "exists") return actual !== undefined;
  const expected = condition.value ?? "";
  if (condition.operator === "equals") return scalarValue(actual) === expected;
  if (condition.operator === "notEquals") {
    return scalarValue(actual) !== expected;
  }
  if (typeof actual === "string") return actual.includes(expected);
  if (Array.isArray(actual)) {
    return actual.some((candidate) => scalarValue(candidate) === expected);
  }
  return false;
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function scalarValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  return undefined;
}

function boundedWebhookEvent(
  event: NormalizedWebhookEvent,
): NormalizedWebhookEvent {
  const payloadJson = JSON.stringify(event.payload);
  const payload =
    Buffer.byteLength(payloadJson, "utf8") <= MAX_NORMALIZED_EVENT_BYTES
      ? event.payload
      : {
          truncated: true,
          preview: Buffer.from(payloadJson, "utf8")
            .subarray(0, MAX_NORMALIZED_EVENT_BYTES - 512)
            .toString("utf8"),
        };
  return {
    ...event,
    deliveryId: boundedText(event.deliveryId, 500),
    eventType: boundedText(event.eventType, 200),
    groupKey: boundedText(event.groupKey, 500),
    summary: boundedText(event.summary, 1_000),
    payload,
    ...(event.stateValue !== undefined
      ? { stateValue: event.stateValue.slice(0, 1_000) }
      : {}),
  };
}

function normalizedCondition(
  condition: EnvironmentWebhookCondition,
): EnvironmentWebhookCondition {
  return {
    path: condition.path.trim(),
    operator: condition.operator,
    ...(condition.value !== undefined ? { value: condition.value } : {}),
  };
}

function triggerPolicyFingerprint(policy: EnvironmentWebhookTriggerPolicy) {
  return JSON.stringify({
    mode: policy.mode,
    eventTypes: [...policy.eventTypes].sort(),
    conditions: policy.conditions
      .map((condition) =>
        JSON.stringify({
          path: condition.path,
          operator: condition.operator,
          value: condition.value ?? null,
        }),
      )
      .sort(),
    statePath: policy.statePath ?? null,
    groupKeyPath: policy.groupKeyPath ?? null,
  });
}

function configuredSecret(supplied: string | undefined) {
  const value = supplied?.trim();
  if (value) return { value, generated: false };
  return { value: randomBytes(32).toString("base64url"), generated: true };
}

function normalizedSource(
  source: EnvironmentWebhookConfiguration["source"],
): WebhookSourceConfiguration {
  if (!source || source.kind === "custom") return { kind: "custom" };
  return {
    kind: "github",
    connectionId: source.connectionId.trim(),
    repositoryIds: Array.from(
      new Set(source.repositoryIds.map((repositoryId) => repositoryId.trim())),
    ).filter(Boolean),
  };
}

function githubSecretUnsupported() {
  return new HttpError(
    400,
    "environment_webhook_secret_unsupported",
    "GitHub Webhooks use the deployment GitHub App and do not have a per-Webhook secret.",
  );
}

function secretAssociatedData(webhookId: string) {
  return `environment-webhook:${webhookId}:secret`;
}

function boundedText(value: string, maximum: number) {
  const normalized = value.trim() || "default";
  return normalized.length <= maximum ? normalized : normalized.slice(0, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function defaultWebhookCooldownPolicy(): EnvironmentWebhookCooldownPolicy {
  return { mode: "none" };
}

export function defaultWebhookTarget(): EnvironmentWebhookTarget {
  return { kind: "newSession" };
}
