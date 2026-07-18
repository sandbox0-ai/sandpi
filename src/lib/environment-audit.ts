import type { EnvironmentAuditEvent } from "@/lib/types";

export interface EnvironmentAuditOperation {
  operationId: string;
  events: EnvironmentAuditEvent[];
  primaryEvent: EnvironmentAuditEvent;
  outcome: EnvironmentAuditEvent["outcome"];
  integrityIssueCount: number;
  firstOccurredAt: number;
  lastOccurredAt: number;
}

export type EnvironmentAuditView =
  | "all"
  | "attention"
  | "network"
  | "runtime"
  | "sandbox";

export type EnvironmentAuditCategory =
  | "network"
  | "sandbox"
  | "runtime"
  | "workspace"
  | "observability"
  | "other";

export type EnvironmentAuditDescriptorKind =
  | "network"
  | "sandbox"
  | "sandbox-lifecycle"
  | "supervisor-session"
  | "process"
  | "workspace"
  | "observability"
  | "other";

export type EnvironmentAuditBurstKind = "routine-read" | "network-connect";

export interface EnvironmentAuditActivityDescriptor {
  category: EnvironmentAuditCategory;
  kind: EnvironmentAuditDescriptorKind;
  action: string;
  actorKind: EnvironmentAuditEvent["actor"]["kind"];
  source: EnvironmentAuditEvent["source"];
  resourceType: string;
  resourceId: string;
  resourceSubresource?: string;
  requestMethod?: string;
  requestRoute?: string;
  statusCode?: number;
  endpoint?: string;
  protocol?: string;
  reason?: string;
}

export interface EnvironmentAuditNetworkTotals {
  connections: number;
  resultEvents: number;
  durationMs?: number;
  ingressBytes?: number;
  egressBytes?: number;
}

export interface EnvironmentAuditActivity {
  id: string;
  presentation: "operation" | "burst";
  burstKind?: EnvironmentAuditBurstKind;
  operations: EnvironmentAuditOperation[];
  primaryOperation: EnvironmentAuditOperation;
  descriptor: EnvironmentAuditActivityDescriptor;
  outcome: EnvironmentAuditEvent["outcome"];
  operationCount: number;
  eventCount: number;
  firstOccurredAt: number;
  lastOccurredAt: number;
  integrityIssueCount: number;
  needsAttention: boolean;
  networkTotals?: EnvironmentAuditNetworkTotals;
}

export interface EnvironmentAuditActivitySummary {
  events: number;
  operations: number;
  activities: number;
  bursts: number;
  collapsedOperations: number;
  attention: number;
  verified: number;
  network: EnvironmentAuditNetworkTotals;
}

export const ENVIRONMENT_AUDIT_BURST_WINDOW_SECONDS = 30;

const outcomeSeverity: Record<EnvironmentAuditEvent["outcome"], number> = {
  completed: 0,
  succeeded: 0,
  accepted: 1,
  unknown: 2,
  denied: 3,
  failed: 3,
  error: 3,
};

const phaseOrder: Record<EnvironmentAuditEvent["phase"], number> = {
  attempt: 0,
  result: 1,
  effect: 2,
};

const routineReadActions = new Set([
  "audit.read",
  "directory.list",
  "file.read",
  "file.stat",
  "logs.read",
  "metrics.catalog.read",
  "metrics.read",
  "process.list",
  "process.read",
  "sandbox.list",
  "sandbox.network_policy.read",
  "sandbox.read",
  "sandbox.rootfs_snapshot.list",
  "sandbox.services.read",
  "sandbox.status.read",
  "session.events.read",
  "session.list",
  "session.read",
]);

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalNumber(left?: number, right?: number) {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return -1;
  }
  if (right === undefined) {
    return 1;
  }
  return left - right;
}

/**
 * Canonical facts can share timestamps. The remaining signed fields make their
 * presentation order deterministic without changing event identity.
 */
export function compareEnvironmentAuditEvents(
  left: EnvironmentAuditEvent,
  right: EnvironmentAuditEvent,
) {
  return (
    left.occurredAt - right.occurredAt ||
    left.ingestedAt - right.ingestedAt ||
    compareOptionalNumber(left.producer.sequence, right.producer.sequence) ||
    phaseOrder[left.phase] - phaseOrder[right.phase] ||
    compareText(left.eventId, right.eventId) ||
    compareText(left.integrity.payloadHash, right.integrity.payloadHash)
  );
}

