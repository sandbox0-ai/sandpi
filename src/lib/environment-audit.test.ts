import assert from "node:assert/strict";
import test from "node:test";

import { mockEnvironmentAudit } from "@/lib/mock-data";

import {
  auditOperationNeedsAttention,
  deduplicateEnvironmentAuditEvents,
  environmentAuditEventIdentity,
  environmentAuditOperationBurstKind,
  filterEnvironmentAuditOperations,
  groupEnvironmentAuditOperations,
  hasAuditIntegrityIssue,
  mergeEnvironmentAuditEventPages,
  networkAuditSynopsis,
  projectEnvironmentAuditActivities,
  summarizeEnvironmentAuditNetwork,
  summarizeEnvironmentAudit,
} from "./environment-audit";
import type { EnvironmentAuditEvent } from "./types";

const events = mockEnvironmentAudit.events;
let fixtureSequence = 0;

function nextFixtureIdentity(base: EnvironmentAuditEvent) {
  fixtureSequence += 1;
  return {
    eventId: `test-event-${fixtureSequence.toString().padStart(4, "0")}`,
    integrity: {
      ...base.integrity,
      payloadHash: `test-payload-${fixtureSequence.toString().padStart(4, "0")}`,
    },
  };
}

function gatewayResult(input: {
  operationId: string;
  occurredAt: number;
  action?: string;
  actorId?: string;
  outcome?: EnvironmentAuditEvent["outcome"];
  phase?: EnvironmentAuditEvent["phase"];
  method?: string;
  resourceType?: string;
  resourceId?: string;
  signatureStatus?: EnvironmentAuditEvent["integrity"]["signatureStatus"];
}) {
  const base = events.find(
    (event) => event.action === "session.input" && event.phase === "result",
  );
  assert.ok(base);
  const identity = nextFixtureIdentity(base);
  return {
    ...base,
    ...identity,
    operationId: input.operationId,
    occurredAt: input.occurredAt,
    ingestedAt: input.occurredAt,
    action: input.action ?? "session.events.read",
    outcome: input.outcome ?? "succeeded",
    phase: input.phase ?? "result",
    actor: {
      ...base.actor,
      id: input.actorId ?? base.actor.id,
    },
    resource: {
      ...base.resource,
      type: input.resourceType ?? base.resource.type,
      id: input.resourceId ?? base.resource.id,
    },
    request: {
      ...base.request,
      httpMethod: input.method ?? "GET",
      route: "/api/v1/sandboxes/:id/sessions/:session_id/events",
      statusCode: 200,
    },
    integrity: {
      ...identity.integrity,
      signatureStatus:
        input.signatureStatus ?? base.integrity.signatureStatus,
    },
  } satisfies EnvironmentAuditEvent;
}

function networkOperation(input: {
  operationId: string;
  occurredAt: number;
  host?: string;
  destinationIp?: string;
  outcome?: EnvironmentAuditEvent["outcome"];
  attemptBytes?: number;
  resultIngressBytes?: number;
  resultEgressBytes?: number;
  resultDurationMs?: number;
}) {
  const attemptBase = events.find(
    (event) =>
      event.action === "network.connect" && event.phase === "attempt",
  );
  const resultBase = events.find(
    (event) =>
      event.action === "network.connect" && event.phase === "result",
  );
  assert.ok(attemptBase);
  assert.ok(resultBase);
  const host = input.host ?? "api.github.com";
  const attempt = {
    ...attemptBase,
    ...nextFixtureIdentity(attemptBase),
    operationId: input.operationId,
    occurredAt: input.occurredAt,
    ingestedAt: input.occurredAt,
    attributes: {
      ...attemptBase.attributes,
      host,
      dest_ip: input.destinationIp ?? attemptBase.attributes?.dest_ip,
      ingress_bytes: input.attemptBytes,
      egress_bytes: input.attemptBytes,
      duration_ms: input.attemptBytes,
    },
  } satisfies EnvironmentAuditEvent;
  const result = {
    ...resultBase,
    ...nextFixtureIdentity(resultBase),
    operationId: input.operationId,
    parentEventId: attempt.eventId,
    occurredAt: input.occurredAt + 0.1,
    ingestedAt: input.occurredAt + 0.1,
    outcome: input.outcome ?? "completed",
    attributes: {
      ...resultBase.attributes,
      host,
      dest_ip: input.destinationIp ?? resultBase.attributes?.dest_ip,
      ingress_bytes: input.resultIngressBytes ?? 0,
      egress_bytes: input.resultEgressBytes ?? 0,
      duration_ms: input.resultDurationMs ?? 0,
    },
  } satisfies EnvironmentAuditEvent;
  return [attempt, result];
}

