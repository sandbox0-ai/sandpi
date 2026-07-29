import assert from "node:assert/strict";
import test from "node:test";

import type { SandpiPreferences } from "./types";
import {
  buildAppearancePreviewPreferences,
  CLIENT_PREFERENCES_STORAGE_KEY,
  getClientPreferencesBootstrapScript,
  NATIVE_CHROME_BOTTOM_COLOR_META_NAME,
  NATIVE_CHROME_TOP_COLOR_META_NAME,
  parseClientPreferences,
} from "./client-preferences";

const defaults: SandpiPreferences = {
  general: {
    language: "en",
    timeZone: "UTC",
    sendShortcut: "enter",
  },
  appearance: { theme: "system", density: "comfortable" },
};

test("merges valid stored preferences with defaults", () => {
  const preferences = parseClientPreferences(
    JSON.stringify({
      general: { language: "zh-CN", sendShortcut: "mod-enter" },
      appearance: { theme: "dark", density: "compact" },
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
  });
});

test("falls back field by field for malformed or unsupported values", () => {
  assert.deepEqual(parseClientPreferences("not json", defaults), defaults);

  const preferences = parseClientPreferences(
    JSON.stringify({
      general: { language: "xx", timeZone: 42 },
      appearance: { theme: "sepia", density: null },
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
  assert.match(script, /meta\[name="theme-color"\]/);
  assert.match(script, new RegExp(NATIVE_CHROME_TOP_COLOR_META_NAME));
  assert.match(script, new RegExp(NATIVE_CHROME_BOTTOM_COLOR_META_NAME));
});

test("appearance preview preserves saved general preferences", () => {
  const preview = buildAppearancePreviewPreferences(defaults, {
    theme: "dark",
    density: "compact",
  });

  assert.deepEqual(preview.appearance, { theme: "dark", density: "compact" });
  assert.equal(preview.general, defaults.general);
  assert.equal(preview.general.language, "en");
});
