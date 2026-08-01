import { createHmac, timingSafeEqual } from "node:crypto";

import { HttpError } from "@/server/http-error";
import type { NormalizedWebhookEvent } from "./webhook-ingress";

export interface VerifiedGitHubWebhookDelivery {
  deliveryId: string;
  eventName: string;
  action?: string;
  installationId?: string;
  repository?: {
    id: string;
    fullName: string;
    private: boolean;
    defaultBranch?: string;
  };
  payload: Record<string, unknown>;
  receivedAt: string;
}

/** Verifies the raw GitHub App body before reading routing coordinates. */
export function verifyGitHubWebhookDelivery(input: {
  secret: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  now?: Date;
}): VerifiedGitHubWebhookDelivery {
  const signature = header(input.headers, "x-hub-signature-256");
  if (!signature?.startsWith("sha256=")) {
    throw unauthorized("The GitHub webhook signature is missing.");
  }
  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest("hex")}`;
  if (!safeEqual(signature, expected)) {
    throw unauthorized("The GitHub webhook signature is invalid.");
  }
  const deliveryId = header(input.headers, "x-github-delivery")?.trim();
  const eventName = header(input.headers, "x-github-event")?.trim();
  if (!deliveryId || !eventName) {
    throw invalid("GitHub delivery and event headers are required.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    throw invalid("The GitHub webhook body is not valid JSON.");
  }
  if (!isRecord(parsed)) throw invalid("The GitHub webhook body must be an object.");
  const repository = isRecord(parsed.repository)
    ? githubRepository(parsed.repository)
    : undefined;
  return {
    deliveryId,
    eventName,
    ...(scalarString(parsed.action) ? { action: scalarString(parsed.action) } : {}),
    ...(recordId(parsed.installation)
      ? { installationId: recordId(parsed.installation) }
      : {}),
    ...(repository ? { repository } : {}),
    payload: parsed,
    receivedAt: (input.now ?? new Date()).toISOString(),
  };
}

/** Maps one routed GitHub delivery into the provider-independent event model. */
export function normalizeGitHubWebhookDelivery(input: {
  delivery: VerifiedGitHubWebhookDelivery;
  connectionId: string;
  accountId: string;
  accountLogin: string;
}): NormalizedWebhookEvent {
  const { delivery } = input;
  const eventType = delivery.action
    ? `${delivery.eventName}.${delivery.action}`
    : delivery.eventName;
  const conversation = githubConversation(delivery);
  const actor = recordString(delivery.payload.sender, "login");
  const occurredAt = githubOccurredAt(delivery.payload) ?? delivery.receivedAt;
  return {
    deliveryId: delivery.deliveryId,
    eventType,
    groupKey:
      conversation?.key ??
      (delivery.repository
        ? `github:${delivery.repository.id}`
        : `github-installation:${delivery.installationId ?? input.accountId}`),
    summary:
      conversation?.summary ??
      `${eventType}${delivery.repository ? ` in ${delivery.repository.fullName}` : ""}`,
    receivedAt: delivery.receivedAt,
    payload: delivery.payload,
    ...(delivery.action ? { stateValue: delivery.action } : {}),
    source: {
      provider: "github",
      connectionId: input.connectionId,
      externalAccountId: input.accountId,
      externalAccountName: input.accountLogin,
      ...(delivery.repository
        ? {
            resourceId: delivery.repository.id,
            resourceName: delivery.repository.fullName,
          }
        : {}),
      ...(actor ? { actor } : {}),
      ...(conversation
        ? {
            subject: conversation.subject,
            conversationKey: conversation.key,
          }
        : {}),
      occurredAt,
    },
  };
}

function githubConversation(delivery: VerifiedGitHubWebhookDelivery) {
  const repository = delivery.repository;
  if (!repository) return undefined;
  const pullRequest = isRecord(delivery.payload.pull_request)
    ? delivery.payload.pull_request
    : undefined;
  const issue = isRecord(delivery.payload.issue) ? delivery.payload.issue : undefined;
  const number = scalarInteger(pullRequest?.number) ?? scalarInteger(issue?.number);
  if (number === undefined) return undefined;
  const pullRequestIssue = Boolean(pullRequest || isRecord(issue?.pull_request));
  const kind = pullRequestIssue ? "pull-request" : "issue";
  const title = scalarString(pullRequest?.title) ?? scalarString(issue?.title);
  const label = pullRequestIssue ? "PR" : "Issue";
  return {
    key: `github:${repository.id}:${kind}:${number}`,
    subject: `${repository.fullName}#${number}`,
    summary: `${delivery.eventName}${delivery.action ? `.${delivery.action}` : ""}: ${label} ${repository.fullName}#${number}${title ? ` — ${title}` : ""}`,
  };
}

function githubOccurredAt(payload: Record<string, unknown>) {
  for (const candidate of [
    payload.pull_request,
    payload.issue,
    payload.comment,
    payload.review,
    payload.workflow_run,
  ]) {
    const created = recordString(candidate, "updated_at") ?? recordString(candidate, "created_at");
    if (created) return created;
  }
  return undefined;
}

function githubRepository(value: Record<string, unknown>) {
  const id = scalarId(value.id);
  const fullName = scalarString(value.full_name);
  if (!id || !fullName || typeof value.private !== "boolean") return undefined;
  const defaultBranch = scalarString(value.default_branch);
  return {
    id,
    fullName,
    private: value.private,
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

function recordId(value: unknown) {
  return isRecord(value) ? scalarId(value.id) : undefined;
}

function recordString(value: unknown, key: string) {
  return isRecord(value) ? scalarString(value[key]) : undefined;
}

function scalarId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return undefined;
}

function scalarInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function scalarString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized(message: string) {
  return new HttpError(401, "github_webhook_unauthorized", message);
}

function invalid(message: string) {
  return new HttpError(400, "github_webhook_invalid", message);
}