test("groups phases by operation without merging signed events", () => {
  const operations = groupEnvironmentAuditOperations(events);
  const resume = operations.find(
    (operation) => operation.primaryEvent.action === "sandbox.resume",
  );

  assert.ok(resume);
  assert.equal(resume.events.length, 2);
  assert.deepEqual(
    resume.events.map((event) => event.phase),
    ["attempt", "result"],
  );
  assert.equal(resume.outcome, "succeeded");
  assert.equal(new Set(resume.events.map((event) => event.eventId)).size, 2);
});

test("offers simple product views over canonical event fields", () => {
  const operations = groupEnvironmentAuditOperations(events);

  assert.equal(filterEnvironmentAuditOperations(operations, "all").length, 4);
  assert.equal(filterEnvironmentAuditOperations(operations, "attention").length, 1);
  assert.equal(filterEnvironmentAuditOperations(operations, "network").length, 2);
  assert.equal(filterEnvironmentAuditOperations(operations, "runtime").length, 1);
  assert.equal(filterEnvironmentAuditOperations(operations, "sandbox").length, 1);
});

test("finds canonical process operations by resource instead of a mock event type", () => {
  const gatewayEvent = events.find(
    (event) =>
      event.eventType === "api_access" &&
      event.resource.type === "sandbox_session",
  );
  assert.ok(gatewayEvent);
  const processEvent = {
    ...gatewayEvent,
    eventId: "99999999-9999-4999-8999-999999999999",
    operationId: "99999999-9999-4999-8999-999999999998",
    action: "process.exec",
    resource: {
      type: "sandbox_process",
      id: "ctx_runtime_test",
      subresource: gatewayEvent.sandboxId,
    },
  };
  const operations = groupEnvironmentAuditOperations([processEvent]);

  assert.equal(filterEnvironmentAuditOperations(operations, "runtime").length, 1);
});

test("keeps signature status and event ID conflict as independent integrity signals", () => {
  const verified = events[0];
  assert.ok(verified);
  assert.equal(hasAuditIntegrityIssue(verified), false);

  const conflicting = {
    ...verified,
    integrity: { ...verified.integrity, eventIdConflict: true },
  };
  assert.equal(conflicting.integrity.signatureStatus, "verified");
  assert.equal(hasAuditIntegrityIssue(conflicting), true);

  const invalid = {
    ...verified,
    integrity: { ...verified.integrity, signatureStatus: "invalid" as const },
  };
  assert.equal(hasAuditIntegrityIssue(invalid), true);
});

test("projects network details without changing or dropping signed attributes", () => {
  const denied = events.find((event) => event.action === "network.deny");
  assert.ok(denied);
  const before = structuredClone(denied.attributes);
  const synopsis = networkAuditSynopsis(denied);

  assert.equal(synopsis?.endpoint, "telemetry.example.dev:443");
  assert.equal(synopsis?.protocol, "tls");
  assert.equal(synopsis?.reason, "l7_denied");
  assert.deepEqual(denied.attributes, before);
});

test("summarizes canonical events separately from correlated operations", () => {
  const summary = summarizeEnvironmentAudit(events);
  assert.equal(summary.events, 8);
  assert.equal(summary.operations, 4);
  assert.equal(summary.activities, 4);
  assert.equal(summary.attention, 1);
  assert.equal(summary.verified, 8);
});

test("treats unknown outcomes as attention instead of successful activity", () => {
  const unknown = gatewayResult({
    operationId: "operation-unknown",
    occurredAt: 100,
    outcome: "unknown",
  });
  const [operation] = groupEnvironmentAuditOperations([unknown]);

  assert.ok(operation);
  assert.equal(operation.outcome, "unknown");
  assert.equal(auditOperationNeedsAttention(operation), true);
  assert.equal(
    filterEnvironmentAuditOperations([operation], "attention").length,
    1,
  );
});

