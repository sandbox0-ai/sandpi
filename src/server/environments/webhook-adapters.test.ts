import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import { adaptWebhookRequest } from "./webhook-adapters";

const now = new Date("2026-08-01T12:00:00.000Z");

test("verifies and normalizes GitHub deliveries", () => {
  const secret = "github-webhook-secret";
  const rawBody = Buffer.from(
    JSON.stringify({
      action: "synchronize",
      repository: { full_name: "sandbox0-ai/sandpi" },
      pull_request: { number: 61 },
      sender: { login: "octocat" },
    }),
  );
  const signature = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
  const result = adaptWebhookRequest({
    provider: "github",
    secret,
    rawBody,
    headers: {
      "x-hub-signature-256": signature,
      "x-github-delivery": "delivery-one",
      "x-github-event": "pull_request",
    },
    now,
  });
  assert.equal(result.kind, "event");
  if (result.kind !== "event") return;
  assert.equal(result.event.eventType, "pull_request.synchronize");
  assert.equal(result.event.groupKey, "sandbox0-ai/sandpi:61");
  assert.equal(result.event.deliveryId, "delivery-one");
});

test("rejects a GitHub delivery with the wrong signature", () => {
  assert.throws(
    () =>
      adaptWebhookRequest({
        provider: "github",
        secret: "github-webhook-secret",
        rawBody: Buffer.from("{}"),
        headers: {
          "x-hub-signature-256": "sha256=wrong",
          "x-github-delivery": "delivery-one",
          "x-github-event": "ping",
        },
        now,
      }),
    (error) =>
      error instanceof HttpError &&
      error.code === "environment_webhook_unauthorized",
  );
});

test("normalizes an authenticated Alertmanager group", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      status: "firing",
      groupKey: "{}:{alertname=HighErrorRate}",
      alerts: [{ fingerprint: "abc" }, { fingerprint: "def" }],
    }),
  );
  const result = adaptWebhookRequest({
    provider: "alertmanager",
    secret: "alert-token",
    rawBody,
    headers: {
      authorization: "Bearer alert-token",
      "idempotency-key": "notification-one",
    },
    now,
  });
  assert.equal(result.kind, "event");
  if (result.kind !== "event") return;
  assert.equal(result.event.eventType, "firing");
  assert.equal(result.event.stateValue, "firing");
  assert.equal(result.event.deliveryId, "notification-one");
});

test("answers a signed Slack URL verification challenge", () => {
  const secret = "slack-signing-secret";
  const timestamp = String(now.getTime() / 1_000);
  const rawBody = Buffer.from(
    JSON.stringify({ type: "url_verification", challenge: "challenge-one" }),
  );
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex")}`;
  const result = adaptWebhookRequest({
    provider: "slack",
    secret,
    rawBody,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    now,
  });
  assert.deepEqual(result, {
    kind: "challenge",
    statusCode: 200,
    body: { challenge: "challenge-one" },
  });
});

test("accepts Custom Webhooks with a query token fallback", () => {
  const result = adaptWebhookRequest({
    provider: "custom",
    secret: "custom-token",
    queryToken: "custom-token",
    rawBody: Buffer.from(JSON.stringify({ type: "deploy.finished", id: 4 })),
    headers: {
      "idempotency-key": "custom-delivery-one",
    },
    now,
  });
  assert.equal(result.kind, "event");
  if (result.kind !== "event") return;
  assert.equal(result.event.eventType, "deploy.finished");
  assert.equal(result.event.deliveryId, "custom-delivery-one");
});
