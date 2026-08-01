import assert from "node:assert/strict";
import test from "node:test";

import {
  preferencesUrl,
  safePreferencesReturnTo,
} from "./preferences-navigation";

test("preferencesUrl preserves the caller and additional parameters", () => {
  assert.equal(
    preferencesUrl("/?environment=env-2&session=session-3", {
      billing: "plan",
    }),
    "/preferences?billing=plan&return_to=%2F%3Fenvironment%3Denv-2%26session%3Dsession-3",
  );
});

test("safePreferencesReturnTo accepts local application locations", () => {
  assert.equal(
    safePreferencesReturnTo(
      "/ide/?environment=env-2&new=1&path=%2Fworkspace%2Fsrc#changes",
    ),
    "/ide/?environment=env-2&new=1&path=%2Fworkspace%2Fsrc#changes",
  );
});

test("safePreferencesReturnTo rejects external and recursive targets", () => {
  for (const target of [
    undefined,
    "https://example.com/private",
    "//example.com/private",
    "/preferences",
    "/preferences/?return_to=/preferences",
  ]) {
    assert.equal(safePreferencesReturnTo(target), "/");
  }
});
