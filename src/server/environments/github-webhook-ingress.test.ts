import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import {
  normalizeGitHubWebhookDelivery,
  verifyGitHubWebhookDelivery,
} from "./github-webhook-ingress";

const secret = "github-ingress-test-secret";
const now = new Date("2026-08-02T12:00:00.000Z");

test("verifies and normalizes a GitHub pull request delivery", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      action: "synchronize",
      installation: { id: 123 },
      repository: {
        id: 456,
        full_name: "sandbox0-ai/sandpi",
        private: false,
        default_branch: "main",
      },
      pull_request: {
        number: 61,
        title: "Add direct GitHub Webhooks",
        updated_at: "2026-08-02T11:59:00Z",
      },
      sender: { login: "octocat" },
    }),
  );
  const delivery = verifyGitHubWebhookDelivery({
    secret,
    rawBody,
    headers: {
      "x-hub-signature-256": signature(rawBody),
      "x-github-delivery": "delivery-123",
      "x-github-event": "pull_request",
    },
    now,
  });
  const event = normalizeGitHubWebhookDelivery({
    delivery,
    connectionId: "connection-123",
    accountId: "789",
    accountLogin: "sandbox0-ai",
  });

  assert.equal(event.eventType, "pull_request.synchronize");
  assert.equal(event.groupKey, "github:456:pull-request:61");
  assert.match(event.summary, /PR sandbox0-ai\/sandpi#61/);
  assert.deepEqual(event.source, {
    provider: "github",
    connectionId: "connection-123",
    externalAccountId: "789",
    externalAccountName: "sandbox0-ai",
    resourceId: "456",
    resourceName: "sandbox0-ai/sandpi",
    actor: "octocat",
    subject: "sandbox0-ai/sandpi#61",
    conversationKey: "github:456:pull-request:61",
    occurredAt: "2026-08-02T11:59:00Z",
  });
});

test("rejects a GitHub delivery before parsing when its signature is invalid", () => {
  const rawBody = Buffer.from("not-json");
  assert.throws(
    () =>
      verifyGitHubWebhookDelivery({
        secret,
        rawBody,
        headers: {
          "x-hub-signature-256": "sha256=invalid",
          "x-github-delivery": "delivery-123",
          "x-github-event": "issues",
        },
        now,
      }),
    (error) =>
      error instanceof HttpError && error.code === "github_webhook_unauthorized",
  );
});

function signature(rawBody: Buffer) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
