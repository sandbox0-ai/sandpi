"use client";

import {
  Activity,
  ChevronDown,
  CircleAlert,
  Copy,
  Globe2,
  RotateCcw,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  formatAuditDateTime,
  formatAuditTime,
  getOperationUiCopy,
  type OperationLanguage,
} from "@/lib/operation-ui";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  auditOperationNeedsAttention,
  filterSessionAuditOperations,
  groupSessionAuditOperations,
  hasAuditIntegrityIssue,
  networkAuditSynopsis,
  summarizeSessionAudit,
  type SessionAuditOperation,
  type SessionAuditView,
} from "@/lib/session-audit";
import type { SessionAuditEvent, SessionAuditFeed } from "@/lib/types";

interface SessionAuditPanelProps {
  language: OperationLanguage;
  timeZone: string;
  sessionId: string;
  audit: SessionAuditFeed;
}

type ActivityKind =
  | "network-allowed"
  | "network-blocked"
  | "command-completed"
  | "command-failed"
  | "sandbox-resumed"
  | "generic";

interface ActivityDescriptor {
  kind: ActivityKind;
  subject: string;
}

function eventAttributes(event: SessionAuditEvent) {
  return event.attributes &&
    typeof event.attributes === "object" &&
    !Array.isArray(event.attributes)
    ? (event.attributes as Record<string, unknown>)
    : {};
}

function describeActivity(operation: SessionAuditOperation): ActivityDescriptor {
  const event = operation.primaryEvent;
  const network = networkAuditSynopsis(event);
  if (network) {
    return {
      kind: operation.outcome === "denied" ? "network-blocked" : "network-allowed",
      subject: network.endpoint,
    };
  }

  if (event.action === "process.exit") {
    const attributes = eventAttributes(event);
    const command =
      typeof attributes.command === "string"
        ? attributes.command
        : event.resource.id;
    const exitCode = attributes.exit_code;
    return {
      kind:
        operation.outcome === "failed" ||
        operation.outcome === "error" ||
        (typeof exitCode === "number" && exitCode !== 0)
          ? "command-failed"
          : "command-completed",
      subject: command,
    };
  }

  if (event.action === "sandbox.resume") {
    return { kind: "sandbox-resumed", subject: event.resource.id };
  }

  return {
    kind: "generic",
    subject: event.action.replaceAll(/[._-]+/g, " "),
  };
}

function ActivityGlyph({ kind }: { kind: ActivityKind }) {
  if (kind === "network-allowed" || kind === "network-blocked") {
    return <Globe2 size={15} aria-hidden="true" />;
  }
  if (kind === "command-completed" || kind === "command-failed") {
    return <SquareTerminal size={15} aria-hidden="true" />;
  }
  if (kind === "sandbox-resumed") {
    return <RotateCcw size={15} aria-hidden="true" />;
  }
  return <Activity size={15} aria-hidden="true" />;
}

function AuditTechnicalDetails({
  event,
  language,
}: {
  event: SessionAuditEvent;
  language: OperationLanguage;
}) {
  const ui = getOperationUiCopy(language).inspector;
  const [copied, setCopied] = useState(false);
  const signatureLabel = {
    verified: ui.signatureVerified,
    invalid: ui.signatureInvalid,
    unavailable: ui.signatureUnavailable,
  }[event.integrity.signatureStatus];

  async function copyEvent() {
    try {
      await copyTextToClipboard(JSON.stringify(event, null, 2));
    } catch {
      // Local previews can run without clipboard permission.
    }
    setCopied(true);
  }

  return (
    <details className="audit-technical-details">
      <summary>
        <span>{ui.technicalDetails}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </summary>
      <div className="audit-technical-content">
        <div className="audit-technical-toolbar">
          <span
            className={
              hasAuditIntegrityIssue(event)
                ? "audit-signature is-warning"
                : "audit-signature"
            }
          >
            {hasAuditIntegrityIssue(event) ? (
              <CircleAlert size={12} aria-hidden="true" />
            ) : (
              <ShieldCheck size={12} aria-hidden="true" />
            )}
            {signatureLabel}
            {event.integrity.eventIdConflict ? ` · ${ui.eventIdConflict}` : ""}
          </span>
          <button type="button" onClick={copyEvent} aria-live="polite">
            <Copy size={12} aria-hidden="true" />
            {copied ? ui.copied : ui.copyEvent}
          </button>
        </div>
        <pre>{JSON.stringify(event, null, 2)}</pre>
      </div>
    </details>
  );
}

function AuditEventStep({
  event,
  language,
  timeZone,
}: {
  event: SessionAuditEvent;
  language: OperationLanguage;
  timeZone: string;
}) {
  const ui = getOperationUiCopy(language).inspector;
  return (
    <li className={`audit-event-step outcome-${event.outcome}`}>
      <span className="audit-event-step-dot" aria-hidden="true" />
      <div className="audit-event-step-row">
        <div>
          <strong>{ui.phaseLabel(event.phase)}</strong>
          <span>{ui.recordedBy(event.source)}</span>
        </div>
        <span className="audit-event-step-status">
          {ui.outcomeLabel(event.outcome)}
        </span>
        <time
          dateTime={event.occurredAt}
          title={formatAuditDateTime(event.occurredAt, language, timeZone)}
        >
          {formatAuditTime(event.occurredAt, language, timeZone)}
        </time>
      </div>
      <AuditTechnicalDetails event={event} language={language} />
    </li>
  );
}

