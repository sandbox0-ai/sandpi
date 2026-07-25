import assert from "node:assert/strict";
import test from "node:test";

import {
  createEnvironmentEgressCredentialSchema,
  environmentEgressCredentialConfigurationSchema,
} from "./environment-credentials-schema";

test("normalizes a static header credential without retaining an arbitrary source ref", () => {
  const value = createEnvironmentEgressCredentialSchema.parse({
    name: " GitHub ",
    resolverKind: "static_headers",
    projection: {
      type: "http_headers",
      headers: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{ .secret }}",
        },
      ],
    },
    rule: {
      protocol: "https",
      domains: ["API.GitHub.com.", "api.github.com"],
      ports: [{ port: 443 }],
    },
    enabled: true,
    material: {
      type: "static_headers",
      values: { secret: "token" },
    },
    sourceRef: "browser-controlled-source",
  });

  assert.equal(value.name, "GitHub");
  assert.deepEqual(value.rule.domains, ["api.github.com"]);
  assert.deepEqual(value.rule.ports, [{ port: 443, protocol: "tcp" }]);
  assert.equal("sourceRef" in value, false);
});

test("rejects resolver, projection, protocol and material mismatches", () => {
  assert.throws(
    () =>
      createEnvironmentEgressCredentialSchema.parse({
        name: "Wrong",
        resolverKind: "static_headers",
        projection: { type: "ssh_proxy", upstreamUsername: "git", sandboxPublicKeys: ["ssh-ed25519 AAAA"] },
        rule: {
          protocol: "https",
          domains: ["github.com"],
          ports: [{ port: 443, protocol: "tcp" }],
          failurePolicy: "fail-closed",
        },
        enabled: true,
        material: {
          type: "static_ssh_private_key",
          privateKeyPem: "key",
        },
      }),
    /cannot project|cannot use|must match/,
  );
});

test("requires destination scope and valid projected header names", () => {
  assert.throws(
    () =>
      environmentEgressCredentialConfigurationSchema.parse({
        name: "Unscoped",
        resolverKind: "static_headers",
        projection: {
          type: "http_headers",
          headers: [{ name: "Bad Header", valueTemplate: "{{ .secret }}" }],
        },
        rule: {
          protocol: "https",
          domains: [],
          ports: [{ port: 443, protocol: "tcp" }],
          failurePolicy: "fail-closed",
        },
        enabled: true,
      }),
    /Invalid HTTP header name|Too small/,
  );
});