/** A conflicting payload variant intentionally has a different identity. */
export function environmentAuditEventIdentity(event: EnvironmentAuditEvent) {
  return JSON.stringify([event.eventId, event.integrity.payloadHash]);
}

/**
 * Cursor pages can overlap during refresh. Remove only exact canonical payload
 * variants; preserve same-event-ID conflicts for inspection.
 */
export function deduplicateEnvironmentAuditEvents(
  events: readonly EnvironmentAuditEvent[],
) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const identity = environmentAuditEventIdentity(event);
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  });
}

export function mergeEnvironmentAuditEventPages(
  pages: ReadonlyArray<readonly EnvironmentAuditEvent[]>,
) {
  return deduplicateEnvironmentAuditEvents(pages.flat()).sort(
    compareEnvironmentAuditEvents,
  );
}

export function isNegativeAuditOutcome(
  outcome: EnvironmentAuditEvent["outcome"],
) {
  return outcome === "denied" || outcome === "failed" || outcome === "error";
}

export function isAttentionAuditOutcome(
  outcome: EnvironmentAuditEvent["outcome"],
) {
  return outcome === "unknown" || isNegativeAuditOutcome(outcome);
}

export function hasAuditIntegrityIssue(event: EnvironmentAuditEvent) {
  return (
    event.integrity.signatureStatus !== "verified" ||
    event.integrity.eventIdConflict === true
  );
}

/**
 * operationId correlates attempt/result/effect facts, but every signed event remains intact.
 * The UI can therefore make one operation expandable without merging away event identity,
 * phase, producer or integrity status.
 */
export function groupEnvironmentAuditOperations(
  events: EnvironmentAuditEvent[],
): EnvironmentAuditOperation[] {
  const grouped = new Map<string, EnvironmentAuditEvent[]>();
  for (const event of events) {
    const operationEvents = grouped.get(event.operationId) ?? [];
    operationEvents.push(event);
    grouped.set(event.operationId, operationEvents);
  }

  return [...grouped.entries()]
    .map(([operationId, operationEvents]) => {
      const sortedEvents = [...operationEvents].sort(
        compareEnvironmentAuditEvents,
      );
      const terminalEvents = sortedEvents.filter(
        (event) => event.phase !== "attempt",
      );
      const primaryEvent =
        terminalEvents.at(-1) ?? sortedEvents.at(-1) ?? sortedEvents[0];
      if (!primaryEvent) {
        throw new Error(`Audit operation ${operationId} has no events.`);
      }
      const attentionOutcome = sortedEvents.reduce<
        EnvironmentAuditEvent["outcome"] | undefined
      >(
        (current, event) =>
          isAttentionAuditOutcome(event.outcome) &&
          (!current ||
            outcomeSeverity[event.outcome] >= outcomeSeverity[current])
            ? event.outcome
            : current,
        undefined,
      );
      return {
        operationId,
        events: sortedEvents,
        primaryEvent,
        // Accepted is an intermediate result. Once a later fact exists, the
        // operation should read from that fact unless any signed event needs
        // attention. Unknown is deliberately not presented as success.
        outcome: attentionOutcome ?? primaryEvent.outcome,
        integrityIssueCount: sortedEvents.filter(hasAuditIntegrityIssue).length,
        firstOccurredAt: sortedEvents[0]?.occurredAt ?? primaryEvent.occurredAt,
        lastOccurredAt:
          sortedEvents.at(-1)?.occurredAt ?? primaryEvent.occurredAt,
      };
    })
    .sort(
      (left, right) =>
        compareEnvironmentAuditEvents(
          right.primaryEvent,
          left.primaryEvent,
        ) || compareText(right.operationId, left.operationId),
    );
}

export function auditOperationNeedsAttention(
  operation: EnvironmentAuditOperation,
) {
  return (
    isAttentionAuditOutcome(operation.outcome) ||
    operation.integrityIssueCount > 0
  );
}

