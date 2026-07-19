import assert from "node:assert/strict";
import test from "node:test";

import { toSandbox0NetworkPolicy } from "./network-policy";

test("block-all policy maps domain exceptions to one native allow rule", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "block-all",
      domainExceptions: ["GitHub.com", "api.github.com.", "github.com"],
    }),
    {
      mode: "block-all",
      egress: {
        trafficRules: [
          {
            name: "sandpi-environment-domain-exceptions",
            action: "allow",
            domains: ["api.github.com", "github.com"],
          },
        ],
      },
    },
  );
});

test("allow-all policy maps domain exceptions to one native deny rule", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "allow-all",
      domainExceptions: ["github.com", "*.example.com"],
    }),
    {
      mode: "allow-all",
      egress: {
        trafficRules: [
          {
            name: "sandpi-environment-domain-exceptions",
            action: "deny",
            domains: ["*.example.com", "github.com"],
          },
        ],
      },
    },
  );
});

test("base modes omit an empty native rule set", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "allow-all",
      domainExceptions: [],
    }),
    { mode: "allow-all" },
  );
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "block-all",
      domainExceptions: [],
    }),
    { mode: "block-all" },
  );
});

test("invalid persisted domains fail before applying a misleading policy", () => {
  assert.throws(
    () =>
      toSandbox0NetworkPolicy({
        mode: "block-all",
        domainExceptions: ["https://github.com"],
      }),
    /Invalid Environment network domain/,
  );
});