test("sorts equal-time canonical facts deterministically and selects a result", () => {
  const resultA = gatewayResult({
    operationId: "operation-stable",
    occurredAt: 200,
  });
  const resultZ = {
    ...gatewayResult({
      operationId: "operation-stable",
      occurredAt: 200,
    }),
    eventId: "z-result",
  };
  const attempt = {
    ...gatewayResult({
      operationId: "operation-stable",
      occurredAt: 200,
      outcome: "accepted",
      phase: "attempt",
    }),
    eventId: "z-attempt",
  };
  resultA.eventId = "a-result";
  const [operation] = groupEnvironmentAuditOperations([
    resultZ,
    attempt,
    resultA,
  ]);

  assert.ok(operation);
  assert.deepEqual(
    operation.events.map((event) => event.eventId),
    ["z-attempt", "a-result", "z-result"],
  );
  assert.equal(operation.primaryEvent.eventId, "z-result");
  assert.equal(operation.outcome, "succeeded");
});

test("deduplicates overlapping pages by event ID and payload hash only", () => {
  const first = events[0];
  const second = events[1];
  assert.ok(first);
  assert.ok(second);
  const duplicate = structuredClone(second);
  const conflict = {
    ...structuredClone(second),
    integrity: {
      ...second.integrity,
      payloadHash: "conflicting-payload-hash",
      eventIdConflict: true,
    },
  };

  const deduplicated = deduplicateEnvironmentAuditEvents([
    second,
    duplicate,
    conflict,
  ]);
  const merged = mergeEnvironmentAuditEventPages([
    [second, first],
    [duplicate, conflict],
  ]);

  assert.equal(deduplicated.length, 2);
  assert.equal(merged.length, 3);
  assert.equal(
    merged.filter((event) => event.eventId === second.eventId).length,
    2,
  );
  assert.notEqual(
    environmentAuditEventIdentity(second),
    environmentAuditEventIdentity(conflict),
  );
});

test("bursts only matching successful routine reads inside the fixed window", () => {
  const reads = [
    gatewayResult({
      operationId: "read-1",
      occurredAt: 1_000,
    }),
    gatewayResult({
      operationId: "read-2",
      occurredAt: 1_002,
    }),
    gatewayResult({
      operationId: "read-other-actor",
      occurredAt: 1_004,
      actorId: "another-api-key",
    }),
    gatewayResult({
      operationId: "read-outside-window",
      occurredAt: 1_031,
    }),
  ];
  const operations = groupEnvironmentAuditOperations(reads);
  const firstRead = operations.find(
    (operation) => operation.operationId === "read-1",
  );
  assert.ok(firstRead);
  assert.equal(environmentAuditOperationBurstKind(firstRead), "routine-read");

  const activities = projectEnvironmentAuditActivities(operations);
  const burst = activities.find(
    (activity) => activity.presentation === "burst",
  );

  assert.equal(activities.length, 3);
  assert.ok(burst);
  assert.equal(burst.burstKind, "routine-read");
  assert.equal(burst.operationCount, 2);
  assert.deepEqual(
    new Set(burst.operations.map((operation) => operation.operationId)),
    new Set(["read-1", "read-2"]),
  );
});

test("never bursts mutations, attention, integrity issues, or effect facts", () => {
  const mutationEvents = [
    gatewayResult({
      operationId: "mutation-1",
      occurredAt: 2_000,
      action: "session.input",
      method: "POST",
    }),
    gatewayResult({
      operationId: "mutation-2",
      occurredAt: 2_001,
      action: "session.input",
      method: "POST",
    }),
  ];
  const unknownEvents = [
    gatewayResult({
      operationId: "unknown-1",
      occurredAt: 2_002,
      outcome: "unknown",
    }),
    gatewayResult({
      operationId: "unknown-2",
      occurredAt: 2_003,
      outcome: "unknown",
    }),
  ];
  const integrityEvents = [
    gatewayResult({
      operationId: "invalid-1",
      occurredAt: 2_004,
      signatureStatus: "invalid",
    }),
    gatewayResult({
      operationId: "invalid-2",
      occurredAt: 2_005,
      signatureStatus: "invalid",
    }),
  ];
  const effectEvents = ["effect-1", "effect-2"].flatMap(
    (operationId, index) => [
      gatewayResult({
        operationId,
        occurredAt: 2_006 + index,
      }),
      gatewayResult({
        operationId,
        occurredAt: 2_006.1 + index,
        phase: "effect",
      }),
    ],
  );
  const operations = groupEnvironmentAuditOperations([
    ...mutationEvents,
    ...unknownEvents,
    ...integrityEvents,
    ...effectEvents,
  ]);
  const activities = projectEnvironmentAuditActivities(operations);

  assert.equal(operations.length, 8);
  assert.equal(activities.length, 8);
  assert.equal(
    activities.some((activity) => activity.presentation === "burst"),
    false,
  );
  assert.equal(
    operations.every(
      (operation) =>
        environmentAuditOperationBurstKind(operation) === undefined,
    ),
    true,
  );
});

