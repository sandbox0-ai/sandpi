import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  GitHubWebhookConnection,
  GitHubWebhookRepository,
} from "@/lib/types";
import { toUnixTimestamp } from "@/lib/time";
import { conflict, notFound } from "@/server/http-error";
import type { GitHubInstallationInventory } from "./github-webhook-client";
import type { VerifiedGitHubWebhookDelivery } from "./github-webhook-ingress";

interface GitHubConnectionRow extends QueryResultRow {
  id: string;
  created_by_user_id: string;
  installation_id: string;
  account_id: string;
  account_login: string;
  account_type: string;
  repository_selection: "all" | "selected";
  status: "active" | "suspended" | "revoked" | "disconnected";
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface GitHubRepositoryRow extends QueryResultRow {
  connection_id: string;
  repository_id: string;
  full_name: string;
  private: boolean;
  default_branch: string | null;
}

interface GitHubReceiptRow extends QueryResultRow {
  id: string;
  delivery_id: string;
  event_name: string;
  action: string | null;
  installation_id: string | null;
  repository_id: string | null;
  payload: unknown;
  status: "queued" | "processing" | "completed" | "ignored" | "failed";
  attempt_count: number;
  lease_token: string | null;
  received_at: Date;
}

export interface RoutedGitHubWebhook {
  webhookId: string;
  connectionId: string;
  accountId: string;
  accountLogin: string;
}

export interface ClaimedGitHubWebhookReceipt {
  id: string;
  delivery: VerifiedGitHubWebhookDelivery;
  attemptCount: number;
  leaseToken: string;
}

/** Persists GitHub App connections, resource bindings, and provider receipts. */
export class GitHubWebhookSourceStore {
  constructor(private readonly pool: Pool) {}

  async createAttempt(input: {
    stateDigest: Buffer;
    userId: string;
    environmentId: string;
    expiresAt: Date;
  }) {
    const result = await this.pool.query(
      `INSERT INTO webhook_github_connection_attempts (
         state_digest, created_by_user_id, environment_id, expires_at
       )
       SELECT $1, $2, environment.id, $4
       FROM environments environment
       WHERE environment.id = $3 AND environment.created_by_user_id = $2
       ON CONFLICT (created_by_user_id, environment_id) DO UPDATE
       SET state_digest = EXCLUDED.state_digest,
           expires_at = EXCLUDED.expires_at,
           created_at = NOW()`,
      [input.stateDigest, input.userId, input.environmentId, input.expiresAt],
    );
    if (!result.rowCount) throw notFound("environment_not_found", "Environment not found.");
  }

