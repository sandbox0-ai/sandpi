import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import type { GitHubWebhookClient } from "@/server/environments/github-webhook-client";
import { GitHubWebhookSourceStore } from "@/server/environments/github-webhook-store";
import { loadConfig } from "@/server/config";
import { HttpError } from "@/server/http-error";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import { createSandpiServer } from "@/server/server";
import { SandpiStore } from "@/server/store";

const WEBHOOK_SECRET = "github-webhook-test-secret";

test(
  "connects a GitHub App and routes signed repository events by source thread",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_github_webhook_api_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-github-webhook-test-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-github-webhook-test",
      options: `-c search_path=${schema}`,
      max: 8,
    });
    const client: GitHubWebhookClient = {
      async exchangeAuthorizationCode(code) {
        assert.equal(code, "github-oauth-code");
        return "short-lived-user-token";
      },
      async listUserInstallations(accessToken) {
        assert.equal(accessToken, "short-lived-user-token");
        return [
          {
            installationId: "12345",
            accountId: "9876",
            accountLogin: "sandbox0-ai",
            accountType: "Organization",
            repositorySelection: "selected",
            repositories: [
              {
                id: "45678",
                fullName: "sandbox0-ai/sandpi",
                private: false,
                defaultBranch: "main",
              },
            ],
          },
        ];
      },
    };
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      SANDPI_HOST: "127.0.0.1",
      SANDPI_PORT: "39003",
      SANDPI_PUBLIC_URL: "http://127.0.0.1:39003",
      SANDPI_AUTH_MODE: "admin",
      SANDPI_SECRET_KEY: "github-webhook-encryption-key-at-least-32-bytes",
      SANDPI_GITHUB_APP_SLUG: "sandpi-webhook-test",
      SANDPI_GITHUB_CLIENT_ID: "Iv1.github-test",
      SANDPI_GITHUB_CLIENT_SECRET: "github-client-secret",
      SANDPI_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SANDPI_LOG_LEVEL: "silent",
      SANDPI_WEB_DIR: "/tmp/sandpi-github-webhook-test-no-web",
    });
    const server = await createSandpiServer({
      config,
      pool: database,
      advisoryLockPool: database,
      runtime: new UnconfiguredRuntime(),
      githubWebhookClient: client,
    });
    context.after(async () => {
      await server.close();
      await database.end();
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.end();
    });

    const initialInventory = await server.app.inject({
      method: "GET",
      url: "/api/v1/environments/env-default/webhook-sources/github",
    });
    assert.equal(initialInventory.statusCode, 200, initialInventory.body);
    assert.equal(initialInventory.json().data.configured, true);
    assert.deepEqual(initialInventory.json().data.connections, []);

    const start = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhook-sources/github/install",
    });
    assert.equal(start.statusCode, 201, start.body);
    const authorizationUrl = new URL(start.json().data.authorizationUrl);
    assert.equal(authorizationUrl.hostname, "github.com");
    assert.equal(
      authorizationUrl.pathname,
      "/apps/sandpi-webhook-test/installations/new",
    );
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);

    const replacementStart = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhook-sources/github/install",
    });
    assert.equal(replacementStart.statusCode, 201, replacementStart.body);
    const replacementState = new URL(
      replacementStart.json().data.authorizationUrl,
    ).searchParams.get("state");
    assert.ok(replacementState);
    const replacedCallback = await server.app.inject({
      method: "GET",
      url: `/api/v1/webhook-sources/github/callback?code=github-oauth-code&state=${encodeURIComponent(state)}&installation_id=12345`,
    });
    assert.equal(replacedCallback.statusCode, 409, replacedCallback.body);

    const callback = await server.app.inject({
      method: "GET",
      url: `/api/v1/webhook-sources/github/callback?code=github-oauth-code&state=${encodeURIComponent(replacementState)}&installation_id=12345`,
    });
    assert.equal(callback.statusCode, 200, callback.body);
    assert.match(callback.headers["content-type"] ?? "", /text\/html/);
    assert.match(callback.body, /GitHub connected/);

    const inventory = await server.app.inject({
      method: "GET",
      url: "/api/v1/environments/env-default/webhook-sources/github",
    });
    const connection = inventory.json().data.connections[0] as {
      id: string;
      accountLogin: string;
      repositories: Array<{ id: string; fullName: string }>;
    };
    assert.equal(connection.accountLogin, "sandbox0-ai");
    assert.deepEqual(connection.repositories, [
      {
        id: "45678",
        fullName: "sandbox0-ai/sandpi",
        private: false,
        defaultBranch: "main",
      },
    ]);
    const githubSources = new GitHubWebhookSourceStore(database);
    await githubSources.updateInstallationRepositories({
      installationId: "12345",
      added: [
        {
          id: "99999",
          fullName: "sandbox0-ai/not-proven-by-user-oauth",
          private: true,
          defaultBranch: "main",
        },
      ],
      removedIds: [],
    });
    const unprovenRepository = await database.query(
      `SELECT repository_id FROM webhook_github_repositories
       WHERE connection_id = $1 AND repository_id = '99999'`,
      [connection.id],
    );
    assert.equal(unprovenRepository.rowCount, 0);

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhooks",
      payload: {
        source: {
          kind: "github",
          connectionId: connection.id,
          repositoryIds: ["45678"],
          eventTypes: ["issues.opened", "issue_comment.created"],
        },
        name: "GitHub triage",
        prompt: "Triage the GitHub event.",
        batchWindowSeconds: 0,
        target: { kind: "sourceThread" },
        enabled: true,
      },
    });
    assert.equal(create.statusCode, 201, create.body);
    const webhook = create.json().data.webhook as {
      id: string;
      endpointUrl?: string;
      secretConfigured: boolean;
      source: { kind: string; accountLogin: string };
    };
    assert.equal(webhook.endpointUrl, undefined);
    assert.equal(webhook.secretConfigured, false);
    assert.deepEqual(webhook.source, {
      kind: "github",
      connectionId: connection.id,
      accountLogin: "sandbox0-ai",
      repositories: [
        {
          id: "45678",
          fullName: "sandbox0-ai/sandpi",
          private: false,
          defaultBranch: "main",
        },
      ],
      eventTypes: ["issues.opened", "issue_comment.created"],
    });

    const invalid = await injectGitHubDelivery(server, {
      deliveryId: "github-delivery-invalid",
      eventName: "issues",
      action: "opened",
      validSignature: false,
    });
    assert.equal(invalid.statusCode, 401, invalid.body);

    const first = await injectGitHubDelivery(server, {
      deliveryId: "github-delivery-one",
      eventName: "issues",
      action: "opened",
    });
    assert.equal(first.statusCode, 202, first.body);
    assert.equal(first.json().status, "accepted");

    const duplicate = await injectGitHubDelivery(server, {
      deliveryId: "github-delivery-one",
      eventName: "issues",
      action: "opened",
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().status, "duplicate");

    const second = await injectGitHubDelivery(server, {
      deliveryId: "github-delivery-two",
      eventName: "issue_comment",
      action: "created",
    });
    assert.equal(second.statusCode, 202, second.body);

    const unselected = await injectGitHubDelivery(server, {
      deliveryId: "github-delivery-unselected",
      eventName: "pull_request",
      action: "opened",
    });
    assert.equal(unselected.statusCode, 202, unselected.body);
    await waitFor(async () => {
      const result = await database.query<{ status: string }>(
        `SELECT status FROM webhook_github_receipts WHERE delivery_id = $1`,
        ["github-delivery-unselected"],
      );
      return result.rows[0]?.status === "completed";
    });

    await waitFor(async () => {
      const result = await database.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM environment_webhook_deliveries WHERE webhook_id = $1`,
        [webhook.id],
      );
      return result.rows[0]?.count === "2";
    });
    const runs = await database.query<{ id: string; session_id: string }>(
      `SELECT id, session_id FROM environment_webhook_runs
       WHERE webhook_id = $1 ORDER BY created_at, id`,
      [webhook.id],
    );
    assert.equal(runs.rowCount, 2);
    assert.equal(runs.rows[0]?.session_id, runs.rows[1]?.session_id);
    const sessionId = runs.rows[0]!.session_id;
    const automationSessionKey = `webhook:${webhook.id}:source-thread:${sessionId}`;
    const store = new SandpiStore(database);
    const environment = await store.getEnvironment("user-admin", "env-default");
    for (const run of runs.rows) {
      await store.ensureAutomationSessionMetadata({
        sessionId,
        automationRunId: run.id,
        automationKind: "webhook",
        automationSessionKey,
        userId: "user-admin",
        environment,
        title: "GitHub triage",
      });
    }
    await assert.rejects(
      store.ensureAutomationSessionMetadata({
        sessionId,
        automationRunId: "webhook-run-unrelated",
        automationKind: "webhook",
        automationSessionKey: "webhook:another-webhook:source-thread:another-session",
        userId: "user-admin",
        environment,
        title: "Unrelated source thread",
      }),
      (error) =>
        error instanceof HttpError &&
        error.code === "environment_automation_session_conflict",
    );

    const disconnect = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/environments/env-default/webhook-sources/github/connections/${encodeURIComponent(connection.id)}`,
    });
    assert.equal(disconnect.statusCode, 200, disconnect.body);
    const providerUnsuspend = await injectGitHubDelivery(server, {
      deliveryId: "github-delivery-unsuspend",
      eventName: "installation",
      action: "unsuspend",
    });
    assert.equal(providerUnsuspend.statusCode, 202, providerUnsuspend.body);
    await waitFor(async () => {
      const result = await database.query<{ status: string }>(
        `SELECT status FROM webhook_github_receipts WHERE delivery_id = $1`,
        ["github-delivery-unsuspend"],
      );
      return result.rows[0]?.status === "completed";
    });
    const disconnectedInventory = await server.app.inject({
      method: "GET",
      url: "/api/v1/environments/env-default/webhook-sources/github",
    });
    assert.equal(
      disconnectedInventory.json().data.connections[0].status,
      "disconnected",
    );
    await githubSources.updateInstallationRepositories({
      installationId: "12345",
      added: [
        {
          id: "45678",
          fullName: "sandbox0-ai/renamed-after-disconnect",
          private: false,
          defaultBranch: "main",
        },
      ],
      removedIds: [],
    });
    const disconnectedRepository = await database.query<{ full_name: string }>(
      `SELECT full_name FROM webhook_github_repositories
       WHERE connection_id = $1 AND repository_id = '45678'`,
      [connection.id],
    );
    assert.equal(
      disconnectedRepository.rows[0]?.full_name,
      "sandbox0-ai/sandpi",
    );
    const disabled = await database.query<{ enabled: boolean }>(
      "SELECT enabled FROM environment_webhooks WHERE id = $1",
      [webhook.id],
    );
    assert.equal(disabled.rows[0]?.enabled, false);
  },
);

async function injectGitHubDelivery(
  server: Awaited<ReturnType<typeof createSandpiServer>>,
  input: {
    deliveryId: string;
    eventName: string;
    action: string;
    validSignature?: boolean;
  },
) {
  const body = JSON.stringify({
    action: input.action,
    installation: { id: 12345 },
    repository: {
      id: 45678,
      full_name: "sandbox0-ai/sandpi",
      private: false,
      default_branch: "main",
    },
    issue: { number: 77, title: "Webhook integration", state: "open" },
    sender: { login: "octocat" },
  });
  const signature = createHmac(
    "sha256",
    input.validSignature === false ? "wrong-secret" : WEBHOOK_SECRET,
  )
    .update(body)
    .digest("hex");
  return server.app.inject({
    method: "POST",
    url: "/api/v1/webhook-sources/github/events",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${signature}`,
      "x-github-delivery": input.deliveryId,
      "x-github-event": input.eventName,
    },
    payload: body,
  });
}

async function waitFor(assertion: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for GitHub Webhook delivery routing.");
}
