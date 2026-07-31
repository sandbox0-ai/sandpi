import { ApiError } from "@/lib/api-client";
import { createId } from "@/lib/id";

export interface SessionCreationGate {
  active: boolean;
  attempt?: {
    key: string;
    fingerprint: string;
  };
}

/** Admit one browser submission and retain its key across ambiguous retries. */
export function beginSessionCreation(
  gate: SessionCreationGate,
  fingerprint: string,
) {
  if (gate.active) return undefined;
  if (gate.attempt?.fingerprint !== fingerprint) {
    gate.attempt = {
      key: createId("session-create", 32),
      fingerprint,
    };
  }
  gate.active = true;
  return gate.attempt.key;
}

export function failSessionCreation(
  gate: SessionCreationGate,
  definitive: boolean,
) {
  gate.active = false;
  if (definitive) gate.attempt = undefined;
}

/** Keep the key when delivery or completion may have succeeded server-side. */
export function isDefinitiveSessionCreationFailure(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.code !== "session_creation_in_progress"
  );
}
