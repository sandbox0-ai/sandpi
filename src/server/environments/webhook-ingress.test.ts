import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import { normalizeAuthenticatedWebhookRequest } from "./webhook-ingress";

const now = new Date("2026-08-01T12:00:00.000Z");

test("authenticates and normalizes a JSON Webhook delivery", () => {
  const result = normalizeAuthenticatedWebhookRequest({
    secret: "custom-webhook-secret",
    rawBody: Buffer.from(JSON.stringify({ type: "deploy.finished", id: 4 })),
    headers: {
      authorization: "Bearer custom-webhook-secret",
      "idempotency-key": "delivery-one",
    },
    now,
  });
  assert.equal(result.eventType, "deploy.finished");
  assert.equal(result.deliveryId, "delivery-one");
  assert.equal(result.groupKey, "default");
});

test("accepts the query-token fallback and a caller-defined event type", () => {
  const result = normalizeAuthenticatedWebhookRequest({
    secret: "custom-webhook-secret",
    queryToken: "custom-webhook-secret",
    rawBody: Buffer.from("production deployment finished"),
    contentType: "text/plain",
    headers: {
      "x-sandpi-delivery": "delivery-two",
      "x-sandpi-event": "deploy.finished",
    },
    now,
  });
  assert.equal(result.eventType, "deploy.finished");
  assert.equal(result.deliveryId, "delivery-two");
  assert.equal(result.payload, "production deployment finished");
});

test("parses form payloads after bearer authentication", () => {
  const result = normalizeAuthenticatedWebhookRequest({
    secret: "custom-webhook-secret",
    rawBody: Buffer.from("event=build.failed&build_id=42"),
    contentType: "application/x-www-form-urlencoded",
    headers: { authorization: "Bearer custom-webhook-secret" },
    now,
  });
  assert.equal(result.eventType, "build.failed");
  assert.deepEqual(result.payload, {
    event: "build.failed",
    build_id: "42",
  });
});

test("rejects a delivery with the wrong bearer token", () => {
  assert.throws(
    () =>
      normalizeAuthenticatedWebhookRequest({
        secret: "custom-webhook-secret",
        rawBody: Buffer.from("{}"),
        headers: { authorization: "Bearer wrong" },
        now,
      }),
    (error) =>
      error instanceof HttpError &&
      error.code === "environment_webhook_unauthorized",
  );
});
