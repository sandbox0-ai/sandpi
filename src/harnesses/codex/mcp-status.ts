import type {
  CodexMcpCredentialState,
  CodexMcpOAuthFlow,
  CodexMcpOAuthFlowStatus,
  CodexMcpReadiness,
  CodexMcpServer,
} from "@/harnesses/codex/environment-tools";
import type {
  CodexMcpPresetAuth,
} from "@/harnesses/codex/mcp-catalog";

export interface CodexMcpConnectionState {
  credentialState: CodexMcpCredentialState;
  readiness: CodexMcpReadiness;
  anonymousAvailable: boolean;
  error?: string;
}

export type CodexMcpConnectionEvent =
  | { type: "inventory"; servers: readonly CodexMcpServer[] }
  | { type: "checking"; serverName: string }
  | { type: "oauth-completed"; serverName: string }
  | { type: "failed"; serverName: string; error: string }
  | { type: "stale"; serverName: string; error?: string }
  | { type: "removed"; serverName: string };

export type CodexMcpConnectionStates = Readonly<
  Record<string, CodexMcpConnectionState>
>;

export function isTerminalCodexMcpOAuthFlow(
  flow: Pick<CodexMcpOAuthFlow, "status">,
) {
  return isTerminalCodexMcpOAuthStatus(flow.status);
}

export function safeCodexMcpOAuthAuthorizationUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function mergeCodexMcpOAuthFlow(
  current: CodexMcpOAuthFlow | null,
  incoming: CodexMcpOAuthFlow,
): CodexMcpOAuthFlow {
  const { authorizationUrl: _incomingAuthorizationUrl, ...snapshot } = incoming;
  const authorizationUrl =
    safeCodexMcpOAuthAuthorizationUrl(_incomingAuthorizationUrl) ??
    (current?.id === incoming.id
      ? safeCodexMcpOAuthAuthorizationUrl(current.authorizationUrl)
      : undefined);
  return {
    ...snapshot,
    ...(authorizationUrl ? { authorizationUrl } : {}),
  };
}

export function codexMcpConnectionState(
  server: CodexMcpServer,
  declaredAuth?: CodexMcpPresetAuth,
): CodexMcpConnectionState {
  const hasServerInfo =
    server.hasServerInfo ??
    Boolean(
      server.serverTitle ||
        server.serverVersion ||
        server.runtimeStatus === "connected",
    );
  const credentialState =
    server.credentialState ??
    legacyCredentialState(server, declaredAuth);
  const readiness = !server.enabled
    ? "disabled"
    : hasServerInfo
      ? "ready"
      : (server.readiness ?? legacyReadiness(server));

  return {
    credentialState,
    readiness,
    anonymousAvailable:
      hasServerInfo &&
      (credentialState === "key-missing" ||
        credentialState === "oauth-required" ||
        credentialState === "reauth-required"),
    error: server.startupError,
  };
}

export function reduceCodexMcpConnectionStates(
  state: CodexMcpConnectionStates,
  event: CodexMcpConnectionEvent,
): CodexMcpConnectionStates {
  if (event.type === "inventory") {
    return Object.fromEntries(
      event.servers.map((server) => [
        server.name,
        codexMcpConnectionState(server),
      ]),
    );
  }
  if (event.type === "removed") {
    const next = { ...state };
    delete next[event.serverName];
    return next;
  }

  const current = state[event.serverName] ?? {
    credentialState: "unknown",
    readiness: "unknown",
    anonymousAvailable: false,
  };
  if (event.type === "checking") {
    return {
      ...state,
      [event.serverName]: {
        ...current,
        readiness: "checking",
        error: undefined,
      },
    };
  }
  if (event.type === "oauth-completed") {
    return {
      ...state,
      [event.serverName]: {
        credentialState: "oauth-authorized",
        readiness: "checking",
        anonymousAvailable: false,
      },
    };
  }
  if (event.type === "failed") {
    return {
      ...state,
      [event.serverName]: {
        ...current,
        readiness: "failed",
        error: event.error,
      },
    };
  }
  return {
    ...state,
    [event.serverName]: {
      ...current,
      readiness: "stale",
      error: event.error ?? current.error,
    },
  };
}

function legacyCredentialState(
  server: CodexMcpServer,
  declaredAuth?: CodexMcpPresetAuth,
): CodexMcpCredentialState {
  if (server.transport === "stdio" || declaredAuth?.requirement === "none") {
    return "public";
  }
  if (server.authStatus === "bearerToken") return "key-configured";
  if (server.authStatus === "oAuth") return "oauth-authorized";
  if (server.authStatus === "unsupported") {
    return declaredMissingCredential(declaredAuth) ?? "public";
  }
  if (server.authStatus === "notLoggedIn") {
    return declaredMissingCredential(declaredAuth) ?? "oauth-required";
  }
  return declaredMissingCredential(declaredAuth) ?? "unknown";
}

function declaredMissingCredential(
  declaredAuth?: CodexMcpPresetAuth,
): CodexMcpCredentialState | undefined {
  if (!declaredAuth || declaredAuth.requirement === "none") return undefined;
  const defaultMethod = declaredAuth.methods[0];
  if (defaultMethod === "oauth") return "oauth-required";
  if (defaultMethod === "bearer" || defaultMethod === "header") {
    return "key-missing";
  }
  return undefined;
}

function legacyReadiness(server: CodexMcpServer): CodexMcpReadiness {
  if (server.runtimeStatus === "connected") return "ready";
  if (server.runtimeStatus === "unavailable") return "failed";
  return "unknown";
}

function isTerminalCodexMcpOAuthStatus(status: CodexMcpOAuthFlowStatus) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "expired" ||
    status === "cancelled"
  );
}