  async consumeAttempt(stateDigest: Buffer, now: Date) {
    const client = await this.pool.connect();
    let attempt:
      | { created_by_user_id: string; environment_id: string }
      | undefined;
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        created_by_user_id: string;
        environment_id: string;
      }>(
        `DELETE FROM webhook_github_connection_attempts
         WHERE state_digest = $1 AND expires_at > $2
         RETURNING created_by_user_id, environment_id`,
        [stateDigest, now],
      );
      await client.query(
        `DELETE FROM webhook_github_connection_attempts WHERE expires_at <= $1`,
        [now],
      );
      attempt = result.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!attempt) {
      throw conflict(
        "github_webhook_connection_attempt_invalid",
        "The GitHub connection attempt is invalid, expired, or already used.",
      );
    }
    return {
      userId: attempt.created_by_user_id,
      environmentId: attempt.environment_id,
    };
  }

  async upsertInstallations(userId: string, inventories: GitHubInstallationInventory[]) {
    const client = await this.pool.connect();
    const connectionIds: string[] = [];
    try {
      await client.query("BEGIN");
      for (const inventory of inventories) {
        const id = `github_webhook_connection_${randomUUID()}`;
        const connection = await client.query<{ id: string }>(
          `INSERT INTO webhook_github_connections (
             id, created_by_user_id, installation_id, account_id,
             account_login, account_type, repository_selection, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
           ON CONFLICT (created_by_user_id, installation_id) DO UPDATE
           SET account_id = EXCLUDED.account_id,
               account_login = EXCLUDED.account_login,
               account_type = EXCLUDED.account_type,
               repository_selection = EXCLUDED.repository_selection,
               status = 'active', last_error = NULL
           RETURNING id`,
          [
            id,
            userId,
            inventory.installationId,
            inventory.accountId,
            inventory.accountLogin,
            inventory.accountType,
            inventory.repositorySelection,
          ],
        );
        const connectionId = connection.rows[0]!.id;
        connectionIds.push(connectionId);
        const repositoryIds = inventory.repositories.map((repository) => repository.id);
        await client.query(
          `DELETE FROM webhook_github_repositories
           WHERE connection_id = $1
             AND NOT (repository_id = ANY($2::TEXT[]))`,
          [connectionId, repositoryIds],
        );
        await client.query(
          `DELETE FROM environment_webhook_github_repositories selected
           USING environment_webhook_github_sources source
           WHERE selected.webhook_id = source.webhook_id
             AND source.connection_id = $1
             AND NOT (selected.repository_id = ANY($2::TEXT[]))`,
          [connectionId, repositoryIds],
        );
        for (const repository of inventory.repositories) {
          await client.query(
            `INSERT INTO webhook_github_repositories (
               connection_id, repository_id, full_name, private, default_branch
             ) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (connection_id, repository_id) DO UPDATE
             SET full_name = EXCLUDED.full_name,
                 private = EXCLUDED.private,
                 default_branch = EXCLUDED.default_branch,
                 updated_at = NOW()`,
            [
              connectionId,
              repository.id,
              repository.fullName,
              repository.private,
              repository.defaultBranch ?? null,
            ],
          );
        }
        await disableWebhooksWithoutRepositories(client, connectionId);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return connectionIds;
  }

  async listConnections(userId: string) {
    const connections = await this.pool.query<GitHubConnectionRow>(
      `SELECT * FROM webhook_github_connections
       WHERE created_by_user_id = $1
       ORDER BY account_login, installation_id`,
      [userId],
    );
    const ids = connections.rows.map((connection) => connection.id);
    const repositories = ids.length
      ? await this.pool.query<GitHubRepositoryRow>(
          `SELECT * FROM webhook_github_repositories
           WHERE connection_id = ANY($1::TEXT[])
           ORDER BY full_name, repository_id`,
          [ids],
        )
      : { rows: [] as GitHubRepositoryRow[] };
    const repositoriesByConnection = new Map<string, GitHubWebhookRepository[]>();
    for (const repository of repositories.rows) {
      const values = repositoriesByConnection.get(repository.connection_id) ?? [];
      values.push(repositoryFromRow(repository));
      repositoriesByConnection.set(repository.connection_id, values);
    }
    return connections.rows.map((connection) =>
      publicConnection(
        connection,
        repositoriesByConnection.get(connection.id) ?? [],
      ),
    );
  }

  async disconnect(userId: string, connectionId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const connection = await client.query(
        `UPDATE webhook_github_connections
         SET status = 'disconnected', last_error = 'Disconnected from Sandpi.'
         WHERE id = $1 AND created_by_user_id = $2
         RETURNING id`,
        [connectionId, userId],
      );
      if (!connection.rowCount) {
        throw notFound(
          "github_webhook_connection_not_found",
          "GitHub Webhook connection not found.",
        );
      }
      await disableConnectionWebhooks(
        client,
        connectionId,
        "The GitHub Webhook connection was disconnected.",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueue(delivery: VerifiedGitHubWebhookDelivery) {
    const result = await this.pool.query(
      `INSERT INTO webhook_github_receipts (
         id, delivery_id, event_name, action, installation_id,
         repository_id, payload, received_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8)
       ON CONFLICT (delivery_id) DO NOTHING`,
      [
        `github_webhook_receipt_${randomUUID()}`,
        delivery.deliveryId,
        delivery.eventName,
        delivery.action ?? null,
        delivery.installationId ?? null,
        delivery.repository?.id ?? null,
        JSON.stringify(delivery.payload),
        new Date(delivery.receivedAt),
      ],
    );
    return result.rowCount === 1;
  }

  async claim(now: Date, leaseExpiresAt: Date) {
    const leaseToken = randomUUID();
    const result = await this.pool.query<GitHubReceiptRow>(
      `WITH candidate AS (
         SELECT id
         FROM webhook_github_receipts
         WHERE (
             status = 'queued' AND not_before <= $1
           ) OR (
             status = 'processing' AND lease_expires_at <= $1
           )
         ORDER BY received_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE webhook_github_receipts receipt
       SET status = 'processing', lease_token = $2, lease_expires_at = $3,
           attempt_count = receipt.attempt_count + 1
       FROM candidate
       WHERE receipt.id = candidate.id
       RETURNING receipt.*`,
      [now, leaseToken, leaseExpiresAt],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (!isRecord(row.payload)) {
      await this.finish(row.id, leaseToken, "ignored", "The stored GitHub payload is invalid.", now);
      return undefined;
    }
    const repository = githubRepository(row.payload.repository);
    return {
      id: row.id,
      delivery: {
        deliveryId: row.delivery_id,
        eventName: row.event_name,
        ...(row.action ? { action: row.action } : {}),
        ...(row.installation_id ? { installationId: row.installation_id } : {}),
        ...(repository ? { repository } : {}),
        payload: row.payload,
        receivedAt: row.received_at.toISOString(),
      },
      attemptCount: row.attempt_count,
      leaseToken,
    } satisfies ClaimedGitHubWebhookReceipt;
  }

  async finish(
    receiptId: string,
    leaseToken: string,
    status: "completed" | "ignored",
    reason: string | undefined,
    now: Date,
  ) {
    await this.pool.query(
      `UPDATE webhook_github_receipts
       SET status = $3, payload = NULL, lease_token = NULL,
           lease_expires_at = NULL, last_error = $4, processed_at = $5
       WHERE id = $1 AND lease_token = $2 AND status = 'processing'`,
      [receiptId, leaseToken, status, reason?.slice(0, 2_000) ?? null, now],
    );
  }

  async defer(input: {
    receiptId: string;
    leaseToken: string;
    attemptCount: number;
    error: string;
    retryAt: Date;
    now: Date;
  }) {
    const terminal = input.attemptCount >= 10;
    await this.pool.query(
      `UPDATE webhook_github_receipts
       SET status = $3, payload = CASE WHEN $3 = 'failed' THEN NULL ELSE payload END,
           not_before = $4, lease_token = NULL, lease_expires_at = NULL,
           last_error = $5, processed_at = CASE WHEN $3 = 'failed' THEN $6 ELSE NULL END
       WHERE id = $1 AND lease_token = $2 AND status = 'processing'`,
      [
        input.receiptId,
        input.leaseToken,
        terminal ? "failed" : "queued",
        input.retryAt,
        input.error.slice(0, 2_000),
        input.now,
      ],
    );
  }

  async routes(installationId: string, repositoryId: string) {
    const result = await this.pool.query<{
      webhook_id: string;
      connection_id: string;
      account_id: string;
      account_login: string;
    }>(
      `SELECT webhook.id AS webhook_id, connection.id AS connection_id,
              connection.account_id, connection.account_login
       FROM webhook_github_connections connection
       JOIN environment_webhook_github_sources source
         ON source.connection_id = connection.id
       JOIN environment_webhook_github_repositories selected
         ON selected.webhook_id = source.webhook_id
       JOIN environment_webhooks webhook ON webhook.id = source.webhook_id
       WHERE connection.installation_id = $1
         AND selected.repository_id = $2
         AND connection.status = 'active'
         AND webhook.source_kind = 'github'
         AND webhook.enabled = TRUE AND webhook.deleted_at IS NULL
       ORDER BY webhook.id`,
      [installationId, repositoryId],
    );
    return result.rows.map((row) => ({
      webhookId: row.webhook_id,
      connectionId: row.connection_id,
      accountId: row.account_id,
      accountLogin: row.account_login,
    } satisfies RoutedGitHubWebhook));
  }

  async setInstallationStatus(input: {
    installationId: string;
    status: "active" | "suspended" | "revoked";
    accountId?: string;
    accountLogin?: string;
    accountType?: string;
    repositorySelection?: "all" | "selected";
    error?: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `UPDATE webhook_github_connections
         SET status = $2,
             account_id = COALESCE($3, account_id),
             account_login = COALESCE($4, account_login),
             account_type = COALESCE($5, account_type),
             repository_selection = COALESCE($6, repository_selection),
             last_error = $7
         WHERE installation_id = $1 AND status <> 'disconnected'
         RETURNING id`,
        [
          input.installationId,
          input.status,
          input.accountId ?? null,
          input.accountLogin ?? null,
          input.accountType ?? null,
          input.repositorySelection ?? null,
          input.error?.slice(0, 2_000) ?? null,
        ],
      );
      if (input.status !== "active") {
        for (const connection of result.rows) {
          await disableConnectionWebhooks(
            client,
            connection.id,
            input.error ?? `The GitHub App installation is ${input.status}.`,
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateInstallationRepositories(input: {
    installationId: string;
    added: GitHubWebhookRepository[];
    removedIds: string[];
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const connections = await client.query<{ id: string }>(
        `SELECT id FROM webhook_github_connections
         WHERE installation_id = $1 AND status <> 'disconnected'
         FOR UPDATE`,
        [input.installationId],
      );
      for (const connection of connections.rows) {
        if (input.removedIds.length) {
          await client.query(
            `DELETE FROM webhook_github_repositories
             WHERE connection_id = $1 AND repository_id = ANY($2::TEXT[])`,
            [connection.id, input.removedIds],
          );
          await client.query(
            `DELETE FROM environment_webhook_github_repositories selected
             USING environment_webhook_github_sources source
             WHERE selected.webhook_id = source.webhook_id
               AND source.connection_id = $1
               AND selected.repository_id = ANY($2::TEXT[])`,
            [connection.id, input.removedIds],
          );
        }
        for (const repository of input.added) {
          await client.query(
            `UPDATE webhook_github_repositories
             SET full_name = $3, private = $4, default_branch = $5,
                 updated_at = NOW()
             WHERE connection_id = $1 AND repository_id = $2`,
            [
              connection.id,
              repository.id,
              repository.fullName,
              repository.private,
              repository.defaultBranch ?? null,
            ],
          );
        }
        await disableWebhooksWithoutRepositories(client, connection.id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function disableConnectionWebhooks(
  client: PoolClient,
  connectionId: string,
  error: string,
) {
  await client.query(
    `UPDATE environment_webhooks webhook
     SET enabled = FALSE, last_error = $2, revision = webhook.revision + 1
     FROM environment_webhook_github_sources source
     WHERE source.webhook_id = webhook.id AND source.connection_id = $1
       AND webhook.deleted_at IS NULL`,
    [connectionId, error.slice(0, 2_000)],
  );
}

async function disableWebhooksWithoutRepositories(
  client: PoolClient,
  connectionId: string,
) {
  await client.query(
    `UPDATE environment_webhooks webhook
     SET enabled = FALSE,
         last_error = 'No selected GitHub repositories remain accessible.',
         revision = webhook.revision + 1
     FROM environment_webhook_github_sources source
     WHERE source.webhook_id = webhook.id AND source.connection_id = $1
       AND webhook.enabled = TRUE AND webhook.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM environment_webhook_github_repositories selected
         WHERE selected.webhook_id = webhook.id
       )`,
    [connectionId],
  );
}

function publicConnection(
  row: GitHubConnectionRow,
  repositories: GitHubWebhookRepository[],
): GitHubWebhookConnection {
  return {
    id: row.id,
    installationId: row.installation_id,
    accountId: row.account_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection,
    status: row.status,
    repositories,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: toUnixTimestamp(row.created_at),
    updatedAt: toUnixTimestamp(row.updated_at),
  };
}

function repositoryFromRow(row: GitHubRepositoryRow): GitHubWebhookRepository {
  return {
    id: row.repository_id,
    fullName: row.full_name,
    private: row.private,
    ...(row.default_branch ? { defaultBranch: row.default_branch } : {}),
  };
}

function githubRepository(value: unknown) {
  if (!isRecord(value)) return undefined;
  const id = scalarId(value.id);
  const fullName = typeof value.full_name === "string" ? value.full_name : undefined;
  if (!id || !fullName || typeof value.private !== "boolean") return undefined;
  const defaultBranch =
    typeof value.default_branch === "string" ? value.default_branch : undefined;
  return {
    id,
    fullName,
    private: value.private,
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

function scalarId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
