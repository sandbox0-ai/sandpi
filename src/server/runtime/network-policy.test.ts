import assert from "node:assert/strict";
import test from "node:test";

import {
  toSandbox0NetworkPolicy,
  type ManagedMcpCredentialBinding,
} from "./network-policy";

const githubCredential: ManagedMcpCredentialBinding = {
  bindingRef: "github-pat",
  sourceRef: "credential-source-github",
  destinationDomain: "api.githubcopilot.com",
  destinationPath: "/mcp/",
  credentialHeaderName: "Authorization",
  credentialValueTemplate: "Bearer {{ .token }}",
};

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
      credentialBindings: [],
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
      credentialBindings: [],
    },
  );
});

test("base modes explicitly clear managed credential bindings", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "allow-all",
      domainExceptions: [],
    }),
    { mode: "allow-all", credentialBindings: [] },
  );
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "block-all",
      domainExceptions: [],
    }),
    { mode: "block-all", credentialBindings: [] },
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

test("managed MCP static credentials use exact fail-closed HTTPS matching", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy(
      {
        mode: "block-all",
        domainExceptions: ["api.githubcopilot.com"],
      },
      [githubCredential],
    ),
    {
      mode: "block-all",
      egress: {
        trafficRules: [
          {
            name: "sandpi-environment-domain-exceptions",
            action: "allow",
            domains: ["api.githubcopilot.com"],
          },
        ],
        credentialRules: [
          {
            name: "sandpi-mcp-credential-22550b936ddc",
            credentialRef: "github-pat",
            rollout: "enabled",
            protocol: "https",
            tlsMode: "terminate-reoriginate",
            failurePolicy: "fail-closed",
            domains: ["api.githubcopilot.com"],
            ports: [{ port: 443, protocol: "tcp" }],
            httpMatch: {
              paths: ["/mcp/"],
            },
          },
        ],
      },
      credentialBindings: [
        {
          ref: "github-pat",
          sourceRef: "credential-source-github",
          projection: {
            type: "http_headers",
            httpHeaders: {
              headers: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{ .token }}",
                },
              ],
            },
          },
        },
      ],
    },
  );
});

test("user traffic policy updates retain managed MCP credential rules", () => {
  const blocked = toSandbox0NetworkPolicy(
    {
      mode: "block-all",
      domainExceptions: ["api.githubcopilot.com"],
    },
    [githubCredential],
  );
  const updated = toSandbox0NetworkPolicy(
    {
      mode: "allow-all",
      domainExceptions: ["blocked.example.com"],
    },
    [githubCredential],
  );

  assert.deepEqual(updated.credentialBindings, blocked.credentialBindings);
  assert.deepEqual(
    updated.egress?.credentialRules,
    blocked.egress?.credentialRules,
  );
  assert.deepEqual(updated.egress?.trafficRules, [
    {
      name: "sandpi-environment-domain-exceptions",
      action: "deny",
      domains: ["blocked.example.com"],
    },
  ]);
});

test("removing a managed MCP credential removes only its generated policy", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy({
      mode: "block-all",
      domainExceptions: ["api.githubcopilot.com"],
    }),
    {
      mode: "block-all",
      egress: {
        trafficRules: [
          {
            name: "sandpi-environment-domain-exceptions",
            action: "allow",
            domains: ["api.githubcopilot.com"],
          },
        ],
      },
      credentialBindings: [],
    },
  );
});

test("managed MCP credential destinations reject wildcard domains and URLs", () => {
  assert.throws(
    () =>
      toSandbox0NetworkPolicy(
        { mode: "allow-all", domainExceptions: [] },
        [{ ...githubCredential, destinationDomain: "*.github.com" }],
      ),
    /exact MCP credential destination domain/,
  );
  assert.throws(
    () =>
      toSandbox0NetworkPolicy(
        { mode: "allow-all", domainExceptions: [] },
        [{ ...githubCredential, destinationPath: "/mcp?tenant=other" }],
      ),
    /destination path/,
  );
});
