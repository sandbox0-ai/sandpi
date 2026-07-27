import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCAL_UI_PREFERENCES,
  normalizeLocalUiPreferences,
  parseLocalUiPreferences,
} from "./local-ui-preferences";

test("normalizes browser-only UI preferences field by field", () => {
  assert.deepEqual(
    normalizeLocalUiPreferences({
      workspace: {
        sidebarCollapsed: true,
        inspectorOpen: true,
        inspectorTab: "metrics",
        inspectorWidthRatio: 0.625,
        metricsRangeSeconds: 86_400,
        terminalHeight: 487.6,
      },
      filters: {
        codexSessionActivity: "commands",
      },
    }),
    {
      workspace: {
        sidebarCollapsed: true,
        inspectorOpen: true,
        inspectorTab: "metrics",
        inspectorWidthRatio: 0.625,
        metricsRangeSeconds: 86_400,
        terminalHeight: 488,
      },
      filters: {
        codexSessionActivity: "commands",
      },
      codingAgentComposers: [],
    },
  );
});

test("falls back safely for malformed local UI preferences", () => {
  assert.deepEqual(
    normalizeLocalUiPreferences({
      workspace: {
        sidebarCollapsed: "yes",
        inspectorOpen: "sometimes",
        inspectorTab: "secrets",
        inspectorWidthRatio: Number.NaN,
        metricsRangeSeconds: 42,
        terminalHeight: Number.NaN,
      },
      filters: {
        codexSessionActivity: "messages",
      },
      codingAgentComposers: [{ modelId: "missing-scope" }],
    }),
    DEFAULT_LOCAL_UI_PREFERENCES,
  );
  assert.deepEqual(
    parseLocalUiPreferences("{not-json"),
    DEFAULT_LOCAL_UI_PREFERENCES,
  );
});

test("keeps Browser as a durable Inspector tab", () => {
  assert.equal(
    normalizeLocalUiPreferences({
      workspace: { inspectorTab: "browser" },
    }).workspace.inspectorTab,
    "browser",
  );
});

test("keeps opaque live coding-agent choices scoped and deduplicated", () => {
  const preferences = normalizeLocalUiPreferences({
    codingAgentComposers: [
      {
        environmentId: "env-1",
        harness: "future-agent",
        modelId: "future/model",
        reasoningEfforts: {
          "future/model": "ultra-adaptive",
        },
        updatedAt: 10,
      },
      {
        environmentId: "env-1",
        harness: "future-agent",
        modelId: "stale-model",
        reasoningEfforts: {},
        updatedAt: 5,
      },
      {
        environmentId: "env-1",
        harness: "future-agent",
        sessionId: "session-1",
        modelId: "session/model",
        reasoningEfforts: {
          "session/model": "focused",
        },
        updatedAt: 8,
      },
    ],
  });

  assert.deepEqual(preferences.codingAgentComposers, [
    {
      environmentId: "env-1",
      harness: "future-agent",
      modelId: "future/model",
      reasoningEfforts: {
        "future/model": "ultra-adaptive",
      },
      updatedAt: 10,
    },
    {
      environmentId: "env-1",
      harness: "future-agent",
      sessionId: "session-1",
      modelId: "session/model",
      reasoningEfforts: {
        "session/model": "focused",
      },
      updatedAt: 8,
    },
  ]);
});
