import { visibleSessionsForEnvironment } from "@/lib/session-list";
import type {
  CodingSession,
  Environment,
  EnvironmentCloudState,
} from "@/lib/types";

export const NATIVE_APP_RESUME_EVENT = "sandpi:native-resume";
export const CLOUD_SYNC_STALE_MS = 45_000;

export interface CloudWorkspaceState {
  environments: Environment[];
  sessions: CodingSession[];
  selectedEnvironmentId: string;
  selectedSessionId: string;
}

function initialSandboxState(
  environment: EnvironmentCloudState,
): Environment["sandboxState"] {
  if (environment.status === "updating") return "provisioning";
  if (environment.status === "error") return "failed";
  return "pending";
}

export function mergeCloudEnvironments(
  current: Environment[],
  incoming: EnvironmentCloudState[],
) {
  const currentById = new Map(
    current.map((environment) => [environment.id, environment]),
  );
  return incoming.map((environment): Environment => {
    const existing = currentById.get(environment.id);
    if (existing && existing.revision > environment.revision) {
      return existing;
    }
    return {
      ...environment,
      sandboxState:
        existing?.sandboxState ?? initialSandboxState(environment),
    };
  });
}

export function mergeCloudSessions(
  current: CodingSession[],
  incoming: CodingSession[],
) {
  const currentById = new Map(
    current.map((session) => [session.id, session]),
  );
  return incoming.map((session) => {
    const existing = currentById.get(session.id);
    return existing && existing.updatedAt > session.updatedAt
      ? existing
      : session;
  });
}

export function reconcileCloudWorkspaceState(
  current: CloudWorkspaceState,
  incoming: Pick<CloudWorkspaceState, "environments" | "sessions">,
): CloudWorkspaceState {
  const selectedEnvironment =
    incoming.environments.find(
      (environment) => environment.id === current.selectedEnvironmentId,
    ) ?? incoming.environments[0];
  if (!selectedEnvironment) {
    return {
      ...incoming,
      selectedEnvironmentId: "",
      selectedSessionId: "",
    };
  }

  const preservingNewSession =
    current.selectedSessionId === "" &&
    selectedEnvironment.id === current.selectedEnvironmentId;
  const selectedSession = preservingNewSession
    ? undefined
    : incoming.sessions.find(
        (session) =>
          session.id === current.selectedSessionId &&
          session.environmentId === selectedEnvironment.id &&
          !session.archived,
      ) ??
      visibleSessionsForEnvironment(
        incoming.sessions,
        selectedEnvironment.id,
      )[0];

  return {
    ...incoming,
    selectedEnvironmentId: selectedEnvironment.id,
    selectedSessionId: preservingNewSession
      ? ""
      : selectedSession?.id ?? "",
  };
}
