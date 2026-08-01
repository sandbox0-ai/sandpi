import { createHash, randomBytes } from "node:crypto";

import type {
  GitHubWebhookConnectionInventory,
  GitHubWebhookInstallAttempt,
  GitHubWebhookRepository,
} from "@/lib/types";
import { toUnixTimestamp } from "@/lib/time";
import type { SandpiConfig } from "@/server/config";
import { HttpError } from "@/server/http-error";
import type { SandpiStore } from "@/server/store";
import type { GitHubWebhookClient } from "./github-webhook-client";
import {
  normalizeGitHubWebhookDelivery,
  verifyGitHubWebhookDelivery,
  type VerifiedGitHubWebhookDelivery,
} from "./github-webhook-ingress";
import {
  GitHubWebhookSourceStore,
  type ClaimedGitHubWebhookReceipt,
} from "./github-webhook-store";
import type { EnvironmentWebhookService } from "./webhook-service";

interface GitHubWebhookLogger {
  warn(fields: object, message: string): void;
}

const CONNECTION_ATTEMPT_TTL_MS = 15 * 60 * 1_000;
const RECEIPT_POLL_INTERVAL_MS = 1_000;
const RECEIPT_LEASE_MS = 30_000;
const RECEIPT_RETRY_MS = 30_000;

/** Owns GitHub App installation proof, verified ingress, and event routing. */
export class GitHubWebhookSourceService {
  private timer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private started = false;
  private closed = false;

  constructor(
    private readonly sources: GitHubWebhookSourceStore,
    private readonly environments: SandpiStore,
    private readonly webhooks: EnvironmentWebhookService,
    private readonly client: GitHubWebhookClient | undefined,
    private readonly configuration: SandpiConfig["githubWebhooks"],
    private readonly logger: GitHubWebhookLogger,
    private readonly options: {
      now?: () => Date;
      pollIntervalMs?: number;
      receiptLeaseMs?: number;
      receiptRetryMs?: number;
    } = {},
  ) {}