export function classifyEnvironmentAuditOperation(
  operation: EnvironmentAuditOperation,
): EnvironmentAuditCategory {
  if (operation.events.some((event) => event.eventType === "network_audit")) {
    return "network";
  }
  if (
    operation.events.some(
      (event) =>
        event.eventType === "file" ||
        event.resource.type === "sandbox_file" ||
        event.action.startsWith("file.") ||
        event.action.startsWith("directory."),
    )
  ) {
    return "workspace";
  }
  if (
    operation.events.some(
      (event) =>
        event.eventType === "process" ||
        event.resource.type === "sandbox_process" ||
        event.resource.type === "sandbox_session",
    )
  ) {
    return "runtime";
  }
  if (
    operation.events.some(
      (event) =>
        event.resource.type === "sandbox_audit" ||
        event.resource.type === "sandbox_logs" ||
        event.resource.type === "sandbox_metrics" ||
        event.action.startsWith("audit.") ||
        event.action.startsWith("logs.") ||
        event.action.startsWith("metrics."),
    )
  ) {
    return "observability";
  }
  if (
    operation.events.some(
      (event) =>
        event.eventType === "lifecycle" ||
        event.resource.type === "sandbox" ||
        event.resource.type === "sandbox_network_policy" ||
        event.action.startsWith("sandbox."),
    )
  ) {
    return "sandbox";
  }
  return "other";
}

/** Product-level views deliberately hide the backend's source/type matrix. */
export function filterEnvironmentAuditOperations(
  operations: EnvironmentAuditOperation[],
  view: EnvironmentAuditView,
) {
  if (view === "all") {
    return operations;
  }
  if (view === "attention") {
    return operations.filter(auditOperationNeedsAttention);
  }
  return operations.filter(
    (operation) => classifyEnvironmentAuditOperation(operation) === view,
  );
}

function auditAttributes(event: EnvironmentAuditEvent): Record<string, unknown> {
  if (
    !event.attributes ||
    typeof event.attributes !== "object" ||
    Array.isArray(event.attributes)
  ) {
    return {};
  }
  return event.attributes as Record<string, unknown>;
}

