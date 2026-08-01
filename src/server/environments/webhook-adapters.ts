import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { HttpError } from "@/server/http-error";

export type EnvironmentWebhookProvider =
  | "github"
  | "alertmanager"
  | "slack"
  | "custom";

export interface NormalizedWebhookEvent {
  provider: EnvironmentWebhookProvider;
  deliveryId: string;
  eventType: string;
  groupKey: string;
  summary: string;
  receivedAt: string;
  payload: unknown;
  stateValue?: string;
}

export type WebhookAdapterResult =
  | { kind: "challenge"; statusCode: 200; body: unknown }
  | { kind: "event"; event: NormalizedWebhookEvent };

/** Verifies one provider request before projecting it into Sandpi's event model. */
export function adaptWebhookRequest(input: {
  provider: EnvironmentWebhookProvider;
  secret: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  contentType?: string;
  queryToken?: string;
  now?: Date;
}): WebhookAdapterResult {
  const now = input.now ?? new Date();
  switch (input.provider) {
    case "github":
      return githubWebhook(input, now);
    case "alertmanager":
      return alertmanagerWebhook(input, now);
    case "slack":
      return slackWebhook(input, now);
    case "custom":
      return customWebhook(input, now);
  }
}

function githubWebhook(
  input: Parameters<typeof adaptWebhookRequest>[0],
  now: Date,
): WebhookAdapterResult {
  const signature = header(input.headers, "x-hub-signature-256");
  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest("hex")}`;
  if (!signature || !safeEqual(signature, expected)) {
    throw unauthorized("GitHub webhook signature verification failed.");
  }
  const deliveryId = header(input.headers, "x-github-delivery");
  const eventName = header(input.headers, "x-github-event");
  if (!deliveryId || !eventName) {
    throw invalid("GitHub delivery headers are required.");
  }
  const payload = jsonObject(input.rawBody);
  const action = scalarString(payload.action);
  const eventType = action ? `${eventName}.${action}` : eventName;
  const repository = objectAt(payload, "repository");
  const repositoryName = scalarString(repository?.full_name);
  const pullRequest = objectAt(payload, "pull_request");
  const issue = objectAt(payload, "issue");
  const subjectNumber = scalarString(pullRequest?.number ?? issue?.number);
  const reference = scalarString(payload.ref);
  const sender = scalarString(objectAt(payload, "sender")?.login);
  const groupKey = boundedGroupKey(
    [repositoryName, subjectNumber ?? reference ?? eventName]
      .filter(Boolean)
      .join(":"),
  );
  return {
    kind: "event",
    event: {
      provider: "github",
      deliveryId,
      eventType,
      groupKey,
      summary: [eventType, repositoryName, subjectNumber, sender]
        .filter(Boolean)
        .join(" · "),
      receivedAt: now.toISOString(),
      payload,
      ...(action ? { stateValue: action } : {}),
    },
  };
}

function alertmanagerWebhook(
  input: Parameters<typeof adaptWebhookRequest>[0],
  now: Date,
): WebhookAdapterResult {
  verifyBearerOrQueryToken(input);
  const payload = jsonObject(input.rawBody);
  const status = scalarString(payload.status) ?? "unknown";
  const groupKey = boundedGroupKey(
    scalarString(payload.groupKey) ?? "alertmanager",
  );
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const explicitDeliveryId =
    header(input.headers, "idempotency-key") ??
    header(input.headers, "x-request-id");
  return {
    kind: "event",
    event: {
      provider: "alertmanager",
      deliveryId:
        explicitDeliveryId ?? retryWindowDeliveryId(input.rawBody, now),
      eventType: status,
      groupKey,
      summary: `${status} · ${alerts.length} alert${alerts.length === 1 ? "" : "s"}`,
      receivedAt: now.toISOString(),
      payload,
      stateValue: status,
    },
  };
}

function slackWebhook(
  input: Parameters<typeof adaptWebhookRequest>[0],
  now: Date,
): WebhookAdapterResult {
  const timestamp = header(input.headers, "x-slack-request-timestamp");
  const signature = header(input.headers, "x-slack-signature");
  const timestampSeconds = Number(timestamp);
  if (
    !timestamp ||
    !Number.isInteger(timestampSeconds) ||
    Math.abs(now.getTime() / 1_000 - timestampSeconds) > 300
  ) {
    throw unauthorized("Slack webhook timestamp is missing or expired.");
  }
  const expected = `v0=${createHmac("sha256", input.secret)
    .update(`v0:${timestamp}:${input.rawBody.toString("utf8")}`)
    .digest("hex")}`;
  if (!signature || !safeEqual(signature, expected)) {
    throw unauthorized("Slack webhook signature verification failed.");
  }
  const payload = parsedBody(input.rawBody, input.contentType);
  if (isRecord(payload) && payload.type === "url_verification") {
    const challenge = scalarString(payload.challenge);
    if (!challenge) throw invalid("Slack URL verification challenge is missing.");
    return { kind: "challenge", statusCode: 200, body: { challenge } };
  }
  const envelope = isRecord(payload) ? payload : { value: payload };
  const event = objectAt(envelope, "event");
  const eventType =
    scalarString(event?.type) ??
    (scalarString(envelope.command) ? "slash_command" : undefined) ??
    scalarString(envelope.type) ??
    "event";
  const deliveryId =
    scalarString(envelope.event_id) ??
    scalarString(envelope.trigger_id) ??
    retryWindowDeliveryId(input.rawBody, now);
  const team =
    scalarString(envelope.team_id) ?? scalarString(objectAt(envelope, "team")?.id);
  const channel =
    scalarString(event?.channel) ?? scalarString(envelope.channel_id);
  const thread =
    scalarString(event?.thread_ts) ??
    scalarString(event?.event_ts) ??
    scalarString(envelope.thread_ts);
  const actor =
    scalarString(event?.user) ?? scalarString(envelope.user_id);
  return {
    kind: "event",
    event: {
      provider: "slack",
      deliveryId,
      eventType,
      groupKey: boundedGroupKey(
        [team, channel, thread ?? actor ?? eventType].filter(Boolean).join(":"),
      ),
      summary: [eventType, channel, actor].filter(Boolean).join(" · "),
      receivedAt: now.toISOString(),
      payload: envelope,
      stateValue: eventType,
    },
  };
}

function customWebhook(
  input: Parameters<typeof adaptWebhookRequest>[0],
  now: Date,
): WebhookAdapterResult {
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
    kind: "event",
    event: {
      provider: "custom",
      deliveryId,
      eventType,
      groupKey: "custom",
      summary: eventType,
      receivedAt: now.toISOString(),
      payload,
    },
  };
}

function verifyBearerOrQueryToken(
  input: Parameters<typeof adaptWebhookRequest>[0],
) {
  const authorization = header(input.headers, "authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (
    (!bearer || !safeEqual(bearer, input.secret)) &&
    (!input.queryToken || !safeEqual(input.queryToken, input.secret))
  ) {
    throw unauthorized("Webhook bearer token verification failed.");
  }
}

function parsedBody(rawBody: Buffer, contentType = "application/json") {
  if (contentType.toLowerCase().includes("application/json")) {
    return jsonValue(rawBody);
  }
  if (
    contentType.toLowerCase().includes("application/x-www-form-urlencoded")
  ) {
    return Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")));
  }
  return rawBody.toString("utf8");
}

function jsonObject(rawBody: Buffer): Record<string, unknown> {
  const value = jsonValue(rawBody);
  if (!isRecord(value)) throw invalid("Webhook body must be a JSON object.");
  return value;
}

function jsonValue(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw invalid("Webhook body is not valid JSON.");
  }
}

function objectAt(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value?.[key];
  return isRecord(candidate) ? candidate : undefined;
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

function boundedGroupKey(value: string) {
  const normalized = value.trim() || "default";
  return normalized.length <= 500
    ? normalized
    : `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
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

function unauthorized(message: string) {
  return new HttpError(401, "environment_webhook_unauthorized", message);
}

function invalid(message: string) {
  return new HttpError(400, "environment_webhook_invalid", message);
}
