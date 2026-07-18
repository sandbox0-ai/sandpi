"use client";

import {
  Activity,
  ChevronDown,
  CircleAlert,
  Copy,
  Globe2,
  RotateCcw,
  ShieldCheck,
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
  filterEnvironmentAuditOperations,
  groupEnvironmentAuditOperations,
  hasAuditIntegrityIssue,
  networkAuditSynopsis,
  summarizeEnvironmentAudit,
  type EnvironmentAuditOperation,
  type EnvironmentAuditView,
} from "@/lib/environment-audit";
import { unixTimestampToIso } from "@/lib/time";
import type {
  EnvironmentAuditEvent,
  EnvironmentAuditFeed,
} from "@/lib/types";

interface EnvironmentAuditPanelProps {
  language: OperationLanguage;
  timeZone: string;
  environmentId: string;
  audit: EnvironmentAuditFeed;
}

type ActivityKind =
  | "network-allowed"
  | "network-blocked"
  | "sandbox-resumed"
  | "generic";

interface ActivityDescriptor {
  kind: ActivityKind;
  subject: string;
}

function describeActivity(operation: EnvironmentAuditOperation): ActivityDescriptor {
  const event = operation.primaryEvent;
  const network = networkAuditSynopsis(event);
  if (network) {
    return {
      kind: operation.outcome === "denied" ? "network-blocked" : "network-allowed",
      subject: network.endpoint,
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
  if (kind === "sandbox-resumed") {
    return <RotateCcw size={15} aria-hidden="true" />;
  }
  return <Activity size={15} aria-hidden="true" />;
}

function AuditTechnicalDetails({
  event,
  language,
}: {
  event: EnvironmentAuditEvent;
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
  event: EnvironmentAuditEvent;
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
          dateTime={unixTimestampToIso(event.occurredAt)}
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
  operation: EnvironmentAuditOperation;
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
          dateTime={unixTimestampToIso(operation.primaryEvent.occurredAt)}
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

export function EnvironmentAuditPanel({
  language,
  timeZone,
  environmentId,
  audit,
}: EnvironmentAuditPanelProps) {
  const ui = getOperationUiCopy(language).inspector;
  const [view, setView] = useState<EnvironmentAuditView>("all");
  const allOperations = useMemo(
    () => groupEnvironmentAuditOperations(audit.events),
    [audit.events],
  );
  const operations = useMemo(
    () => filterEnvironmentAuditOperations(allOperations, view),
    [allOperations, view],
  );
  const summary = useMemo(
    () => summarizeEnvironmentAudit(audit.events),
    [audit.events],
  );
  const verificationIssues = summary.events - summary.verified;

  useEffect(() => setView("all"), [environmentId]);

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
            onChange={(event) =>
              setView(event.target.value as EnvironmentAuditView)
            }
            aria-label={ui.activityFilter}
            disabled={audit.events.length === 0}
          >
            <option value="all">{ui.allActivity}</option>
            <option value="attention">
              {ui.attentionOnly} ({summary.attention})
            </option>
            <option value="network">{ui.networkActivity}</option>
            <option value="runtime">{ui.runtimeActivity}</option>
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
