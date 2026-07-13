import assert from "node:assert/strict";
import test from "node:test";

import { mockSessions } from "@/lib/mock-data";

import {
  filterSessionAuditOperations,
  groupSessionAuditOperations,
  hasAuditIntegrityIssue,
  networkAuditSynopsis,
  summarizeSessionAudit,
} from "./session-audit";

const events = mockSessions[0]?.audit.events ?? [];

test("groups phases by operation without merging signed events", () => {
  const operations = groupSessionAuditOperations(events);
  const resume = operations.find(
    (operation) => operation.primaryEvent.action === "sandbox.resume",
  );

  assert.ok(resume);
  assert.equal(resume.events.length, 3);
  assert.deepEqual(
    resume.events.map((event) => event.phase),
    ["attempt", "result", "effect"],
  );
  assert.equal(resume.outcome, "completed");
  assert.equal(new Set(resume.events.map((event) => event.eventId)).size, 3);
});

test("offers simple product views over canonical event fields", () => {
  const operations = groupSessionAuditOperations(events);

  assert.equal(filterSessionAuditOperations(operations, "all").length, 4);
  assert.equal(filterSessionAuditOperations(operations, "attention").length, 1);
  assert.equal(filterSessionAuditOperations(operations, "network").length, 2);
  assert.equal(filterSessionAuditOperations(operations, "process").length, 1);
  assert.equal(filterSessionAuditOperations(operations, "sandbox").length, 1);
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
  assert.equal(synopsis?.reason, "not_in_policy");
  assert.deepEqual(denied.attributes, before);
});

test("summarizes canonical events separately from correlated operations", () => {
  const summary = summarizeSessionAudit(events);
  assert.equal(summary.events, 6);
  assert.equal(summary.operations, 4);
  assert.equal(summary.attention, 1);
  assert.equal(summary.verified, 6);
});
