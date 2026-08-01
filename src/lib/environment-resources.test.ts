import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB,
  ENVIRONMENT_SANDBOX_MEMORY_OPTIONS_MIB,
} from "./environment-resources";

test("new Environment Sandboxes default to one GiB of memory", () => {
  assert.equal(ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB, 1024);
  assert.deepEqual(ENVIRONMENT_SANDBOX_MEMORY_OPTIONS_MIB, [
    1024, 2048, 4096, 8192,
  ]);
});
