import assert from "node:assert/strict";
import test from "node:test";

import type { CodexMcpServer } from "@/harnesses/codex/environment-tools";
import {
  codexMcpConnectionState,
  isTerminalCodexMcpOAuthFlow,
  mergeCodexMcpOAuthFlow,
  reduceCodexMcpConnectionStates,
  safeCodexMcpOAuthAuthorizationUrl,
} from "@/harnesses/codex/mcp-status";

function server(overrides: Partial<CodexMcpServer> = {}): CodexMcpServer {
  return {
    name: "example",
    transport: "streamable-http",
    args: [],
    url: "https://mcp.example.com/mcp",
    enabled: true,
    required: false,
    enabledTools: [],
    disabledTools: [],
    managed: true,
    authStatus: "unknown",
    runtimeStatus: "unavailable",
    toolCount: 0,
    resourceCount: 0,
    ...overrides,
  };
}

test("treats serverInfo as ready even when the server exposes zero tools", () => {
  assert.deepEqual(
    codexMcpConnectionState(
      server({
        authStatus: "notLoggedIn",
        runtimeStatus: "authentication-required",
        hasServerInfo: true,
      }),
    ),
    {
      credentialState: "oauth-required",
      readiness: "ready",
      anonymousAvailable: true,
      error: undefined,
    },
  );
});

test("keeps credential state independent from readiness", () => {
  const state = codexMcpConnectionState(
    server({
      credentialState: "key-configured",
      readiness: "failed",
      startupError: "Connection refused",
    }),
  );
  assert.equal(state.credentialState, "key-configured");
  assert.equal(state.readiness, "failed");
  assert.equal(state.error, "Connection refused");
});

test("lets disabled state override stale serverInfo", () => {
  const state = codexMcpConnectionState(
    server({
      enabled: false,
      hasServerInfo: true,
      credentialState: "oauth-authorized",
    }),
  );
  assert.equal(state.credentialState, "oauth-authorized");
  assert.equal(state.readiness, "disabled");
});

test("uses declared PAT-only auth when adapting legacy inventories", () => {
  const state = codexMcpConnectionState(server({ authStatus: "notLoggedIn" }), {
    requirement: "required",
    methods: ["bearer"],
    headerName: "Authorization",
  });
  assert.equal(state.credentialState, "key-missing");
  assert.equal(state.readiness, "failed");
});

test("keeps OAuth completion checking until a fresh snapshot arrives", () => {
  const checking = reduceCodexMcpConnectionStates(
    {},
    { type: "oauth-completed", serverName: "notion" },
  );
  assert.deepEqual(checking.notion, {
    credentialState: "oauth-authorized",
    readiness: "checking",
    anonymousAvailable: false,
  });

  const ready = reduceCodexMcpConnectionStates(checking, {
    type: "inventory",
    servers: [
      server({
        name: "notion",
        credentialState: "oauth-authorized",
        hasServerInfo: true,
      }),
    ],
  });
  assert.equal(ready.notion.readiness, "ready");
});

test("allows only absolute HTTPS OAuth authorization URLs", () => {
  assert.equal(
    safeCodexMcpOAuthAuthorizationUrl(
      "https://accounts.example.com/authorize?state=one#continue",
    ),
    "https://accounts.example.com/authorize?state=one#continue",
  );
  assert.equal(
    safeCodexMcpOAuthAuthorizationUrl("http://accounts.example.com/authorize"),
    undefined,
  );
  assert.equal(
    safeCodexMcpOAuthAuthorizationUrl("javascript:alert(1)"),
    undefined,
  );
  assert.equal(
    safeCodexMcpOAuthAuthorizationUrl("/relative/authorize"),
    undefined,
  );
  assert.equal(safeCodexMcpOAuthAuthorizationUrl("not a URL"), undefined);
});

test("preserves one safe authorization URL across recovered flow snapshots", () => {
  const current = {
    id: "flow-one",
    serverName: "notion",
    status: "awaiting_user" as const,
    authorizationUrl: "https://accounts.example.com/authorize?state=one",
  };
  assert.deepEqual(
    mergeCodexMcpOAuthFlow(current, {
      ...current,
      authorizationUrl: undefined,
    }),
    current,
  );
  assert.equal(
    mergeCodexMcpOAuthFlow(current, {
      id: "flow-two",
      serverName: "linear",
      status: "awaiting_user",
      authorizationUrl: "http://accounts.example.com/authorize",
    }).authorizationUrl,
    undefined,
  );
});

test("distinguishes active and terminal OAuth flow states", () => {
  assert.equal(
    isTerminalCodexMcpOAuthFlow({
      status: "awaiting_user",
    }),
    false,
  );
  for (const status of [
    "completed",
    "failed",
    "expired",
    "cancelled",
  ] as const) {
    assert.equal(isTerminalCodexMcpOAuthFlow({ status }), true);
  }
});
