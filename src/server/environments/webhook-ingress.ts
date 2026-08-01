import { createHash, timingSafeEqual } from "node:crypto";

import { HttpError } from "@/server/http-error";

export interface NormalizedWebhookEvent {
  deliveryId: string;
  eventType: string;
  groupKey: string;
  summary: string;
  receivedAt: string;
  payload: unknown;
  stateValue?: string;
  source?: {
    provider: "custom" | "github";
    connectionId?: string;
    externalAccountId?: string;
    externalAccountName?: string;
    resourceId?: string;
    resourceName?: string;
    actor?: string;
    subject?: string;
    conversationKey?: string;
    occurredAt?: string;
  };
}

/** Authenticates a generic Webhook request before normalizing its envelope. */
export function normalizeAuthenticatedWebhookRequest(input: {
  secret: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  contentType?: string;
  queryToken?: string;
  now?: Date;
}): NormalizedWebhookEvent {
  const now = input.now ?? new Date();
  verifyBearerOrQueryToken(input);
  const payload = parsedBody(input.rawBody, input.contentType);
  const object = isRecord(payload) ? payload : undefined;
  const eventType =
    header(input.headers, "x-sandpi-event") ??
    scalarString(object?.type) ??
    scalarString(object?.event) ??
    scalarString(object?.kind) ??
    "event";
  const deliveryId =
    header(input.headers, "idempotency-key") ??
    header(input.headers, "x-sandpi-delivery") ??
    header(input.headers, "x-request-id") ??
    retryWindowDeliveryId(input.rawBody, now);
  return {
    deliveryId,
    eventType,
    groupKey: "default",
    summary: eventType,
    receivedAt: now.toISOString(),
    payload,
    source: { provider: "custom" },
  };
}

function verifyBearerOrQueryToken(input: {
  secret: string;
  headers: Record<string, string | string[] | undefined>;
  queryToken?: string;
}) {
  const authorization = header(input.headers, "authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (
    (!bearer || !safeEqual(bearer, input.secret)) &&
    (!input.queryToken || !safeEqual(input.queryToken, input.secret))
  ) {
    throw new HttpError(
      401,
      "environment_webhook_unauthorized",
      "Webhook bearer token verification failed.",
    );
  }
}

function parsedBody(rawBody: Buffer, contentType = "application/json") {
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      throw new HttpError(
        400,
        "environment_webhook_invalid",
        "Webhook body is not valid JSON.",
      );
    }
  }
  if (
    contentType.toLowerCase().includes("application/x-www-form-urlencoded")
  ) {
    return Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")));
  }
  return rawBody.toString("utf8");
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function retryWindowDeliveryId(rawBody: Buffer, now: Date) {
  const window = Math.floor(now.getTime() / (5 * 60 * 1_000));
  return `derived:${createHash("sha256")
    .update(rawBody)
    .update(":")
    .update(String(window))
    .digest("hex")}`;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