function AuditActivity({
  operation,
  language,
  timeZone,
}: {
  operation: SessionAuditOperation;
  language: OperationLanguage;
  timeZone: string;
}) {
  const ui = getOperationUiCopy(language).inspector;
  const descriptor = describeActivity(operation);
  const attention = auditOperationNeedsAttention(operation);

  const copy = {
    "network-allowed": {
      title: ui.connectedTo(descriptor.subject),
      description: ui.connectionAllowed,
    },
    "network-blocked": {
      title: ui.blockedConnection(descriptor.subject),
      description: ui.connectionBlocked,
    },
    "command-completed": {
      title: ui.commandCompleted,
      description: descriptor.subject,
    },
    "command-failed": {
      title: ui.commandFailed,
      description: descriptor.subject,
    },
    "sandbox-resumed": {
      title: ui.sandboxResumed,
      description: ui.sandboxReady,
    },
    generic: {
      title: descriptor.subject,
      description: ui.recordedActivity(operation.primaryEvent.resource.type),
    },
  }[descriptor.kind];

  return (
    <details
      className={`audit-activity ${attention ? "needs-attention" : ""}`}
    >
      <summary>
        <span className={`audit-activity-icon kind-${descriptor.kind}`}>
          <ActivityGlyph kind={descriptor.kind} />
        </span>
        <span className="audit-activity-copy">
          <strong>{copy.title}</strong>
          <span>{copy.description}</span>
        </span>
        <span className={`audit-activity-status outcome-${operation.outcome}`}>
          {ui.outcomeLabel(operation.outcome)}
        </span>
        <time
          dateTime={operation.primaryEvent.occurredAt}
          title={formatAuditDateTime(
            operation.primaryEvent.occurredAt,
            language,
            timeZone,
          )}
        >
          {formatAuditTime(operation.primaryEvent.occurredAt, language, timeZone)}
        </time>
        <ChevronDown className="audit-activity-chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="audit-activity-body">
        <p>{ui.activityTrail(operation.events.length)}</p>
        <ol className="audit-event-trail">
          {operation.events.map((event) => (
            <AuditEventStep
              event={event}
              key={`${event.eventId}-${event.integrity.payloadHash}`}
              language={language}
              timeZone={timeZone}
            />
          ))}
        </ol>
      </div>
    </details>
  );
}

export function SessionAuditPanel({
  language,
  timeZone,
  sessionId,
  audit,
}: SessionAuditPanelProps) {
  const ui = getOperationUiCopy(language).inspector;
  const [view, setView] = useState<SessionAuditView>("all");
  const allOperations = useMemo(
    () => groupSessionAuditOperations(audit.events),
    [audit.events],
  );
  const operations = useMemo(
    () => filterSessionAuditOperations(allOperations, view),
    [allOperations, view],
  );
  const summary = useMemo(() => summarizeSessionAudit(audit.events), [audit.events]);
  const verificationIssues = summary.events - summary.verified;

  useEffect(() => setView("all"), [sessionId]);

  return (
    <div className="inspector-panel audit-panel">
      <div className="audit-toolbar">
        <div>
          <h2>{ui.auditEvents}</h2>
          <p>{ui.activitySummary(summary.operations, summary.attention)}</p>
        </div>
        <label className="audit-view-filter">
          <span className="sr-only">{ui.activityFilter}</span>
          <select
            value={view}
            onChange={(event) => setView(event.target.value as SessionAuditView)}
            aria-label={ui.activityFilter}
            disabled={audit.events.length === 0}
          >
            <option value="all">{ui.allActivity}</option>
            <option value="attention">
              {ui.attentionOnly} ({summary.attention})
            </option>
            <option value="network">{ui.networkActivity}</option>
            <option value="process">{ui.processActivity}</option>
            <option value="sandbox">{ui.sandboxLifecycle}</option>
          </select>
        </label>
      </div>

      {summary.events > 0 ? (
        <div
          className={`audit-verification ${
            verificationIssues > 0 ? "is-warning" : ""
          }`}
        >
          {verificationIssues > 0 ? (
            <CircleAlert size={13} aria-hidden="true" />
          ) : (
            <ShieldCheck size={13} aria-hidden="true" />
          )}
          <span>
            {verificationIssues > 0
              ? ui.recordsNeedVerification(verificationIssues)
              : ui.auditDataVerified}
          </span>
        </div>
      ) : null}

      {operations.length > 0 ? (
        <div className="audit-timeline">
          {operations.map((operation) => (
            <AuditActivity
              operation={operation}
              key={operation.operationId}
              language={language}
              timeZone={timeZone}
            />
          ))}
        </div>
      ) : (
        <div className="audit-empty-state">
          <ShieldCheck size={20} aria-hidden="true" />
          <strong>
            {audit.events.length === 0 ? ui.noAuditEvents : ui.noMatchingAuditEvents}
          </strong>
          <p>{ui.asynchronousAudit}</p>
        </div>
      )}
    </div>
  );
}
