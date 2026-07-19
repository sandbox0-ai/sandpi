import assert from "node:assert/strict";
import test from "node:test";

import { networkPolicySchema } from "./network-policy-schema";

test("normalizes and deduplicates the two native network modes", () => {
  assert.deepEqual(
    networkPolicySchema.parse({
      mode: "block-all",
      domainExceptions: [" GitHub.COM. ", "github.com", "*.Example.com"],
    }),
    {
      mode: "block-all",
      domainExceptions: ["github.com", "*.example.com"],
    },
  );
});

test("rejects synthetic modes and non-domain exceptions", () => {
  assert.equal(
    networkPolicySchema.safeParse({
      mode: "restricted",
      domainExceptions: [],
    }).success,
    false,
  );
  assert.equal(
    networkPolicySchema.safeParse({
      mode: "allow-all",
      domainExceptions: ["https://github.com"],
    }).success,
    false,
  );
});
