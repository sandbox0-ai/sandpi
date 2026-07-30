import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import {
  moveEnvironment,
  moveEnvironmentByOffset,
} from "@/lib/environment-order";

const environments = ["first", "second", "third"].map(
  (id) => ({ id }) as Environment,
);

test("moves an Environment to the target position", () => {
  assert.deepEqual(
    moveEnvironment(environments, "first", "third").map(({ id }) => id),
    ["second", "third", "first"],
  );
  assert.deepEqual(
    moveEnvironment(environments, "third", "first").map(({ id }) => id),
    ["third", "first", "second"],
  );
});

test("moves an Environment by one keyboard step without crossing bounds", () => {
  assert.deepEqual(
    moveEnvironmentByOffset(environments, "second", -1).map(({ id }) => id),
    ["second", "first", "third"],
  );
  assert.strictEqual(
    moveEnvironmentByOffset(environments, "first", -1),
    environments,
  );
});
