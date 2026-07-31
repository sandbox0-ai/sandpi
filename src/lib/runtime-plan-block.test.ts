import assert from "node:assert/strict";
import test from "node:test";

import { runtimePlanBlockFromMeta } from "./runtime-plan-block";

test("parses quota-blocked persistent Workspace metadata", () => {
  assert.deepEqual(
    runtimePlanBlockFromMeta({
      runtimeAccess: "persistent-storage",
      runtimeBlock: {
        code: "sandbox_runtime_quota_exhausted",
        message: "Runtime quota exhausted.",
        details: {
          planId: "plus",
          resetAt: 1_785_600_000,
          usedGiBHours: 126.5,
          limitGiBHours: 125,
        },
      },
    }),
    {
      code: "sandbox_runtime_quota_exhausted",
      message: "Runtime quota exhausted.",
      planId: "plus",
      resetAt: 1_785_600_000,
      usedGiBHours: 126.5,
      limitGiBHours: 125,
    },
  );
});

test("ignores normal runtime and malformed block metadata", () => {
  assert.equal(
    runtimePlanBlockFromMeta({ runtimeAccess: "sandbox" }),
    undefined,
  );
  assert.equal(
    runtimePlanBlockFromMeta({
      runtimeAccess: "persistent-storage",
      runtimeBlock: { code: "other" },
    }),
    undefined,
  );
});
