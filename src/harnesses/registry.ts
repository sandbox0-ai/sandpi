import { isCodexSession } from "@/harnesses/codex/types";
import { forkMockCodexSession } from "@/harnesses/codex/session-actions";
import type { CodingSession, HarnessEventEnvelope } from "@/lib/types";
import type { UnixTimestamp } from "@/lib/time";

/**
 * Shared harness dispatch is deliberately limited to opaque transport operations. Rendering,
 * slash commands, approvals, models and Turn semantics stay inside each harness module.
 */
export function nativeEventsForSession(session: CodingSession): HarnessEventEnvelope[] {
  if (isCodexSession(session)) {
    return session.harnessState.events;
  }
  throw new Error(`No native event transport is registered for ${session.harness}.`);
}

/** Dispatches Session fork because native conversation branching is harness-specific. */
export function forkSessionForHarness(
  session: CodingSession,
  createdAt: UnixTimestamp,
): CodingSession {
  if (isCodexSession(session)) {
    return forkMockCodexSession(session, createdAt);
  }
  throw new Error(`No Session fork implementation is registered for ${session.harness}.`);
}
