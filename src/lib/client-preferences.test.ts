import assert from "node:assert/strict";
import test from "node:test";

import type { SandpiPreferences } from "./types";
import {
  buildAppearancePreviewPreferences,
  CLIENT_PREFERENCES_STORAGE_KEY,
  getClientPreferencesBootstrapScript,
  parseClientPreferences,
} from "./client-preferences";

const defaults: SandpiPreferences = {
  general: {
    language: "en",
    timeZone: "UTC",
    sendShortcut: "enter",
  },
  appearance: { theme: "system", density: "comfortable" },
  notifications: { sessionCompleted: true, needsAttention: true },
};

test("merges valid stored preferences with defaults", () => {
  const preferences = parseClientPreferences(
    JSON.stringify({
      general: { language: "zh-CN", sendShortcut: "mod-enter" },
      appearance: { theme: "dark", density: "compact" },
      notifications: { sessionCompleted: false },
    }),
    defaults,
  );

  assert.deepEqual(preferences, {
    general: {
      language: "zh-CN",
      timeZone: "UTC",
      sendShortcut: "mod-enter",
    },
    appearance: { theme: "dark", density: "compact" },
    notifications: { sessionCompleted: false, needsAttention: true },
  });
});

test("falls back field by field for malformed or unsupported values", () => {
  assert.deepEqual(parseClientPreferences("not json", defaults), defaults);

  const preferences = parseClientPreferences(
    JSON.stringify({
      general: { language: "xx", timeZone: 42 },
      appearance: { theme: "sepia", density: null },
      notifications: { needsAttention: "yes" },
    }),
    defaults,
  );
  assert.deepEqual(preferences, defaults);
});

test("bootstrap script applies the same storage contract before hydration", () => {
  const script = getClientPreferencesBootstrapScript(defaults);
  assert.match(script, new RegExp(CLIENT_PREFERENCES_STORAGE_KEY.replaceAll(".", "\\.")));
  assert.match(script, /root\.dataset\.theme/);
  assert.match(script, /root\.dataset\.density/);
  assert.match(script, /root\.lang/);
});

test("appearance preview preserves every saved non-appearance preference", () => {
  const preview = buildAppearancePreviewPreferences(defaults, {
    theme: "dark",
    density: "compact",
  });

  assert.deepEqual(preview.appearance, { theme: "dark", density: "compact" });
  assert.equal(preview.general, defaults.general);
  assert.equal(preview.notifications, defaults.notifications);
  assert.equal(preview.general.language, "en");
});