  async start() {
    if (this.started || !this.configuration || !this.client) return;
    this.started = true;
    void this.reconcileOnce().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Initial GitHub Webhook receipt reconciliation deferred",
      );
    });
    this.schedule();
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.reconciliation;
  }

  async inventory(
    userId: string,
    environmentId: string,
  ): Promise<GitHubWebhookConnectionInventory> {
    await this.environments.getEnvironment(userId, environmentId);
    return {
      configured: Boolean(this.configuration && this.client),
      ...(this.configuration ? { appSlug: this.configuration.appSlug } : {}),
      connections: await this.sources.listConnections(userId),
    };
  }

  async startInstall(
    userId: string,
    environmentId: string,
  ): Promise<GitHubWebhookInstallAttempt> {
    const configuration = this.requireConfigured();
    await this.environments.getEnvironment(userId, environmentId);
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + CONNECTION_ATTEMPT_TTL_MS);
    await this.sources.createAttempt({
      stateDigest: stateDigest(state),
      userId,
      environmentId,
      expiresAt,
    });
    const authorizationUrl = new URL(
      `/apps/${encodeURIComponent(configuration.appSlug)}/installations/new`,
      "https://github.com",
    );
    authorizationUrl.searchParams.set("state", state);
    return {
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: toUnixTimestamp(expiresAt),
    };
  }

  async completeInstall(code: string, state: string, installationId: string) {
    const client = this.requireClient();
    this.requireConfigured();
    const attempt = await this.sources.consumeAttempt(
      stateDigest(state),
      this.now(),
    );
    const accessToken = await client.exchangeAuthorizationCode(code);
    const installations = await client.listUserInstallations(accessToken);
    const installation = installations.find(
      (candidate) => candidate.installationId === installationId,
    );
    if (!installation) {
      throw new HttpError(
        409,
        "github_webhook_installation_missing",
        "The installed Sandpi GitHub App is not accessible to the authorizing GitHub user.",
      );
    }
    const connectionIds = await this.sources.upsertInstallations(
      attempt.userId,
      [installation],
    );
    return {
      environmentId: attempt.environmentId,
      connectionCount: connectionIds.length,
    };
  }

  async disconnect(userId: string, environmentId: string, connectionId: string) {
    await this.environments.getEnvironment(userId, environmentId);
    await this.sources.disconnect(userId, connectionId);
  }

  async receive(input: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }) {
    const configuration = this.requireConfigured();
    const delivery = verifyGitHubWebhookDelivery({
      secret: configuration.webhookSecret,
      rawBody: input.rawBody,
      headers: input.headers,
      now: this.now(),
    });
    const inserted = await this.sources.enqueue(delivery);
    this.wake();
    return {
      statusCode: inserted ? (202 as const) : (200 as const),
      body: {
        status: inserted ? "accepted" : "duplicate",
        deliveryId: delivery.deliveryId,
      },
    };
  }

  async reconcileOnce() {
    if (this.closed || !this.configuration || !this.client) return;
    if (this.reconciliation) return this.reconciliation;
    const run = this.reconcile().finally(() => {
      if (this.reconciliation === run) this.reconciliation = undefined;
    });
    this.reconciliation = run;
    return run;
  }

  private async reconcile() {
    for (let processed = 0; processed < 50; processed += 1) {
      const now = this.now();
      const receipt = await this.sources.claim(
        now,
        new Date(
          now.getTime() +
            (this.options.receiptLeaseMs ?? RECEIPT_LEASE_MS),
        ),
      );
      if (!receipt) return;
      await this.processReceipt(receipt);
    }
  }

  private async processReceipt(receipt: ClaimedGitHubWebhookReceipt) {
    try {
      const lifecycle = await this.applyLifecycleEvent(receipt.delivery);
      if (lifecycle) {
        await this.sources.finish(
          receipt.id,
          receipt.leaseToken,
          "completed",
          lifecycle,
          this.now(),
        );
        return;
      }
      const { installationId, repository } = receipt.delivery;
      if (!installationId || !repository) {
        await this.sources.finish(
          receipt.id,
          receipt.leaseToken,
          "ignored",
          "The GitHub event has no routable installation and repository.",
          this.now(),
        );
        return;
      }
      await this.sources.updateInstallationRepositories({
        installationId,
        added: [repository],
        removedIds: [],
      });
      const routes = await this.sources.routes(installationId, repository.id);
      if (!routes.length) {
        await this.sources.finish(
          receipt.id,
          receipt.leaseToken,
          "ignored",
          "No enabled Environment Webhook is bound to this repository.",
          this.now(),
        );
        return;
      }
      for (const route of routes) {
        const webhook = await this.webhooks
          .getEnabledForProvider(route.webhookId)
          .catch((error) => {
            if (
              error instanceof HttpError &&
              error.code === "environment_webhook_not_found"
            ) {
              return undefined;
            }
            throw error;
          });
        if (!webhook) continue;
        const event = normalizeGitHubWebhookDelivery({
          delivery: receipt.delivery,
          connectionId: route.connectionId,
          accountId: route.accountId,
          accountLogin: route.accountLogin,
        });
        const accepted = await this.webhooks.acceptVerifiedEvent(webhook, event);
        if (accepted.kind === "stale") {
          throw new Error("The routed Webhook changed while GitHub delivery was accepted.");
        }
      }
      await this.sources.finish(
        receipt.id,
        receipt.leaseToken,
        "completed",
        undefined,
        this.now(),
      );
    } catch (error) {
      await this.sources.defer({
        receiptId: receipt.id,
        leaseToken: receipt.leaseToken,
        attemptCount: receipt.attemptCount,
        error: errorMessage(error),
        retryAt: new Date(
          this.now().getTime() +
            (this.options.receiptRetryMs ?? RECEIPT_RETRY_MS),
        ),
        now: this.now(),
      });
      this.logger.warn(
        {
          receiptId: receipt.id,
          deliveryId: receipt.delivery.deliveryId,
          attemptCount: receipt.attemptCount,
          error: errorMessage(error),
        },
        "GitHub Webhook receipt deferred",
      );
    }
  }

  private async applyLifecycleEvent(delivery: VerifiedGitHubWebhookDelivery) {
    if (delivery.eventName === "ping") return "GitHub App ping accepted.";
    if (!delivery.installationId) return undefined;
    if (delivery.eventName === "installation") {
      const action = delivery.action;
      const status =
        action === "deleted"
          ? "revoked"
          : action === "suspend"
            ? "suspended"
            : action === "created" ||
                action === "unsuspend" ||
                action === "new_permissions_accepted"
              ? "active"
              : undefined;
      if (!status) return `Ignored GitHub installation action ${action ?? "unknown"}.`;
      const installation = record(delivery.payload.installation);
      const account = record(installation?.account);
      await this.sources.setInstallationStatus({
        installationId: delivery.installationId,
        status,
        ...(scalarId(account?.id) ? { accountId: scalarId(account?.id) } : {}),
        ...(scalarString(account?.login)
          ? { accountLogin: scalarString(account?.login) }
          : {}),
        ...(scalarString(account?.type) ? { accountType: scalarString(account?.type) } : {}),
        ...(installation?.repository_selection === "all" ||
        installation?.repository_selection === "selected"
          ? { repositorySelection: installation.repository_selection }
          : {}),
        ...(status === "active"
          ? {}
          : { error: `The GitHub App installation was ${status}.` }),
      });
      return `GitHub App installation marked ${status}.`;
    }
    if (delivery.eventName === "installation_repositories") {
      await this.sources.updateInstallationRepositories({
        installationId: delivery.installationId,
        added: repositoryArray(delivery.payload.repositories_added),
        removedIds: repositoryArray(delivery.payload.repositories_removed).map(
          (repository) => repository.id,
        ),
      });
      return "GitHub App repository access synchronized.";
    }
    return undefined;
  }

  private schedule() {
    if (this.closed || !this.configuration || !this.client) return;
    this.timer = setTimeout(() => {
      void this.reconcileOnce()
        .catch((error) => {
          this.logger.warn(
            { error: errorMessage(error) },
            "GitHub Webhook reconciliation failed",
          );
        })
        .finally(() => this.schedule());
    }, this.options.pollIntervalMs ?? RECEIPT_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  private wake() {
    if (!this.started || this.closed) return;
    void this.reconcileOnce().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "GitHub Webhook wake-up reconciliation failed",
      );
    });
  }

  private requireConfigured() {
    if (!this.configuration || !this.client) {
      throw new HttpError(
        409,
        "github_webhook_not_configured",
        "The Sandpi deployment has not configured a GitHub App for Webhooks.",
      );
    }
    return this.configuration;
  }

  private requireClient() {
    this.requireConfigured();
    return this.client!;
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }
}

function stateDigest(state: string) {
  if (state.length < 32 || state.length > 1_000) {
    throw new HttpError(
      400,
      "github_webhook_connection_state_invalid",
      "The GitHub connection state is invalid.",
    );
  }
  return createHash("sha256").update(state).digest();
}

function repositoryArray(value: unknown): GitHubWebhookRepository[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const repository = record(candidate);
    const id = scalarId(repository?.id);
    const fullName = scalarString(repository?.full_name);
    if (!id || !fullName || typeof repository?.private !== "boolean") return [];
    const defaultBranch = scalarString(repository.default_branch);
    return [
      {
        id,
        fullName,
        private: repository.private,
        ...(defaultBranch ? { defaultBranch } : {}),
      },
    ];
  });
}

function record(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scalarId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return undefined;
}

function scalarString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
