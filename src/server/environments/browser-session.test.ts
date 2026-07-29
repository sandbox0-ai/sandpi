import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_BROWSER_OWNER_SESSION_NAME,
  ENVIRONMENT_BROWSER_SESSION_PREFIX,
  environmentBrowserSessionName,
  isEnvironmentBrowserSessionName,
} from "./browser-session";

test("derives stable opaque Playwright attachment names for Sandpi Sessions", () => {
  const first = environmentBrowserSessionName("session-one");

  assert.equal(ENVIRONMENT_BROWSER_OWNER_SESSION_NAME, "default");
  assert.match(
    first,
    new RegExp(`^${ENVIRONMENT_BROWSER_SESSION_PREFIX}[a-f0-9]{32}$`),
  );
  assert.equal(first, environmentBrowserSessionName("session-one"));
  assert.notEqual(first, environmentBrowserSessionName("session-two"));
  assert.ok(!first.includes("session-one"));
  assert.equal(isEnvironmentBrowserSessionName(first), true);
  assert.equal(isEnvironmentBrowserSessionName("default"), false);
});
