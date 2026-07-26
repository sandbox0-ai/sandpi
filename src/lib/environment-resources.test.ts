import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB,
  ENVIRONMENT_SANDBOX_MEMORY_OPTIONS_MIB,
} from "./environment-resources";

test("new Environment Sandboxes default to one GiB of memory", () => {
  assert.equal(ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB, 1024);
  assert.ok(
    ENVIRONMENT_SANDBOX_MEMORY_OPTIONS_MIB.includes(
      ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB,
    ),
  );
});
