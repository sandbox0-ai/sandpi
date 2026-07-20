"use client";

import { useSyncExternalStore } from "react";

import {
  DEFAULT_LOCAL_UI_PREFERENCES,
  loadLocalUiPreferences,
  subscribeLocalUiPreferences,
} from "./local-ui-preferences";

function localUiPreferencesServerSnapshot() {
  return DEFAULT_LOCAL_UI_PREFERENCES;
}

/** One reactive browser-only preference source shared by every UI control. */
export function useLocalUiPreferences() {
  return useSyncExternalStore(
    subscribeLocalUiPreferences,
    loadLocalUiPreferences,
    localUiPreferencesServerSnapshot,
  );
}
