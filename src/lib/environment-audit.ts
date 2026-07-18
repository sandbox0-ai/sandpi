import type { EnvironmentAuditEvent } from "@/lib/types";

export interface EnvironmentAuditOperation {
  operationId: string;
  events: EnvironmentAuditEvent[];
  primaryEvent: EnvironmentAuditEvent;
  outcome: EnvironmentAuditEvent["outcome"];
  integrityIssueCount: number;
}

export type EnvironmentAuditView =
  | "all"
  | "attention"
  | "network"
  | "runtime"
  | "sandbox";

const outcomeSeverity: Record<EnvironmentAuditEvent["outcome"], number> = {
  completed: 0,
  succeeded: 0,
  accepted: 1,
  unknown: 2,
  denied: 3,
  failed: 3,
  error: 3,
};

export function isNegativeAuditOutcome(
  outcome: EnvironmentAuditEvent["outcome"],
) {
  return outcome === "denied" || outcome === "failed" || outcome === "error";
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
        (left, right) =>
          left.occurredAt - right.occurredAt,
      );
      const primaryEvent = sortedEvents.at(-1) ?? sortedEvents[0];
      if (!primaryEvent) {
        throw new Error(`Audit operation ${operationId} has no events.`);
      }
      const negativeOutcome = sortedEvents.reduce<
        EnvironmentAuditEvent["outcome"] | undefined
      >(
        (current, event) =>
          isNegativeAuditOutcome(event.outcome) &&
          (!current || outcomeSeverity[event.outcome] > outcomeSeverity[current])
            ? event.outcome
            : current,
        undefined,
      );
      return {
        operationId,
        events: sortedEvents,
        primaryEvent,
        // Accepted is an intermediate result. Once a later fact exists, the
        // operation should read from that fact unless any signed event failed.
        outcome: negativeOutcome ?? primaryEvent.outcome,
        integrityIssueCount: sortedEvents.filter(hasAuditIntegrityIssue).length,
      };
    })
    .sort(
      (left, right) =>
        right.primaryEvent.occurredAt - left.primaryEvent.occurredAt,
    );
}

export function auditOperationNeedsAttention(
  operation: EnvironmentAuditOperation,
) {
  return (
    isNegativeAuditOutcome(operation.outcome) ||
    operation.integrityIssueCount > 0
  );
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
  if (view === "network") {
    return operations.filter((operation) =>
      operation.events.some((event) => event.eventType === "network_audit"),
    );
  }
  if (view === "runtime") {
    return operations.filter((operation) =>
      operation.events.some(
        (event) =>
          event.eventType === "process" ||
          event.resource.type === "sandbox_process" ||
          event.resource.type === "sandbox_session",
      ),
    );
  }
  return operations.filter((operation) =>
    operation.events.some(
      (event) =>
        event.eventType === "lifecycle" || event.resource.type === "sandbox",
    ),
  );
}

export function summarizeEnvironmentAudit(events: EnvironmentAuditEvent[]) {
  const operations = groupEnvironmentAuditOperations(events);
  return {
    events: events.length,
    operations: operations.length,
    attention: operations.filter(auditOperationNeedsAttention).length,
    verified: events.filter(
      (event) =>
        event.integrity.signatureStatus === "verified" &&
        event.integrity.eventIdConflict !== true,
    ).length,
  };
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
