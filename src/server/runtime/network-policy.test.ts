import assert from "node:assert/strict";
import test from "node:test";

import {
  toSandbox0NetworkPolicy,
  type ManagedMcpCredentialBinding,
  type ManagedMcpToolPolicy,
} from "./network-policy";

const githubCredential: ManagedMcpCredentialBinding = {
  bindingRef: "github-pat",
  sourceRef: "credential-source-github",
  destinationDomain: "api.githubcopilot.com",
  destinationPath: "/mcp/",
  credentialHeaderName: "Authorization",
  credentialValueTemplate: "Bearer {{ .token }}",
};

const githubTools: ManagedMcpToolPolicy = {
  serverName: "github",
  destinationDomain: "api.githubcopilot.com",
  destinationPath: "/mcp/",
  mode: "selected",
  allowedTools: ["get_issue", "search_code"],
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

test("selected MCP tools become an exact Sandbox0 protocol allowlist", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy(
      { mode: "allow-all", domainExceptions: [] },
      [],
      [githubTools],
    ),
    {
      mode: "allow-all",
      egress: {
        protocolRules: [
          {
            name: "sandpi-mcp-tools-666453d5d025",
            protocol: "mcp",
            domains: ["api.githubcopilot.com"],
            ports: [{ port: 443, protocol: "tcp" }],
            tlsMode: "terminate-reoriginate",
            httpMatch: { paths: ["/mcp/"] },
            mcp: {
              tools: { allowed: ["get_issue", "search_code"] },
            },
          },
        ],
      },
      credentialBindings: [],
    },
  );
});

test("all-tools and delegated MCP policies do not create protocol rules", () => {
  for (const mode of ["all", "delegated"] as const) {
    assert.deepEqual(
      toSandbox0NetworkPolicy(
        { mode: "allow-all", domainExceptions: [] },
        [],
        [{ ...githubTools, mode, allowedTools: [] }],
      ),
      { mode: "allow-all", credentialBindings: [] },
    );
  }
  assert.deepEqual(
    toSandbox0NetworkPolicy(
      { mode: "allow-all", domainExceptions: [] },
      [],
      [
        { ...githubTools, mode: "all", allowedTools: [] },
        {
          ...githubTools,
          serverName: "aggregator",
          mode: "delegated",
          allowedTools: [],
        },
      ],
    ),
    { mode: "allow-all", credentialBindings: [] },
  );
});

test("one endpoint cannot silently receive conflicting MCP tool policies", () => {
  assert.throws(
    () =>
      toSandbox0NetworkPolicy(
        { mode: "allow-all", domainExceptions: [] },
        [],
        [
          githubTools,
          {
            ...githubTools,
            serverName: "github-secondary",
            allowedTools: ["get_issue"],
          },
        ],
      ),
    /share .* but request different tool policies/,
  );
  assert.throws(
    () =>
      toSandbox0NetworkPolicy(
        { mode: "allow-all", domainExceptions: [] },
        [],
        [
          githubTools,
          {
            ...githubTools,
            serverName: "aggregator",
            mode: "delegated",
            allowedTools: [],
          },
        ],
      ),
    /one security boundary/,
  );
});

test("an empty selected MCP tool policy fails closed at composition", () => {
  assert.throws(
    () =>
      toSandbox0NetworkPolicy(
        { mode: "allow-all", domainExceptions: [] },
        [],
        [{ ...githubTools, allowedTools: [] }],
      ),
    /must allow at least one tool/,
  );
});
