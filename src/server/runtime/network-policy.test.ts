import assert from "node:assert/strict";
import test from "node:test";

import { toSandbox0NetworkPolicy } from "./network-policy";

test("restricted policy maps to a block-all traffic allow rule", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "restricted",
      allowedDomains: ["GitHub.com", "https://api.github.com/", "github.com"],
      logDeniedRequests: true,
    }),
    {
      mode: "block-all",
      egress: {
        trafficRules: [
          {
            name: "sandpi-environment-allow",
            action: "allow",
            domains: ["api.github.com", "github.com"],
            ports: [{ port: 443, protocol: "tcp" }],
          },
        ],
      },
    },
  );
});

test("allow-all and block-all do not add irrelevant rules", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "allow-all",
      allowedDomains: ["github.com"],
      logDeniedRequests: false,
    }),
    { mode: "allow-all" },
  );
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "block-all",
      allowedDomains: ["github.com"],
      logDeniedRequests: true,
    }),
    { mode: "block-all" },
  );
});