function stringAttribute(
  attributes: Record<string, unknown>,
  key: string,
) {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAttribute(
  attributes: Record<string, unknown>,
  key: string,
) {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface NetworkAuditSynopsis {
  endpoint: string;
  protocol?: string;
  reason?: string;
  durationMs?: number;
  ingressBytes?: number;
  egressBytes?: number;
}

/** View-only projection; callers still retain and render the complete signed attributes. */
export function networkAuditSynopsis(
  event: EnvironmentAuditEvent,
): NetworkAuditSynopsis | undefined {
  if (event.eventType !== "network_audit") {
    return undefined;
  }
  const attributes = auditAttributes(event);
  const host = stringAttribute(attributes, "host");
  const address = host ?? stringAttribute(attributes, "dest_ip") ?? event.resource.id;
  const port = numberAttribute(attributes, "dest_port");
  return {
    endpoint: port ? `${address}:${port}` : address,
    protocol:
      stringAttribute(attributes, "protocol") ??
      stringAttribute(attributes, "transport"),
    reason: stringAttribute(attributes, "reason"),
    durationMs: numberAttribute(attributes, "duration_ms"),
    ingressBytes: numberAttribute(attributes, "ingress_bytes"),
    egressBytes: numberAttribute(attributes, "egress_bytes"),
  };
}

function networkEventForOperation(operation: EnvironmentAuditOperation) {
  const networkEvents = operation.events.filter(
    (event) => event.eventType === "network_audit",
  );
  return (
    networkEvents.filter((event) => event.phase !== "attempt").at(-1) ??
    networkEvents.at(-1)
  );
}

function descriptorKind(
  category: EnvironmentAuditCategory,
  event: EnvironmentAuditEvent,
): EnvironmentAuditDescriptorKind {
  if (category === "network") {
    return "network";
  }
  if (category === "sandbox") {
    return event.eventType === "lifecycle" ||
      [
        "sandbox.create",
        "sandbox.delete",
        "sandbox.pause",
        "sandbox.refresh",
        "sandbox.resume",
      ].includes(event.action)
      ? "sandbox-lifecycle"
      : "sandbox";
  }
  if (category === "workspace") {
    return "workspace";
  }
  if (category === "observability") {
    return "observability";
  }
  if (category === "runtime") {
    return event.eventType === "process" ||
      event.resource.type === "sandbox_process" ||
      event.action.startsWith("process.")
      ? "process"
      : "supervisor-session";
  }
  return "other";
}

/**
 * Safe semantic fields for a collapsed row. It intentionally exposes neither
 * request bodies nor inferred file paths, prompts, or tool semantics.
 */
export function describeEnvironmentAuditOperation(
  operation: EnvironmentAuditOperation,
): EnvironmentAuditActivityDescriptor {
  const category = classifyEnvironmentAuditOperation(operation);
  const event = networkEventForOperation(operation) ?? operation.primaryEvent;
  const network = networkAuditSynopsis(event);
  return {
    category,
    kind: descriptorKind(category, event),
    action: event.action,
    actorKind: event.actor.kind,
    source: event.source,
    resourceType: event.resource.type,
    resourceId: event.resource.id,
    resourceSubresource: event.resource.subresource,
    requestMethod: event.request?.httpMethod,
    requestRoute: event.request?.route,
    statusCode: event.request?.statusCode,
    endpoint: network?.endpoint,
    protocol: network?.protocol,
    reason: network?.reason,
  };
}

function addOptionalTotal(
  current: number | undefined,
  value: number | undefined,
) {
  if (value === undefined || value < 0) {
    return current;
  }
  return (current ?? 0) + value;
}

/**
 * Aggregate network facts without double-counting the accepted attempt that
 * precedes most results. Connection count is per canonical operation.
 */
export function summarizeEnvironmentAuditNetwork(
  operations: readonly EnvironmentAuditOperation[],
): EnvironmentAuditNetworkTotals {
  const totals: EnvironmentAuditNetworkTotals = {
    connections: 0,
    resultEvents: 0,
  };
  for (const operation of operations) {
    const terminalNetworkEvents = operation.events.filter(
      (event) =>
        event.eventType === "network_audit" && event.phase !== "attempt",
    );
    if (terminalNetworkEvents.length === 0) {
      continue;
    }
    totals.connections += 1;
    totals.resultEvents += terminalNetworkEvents.length;
    for (const event of terminalNetworkEvents) {
      const synopsis = networkAuditSynopsis(event);
      totals.durationMs = addOptionalTotal(
        totals.durationMs,
        synopsis?.durationMs,
      );
      totals.ingressBytes = addOptionalTotal(
        totals.ingressBytes,
        synopsis?.ingressBytes,
      );
      totals.egressBytes = addOptionalTotal(
        totals.egressBytes,
        synopsis?.egressBytes,
      );
    }
  }
  return totals;
}

function isSuccessfulAuditOutcome(
  outcome: EnvironmentAuditEvent["outcome"],
) {
  return outcome === "completed" || outcome === "succeeded";
}

/**
 * An allowlist makes read grouping auditable: new actions stay visible until
 * their semantics are explicitly reviewed. Effect facts are always standalone.
 */
export function environmentAuditOperationBurstKind(
  operation: EnvironmentAuditOperation,
): EnvironmentAuditBurstKind | undefined {
  if (
    !isSuccessfulAuditOutcome(operation.outcome) ||
    auditOperationNeedsAttention(operation) ||
    operation.events.some((event) => event.phase === "effect") ||
    !operation.events.some((event) => event.phase === "result")
  ) {
    return undefined;
  }

  if (
    operation.events.some(
      (event) =>
        event.eventType === "network_audit" &&
        event.action === "network.connect" &&
        event.phase === "result",
    )
  ) {
    return "network-connect";
  }

  if (
    routineReadActions.has(operation.primaryEvent.action) &&
    operation.primaryEvent.request?.httpMethod?.toUpperCase() === "GET"
  ) {
    return "routine-read";
  }
  return undefined;
}

function primitiveAttribute(
  event: EnvironmentAuditEvent,
  key: string,
): string | number | boolean | undefined {
  const value = auditAttributes(event)[key];
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
    ? value
    : undefined;
}

function auditActorFingerprint(event: EnvironmentAuditEvent) {
  return [
    event.actor.kind,
    event.actor.id,
    event.actor.userId,
    event.actor.apiKeyId,
    event.actor.authMethod,
  ];
}

/**
 * Only bounded canonical fields participate. In particular, arbitrary
 * attributes cannot accidentally merge operations or leak into UI copy.
 */
function environmentAuditBurstFingerprint(
  operation: EnvironmentAuditOperation,
  burstKind: EnvironmentAuditBurstKind,
) {
  const event = networkEventForOperation(operation) ?? operation.primaryEvent;
  const common = [
    burstKind,
    event.sandboxId,
    event.source,
    event.eventType,
    ...auditActorFingerprint(event),
    event.action,
    event.resource.type,
    event.resource.id,
    event.resource.subresource,
    operation.outcome,
  ];
  if (burstKind === "routine-read") {
    return JSON.stringify([
      ...common,
      event.request?.httpMethod,
      event.request?.route,
      event.request?.statusCode,
    ]);
  }
  const network = networkAuditSynopsis(event);
  return JSON.stringify([
    ...common,
    // A signed host is the logical endpoint. CDN/DNS destination IP changes
    // remain available in the canonical evidence but do not fragment Overview.
    network?.endpoint,
    primitiveAttribute(event, "transport"),
    network?.protocol,
    primitiveAttribute(event, "classifier_result"),
    primitiveAttribute(event, "action"),
    primitiveAttribute(event, "reason"),
    primitiveAttribute(event, "adapter"),
    primitiveAttribute(event, "auth_rule"),
    primitiveAttribute(event, "auth_ref"),
    primitiveAttribute(event, "auth_policy"),
    primitiveAttribute(event, "auth_bypassed"),
    primitiveAttribute(event, "auth_enforcement"),
    primitiveAttribute(event, "auth_resolved"),
    primitiveAttribute(event, "auth_cache"),
  ]);
}

function compareEnvironmentAuditOperationsAscending(
  left: EnvironmentAuditOperation,
  right: EnvironmentAuditOperation,
) {
  return (
    compareEnvironmentAuditEvents(left.primaryEvent, right.primaryEvent) ||
    compareText(left.operationId, right.operationId)
  );
}

interface EnvironmentAuditActivityDraft {
  id: string;
  burstKind?: EnvironmentAuditBurstKind;
  anchorAt: number;
  operations: EnvironmentAuditOperation[];
}

export interface EnvironmentAuditProjectionOptions {
  burstWindowSeconds?: number;
  /**
   * Overview groups successful connections by logical endpoint across the
   * loaded range. Negative, unknown, or unverifiable operations never qualify.
   */
  networkOverview?: boolean;
}

function finalizeEnvironmentAuditActivity(
  draft: EnvironmentAuditActivityDraft,
): EnvironmentAuditActivity {
  const operations = [...draft.operations].sort(
    (left, right) =>
      compareEnvironmentAuditOperationsAscending(right, left),
  );
  const primaryOperation = operations[0];
  if (!primaryOperation) {
    throw new Error(`Audit activity ${draft.id} has no operations.`);
  }
  const events = operations.flatMap((operation) => operation.events);
  const networkTotals = summarizeEnvironmentAuditNetwork(operations);
  const integrityIssueCount = operations.reduce(
    (total, operation) => total + operation.integrityIssueCount,
    0,
  );
  const attentionOperation = operations.find(auditOperationNeedsAttention);
  const isBurst = operations.length > 1;
  return {
    id: draft.id,
    presentation: isBurst ? "burst" : "operation",
    // A singleton keeps its eligible kind so callers can still classify it as
    // routine; `presentation` alone says whether aggregation actually occurred.
    burstKind: draft.burstKind,
    operations,
    primaryOperation,
    descriptor: describeEnvironmentAuditOperation(primaryOperation),
    outcome: attentionOperation?.outcome ?? primaryOperation.outcome,
    operationCount: operations.length,
    eventCount: events.length,
    firstOccurredAt: Math.min(
      ...operations.map((operation) => operation.firstOccurredAt),
    ),
    lastOccurredAt: Math.max(
      ...operations.map((operation) => operation.lastOccurredAt),
    ),
    integrityIssueCount,
    needsAttention: Boolean(attentionOperation) || integrityIssueCount > 0,
    networkTotals:
      networkTotals.resultEvents > 0 ? networkTotals : undefined,
  };
}

/**
 * Build a compact view without changing canonical operations. Only successful
 * allowlisted reads and successful network connections can form a burst.
 */
export function projectEnvironmentAuditActivities(
  operations: readonly EnvironmentAuditOperation[],
  options: EnvironmentAuditProjectionOptions = {},
): EnvironmentAuditActivity[] {
  const configuredWindow = options.burstWindowSeconds;
  const burstWindowSeconds =
    configuredWindow === undefined ||
    !Number.isFinite(configuredWindow) ||
    configuredWindow < 0
      ? ENVIRONMENT_AUDIT_BURST_WINDOW_SECONDS
      : configuredWindow;
  const networkOverview = options.networkOverview === true;
  const drafts: EnvironmentAuditActivityDraft[] = [];
  const openBursts = new Map<string, EnvironmentAuditActivityDraft>();
  const ascending = [...operations].sort(
    compareEnvironmentAuditOperationsAscending,
  );

  for (const operation of ascending) {
    const burstKind = environmentAuditOperationBurstKind(operation);
    if (!burstKind) {
      // Chronological bursts stop at important operations. Endpoint Overview
      // keeps only successful network buckets open across unrelated activity.
      if (networkOverview) {
        for (const [fingerprint, draft] of openBursts) {
          if (draft.burstKind !== "network-connect") {
            openBursts.delete(fingerprint);
          }
        }
      } else {
        openBursts.clear();
      }
      drafts.push({
        id: `audit-activity:${operation.operationId}`,
        anchorAt: operation.primaryEvent.occurredAt,
        operations: [operation],
      });
      continue;
    }

    const fingerprint = environmentAuditBurstFingerprint(
      operation,
      burstKind,
    );
    const existing = openBursts.get(fingerprint);
    const occurredAt = operation.primaryEvent.occurredAt;
    if (
      existing &&
      (networkOverview && burstKind === "network-connect"
        ? true
        : occurredAt - existing.anchorAt <= burstWindowSeconds)
    ) {
      existing.operations.push(operation);
      continue;
    }

    const draft: EnvironmentAuditActivityDraft = {
      id: `audit-activity:${operation.operationId}`,
      burstKind,
      anchorAt: occurredAt,
      operations: [operation],
    };
    drafts.push(draft);
    openBursts.set(fingerprint, draft);
  }

  return drafts
    .map(finalizeEnvironmentAuditActivity)
    .sort(
      (left, right) =>
        compareEnvironmentAuditEvents(
          right.primaryOperation.primaryEvent,
          left.primaryOperation.primaryEvent,
        ) || compareText(right.id, left.id),
    );
}

export function filterEnvironmentAuditActivities(
  activities: readonly EnvironmentAuditActivity[],
  view: EnvironmentAuditView,
) {
  if (view === "all") {
    return [...activities];
  }
  if (view === "attention") {
    return activities.filter((activity) => activity.needsAttention);
  }
  return activities.filter(
    (activity) => activity.descriptor.category === view,
  );
}

export function summarizeEnvironmentAuditActivities(
  activities: readonly EnvironmentAuditActivity[],
): EnvironmentAuditActivitySummary {
  const operations = activities.flatMap((activity) => activity.operations);
  const events = operations.flatMap((operation) => operation.events);
  return {
    events: events.length,
    operations: operations.length,
    activities: activities.length,
    bursts: activities.filter(
      (activity) => activity.presentation === "burst",
    ).length,
    collapsedOperations: operations.length - activities.length,
    attention: operations.filter(auditOperationNeedsAttention).length,
    verified: events.filter(
      (event) =>
        event.integrity.signatureStatus === "verified" &&
        event.integrity.eventIdConflict !== true,
    ).length,
    network: summarizeEnvironmentAuditNetwork(operations),
  };
}

export function summarizeEnvironmentAudit(
  events: EnvironmentAuditEvent[],
): EnvironmentAuditActivitySummary {
  return summarizeEnvironmentAuditActivities(
    projectEnvironmentAuditActivities(
      groupEnvironmentAuditOperations(events),
    ),
  );
}