test("bursts successful network connections by endpoint and totals only terminal facts", () => {
  const canonicalEvents = [
    ...networkOperation({
      operationId: "network-1",
      occurredAt: 3_000,
      attemptBytes: 999,
      resultIngressBytes: 10,
      resultEgressBytes: 1,
      resultDurationMs: 1,
    }),
    ...networkOperation({
      operationId: "network-2",
      occurredAt: 3_002,
      attemptBytes: 999,
      resultIngressBytes: 20,
      resultEgressBytes: 2,
      resultDurationMs: 2,
    }),
    ...networkOperation({
      operationId: "network-other-endpoint",
      occurredAt: 3_003,
      host: "registry.npmjs.org",
      attemptBytes: 999,
      resultIngressBytes: 30,
      resultEgressBytes: 3,
      resultDurationMs: 3,
    }),
    ...networkOperation({
      operationId: "network-error",
      occurredAt: 3_004,
      outcome: "error",
      attemptBytes: 999,
      resultIngressBytes: 40,
      resultEgressBytes: 4,
      resultDurationMs: 4,
    }),
  ];
  const operations = groupEnvironmentAuditOperations(canonicalEvents);
  const totals = summarizeEnvironmentAuditNetwork(operations);
  const activities = projectEnvironmentAuditActivities(operations);
  const successfulBurst = activities.find(
    (activity) =>
      activity.presentation === "burst" &&
      activity.burstKind === "network-connect",
  );
  const errorActivity = activities.find(
    (activity) =>
      activity.primaryOperation.operationId === "network-error",
  );

  assert.deepEqual(totals, {
    connections: 4,
    resultEvents: 4,
    durationMs: 10,
    ingressBytes: 100,
    egressBytes: 10,
  });
  assert.equal(activities.length, 3);
  assert.ok(successfulBurst);
  assert.deepEqual(successfulBurst.networkTotals, {
    connections: 2,
    resultEvents: 2,
    durationMs: 3,
    ingressBytes: 30,
    egressBytes: 3,
  });
  assert.ok(errorActivity);
  assert.equal(errorActivity.presentation, "operation");
  assert.equal(errorActivity.needsAttention, true);
});

test("overview groups one signed host across destination IPs and interleaved activity", () => {
  const canonicalEvents = [
    ...networkOperation({
      operationId: "overview-network-1",
      occurredAt: 4_000,
      destinationIp: "104.18.32.47",
      resultIngressBytes: 10,
    }),
    gatewayResult({
      operationId: "overview-mutation",
      occurredAt: 4_100,
      action: "session.input",
      method: "POST",
    }),
    ...networkOperation({
      operationId: "overview-network-2",
      occurredAt: 4_200,
      destinationIp: "172.64.155.209",
      resultIngressBytes: 20,
    }),
  ];
  const operations = groupEnvironmentAuditOperations(canonicalEvents);
  const chronological = projectEnvironmentAuditActivities(operations);
  const overview = projectEnvironmentAuditActivities(operations, {
    networkOverview: true,
  });
  const networkOverview = overview.find(
    (activity) => activity.burstKind === "network-connect",
  );

  assert.equal(chronological.length, 3);
  assert.equal(overview.length, 2);
  assert.ok(networkOverview);
  assert.equal(networkOverview.operationCount, 2);
  assert.equal(networkOverview.descriptor.endpoint, "api.github.com:443");
  assert.equal(networkOverview.networkTotals?.ingressBytes, 30);
});
