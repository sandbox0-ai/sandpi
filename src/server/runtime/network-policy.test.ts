import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnvironmentEgressCredential } from "./types";
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

test("base modes submit an empty desired credential binding list", () => {
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

test("preserves Environment credentials while composing ordinary domain edits", () => {
  assert.deepEqual(
    toSandbox0NetworkPolicy(
      {
        mode: "block-all",
        domainExceptions: ["registry.npmjs.org"],
      },
      [
        {
          id: "github",
          environmentId: "env-one",
          sourceRef: "sandpi-credential-github",
          name: "GitHub API",
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
            domains: ["api.github.com"],
            ports: [{ port: 443, protocol: "tcp" }],
            failurePolicy: "fail-closed",
          },
          enabled: true,
          status: "active",
          currentVersion: 2,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ),
    {
      mode: "block-all",
      egress: {
        trafficRules: [
          {
            name: "sandpi-environment-domain-exceptions",
            action: "allow",
            domains: ["registry.npmjs.org"],
          },
          {
            name: "sandpi-credential-allow-github",
            action: "allow",
            domains: ["api.github.com"],
            ports: [{ port: 443, protocol: "tcp" }],
          },
        ],
        credentialRules: [
          {
            name: "sandpi-credential-auth-github",
            credentialRef: "sandpi-credential-github",
            rollout: "enabled",
            protocol: "https",
            tlsMode: "terminate-reoriginate",
            failurePolicy: "fail-closed",
            domains: ["api.github.com"],
            ports: [{ port: 443, protocol: "tcp" }],
          },
        ],
      },
      credentialBindings: [
        {
          ref: "sandpi-credential-github",
          sourceRef: "sandpi-credential-github",
          projection: {
            type: "http_headers",
            httpHeaders: {
              headers: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{ .secret }}",
                },
              ],
            },
          },
        },
      ],
    },
  );
});

test("maps every non-header projection to its native Sandbox0 shape", () => {
  const common = {
    environmentId: "env-one",
    rule: {
      domains: ["service.example.com"],
      ports: [{ port: 443, protocol: "tcp" as const }],
      failurePolicy: "fail-closed" as const,
    },
    enabled: true,
    status: "active" as const,
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const cases: Array<{
    credential: RuntimeEnvironmentEgressCredential;
    expectedProjection: unknown;
    expectedTlsMode?: string;
  }> = [
    {
      credential: {
        ...common,
        id: "placeholder",
        name: "Placeholder",
        sourceRef: "source-placeholder",
        resolverKind: "static_headers",
        projection: {
          type: "placeholder_substitution",
          replacements: [
            {
              placeholder: "TOKEN",
              valueTemplate: "{{ .token }}",
              locations: ["header", "query"],
            },
          ],
        },
        rule: { ...common.rule, protocol: "https" },
      },
      expectedProjection: {
        type: "placeholder_substitution",
        placeholderSubstitution: {
          replacements: [
            {
              placeholder: "TOKEN",
              valueTemplate: "{{ .token }}",
              locations: ["header", "query"],
            },
          ],
        },
      },
      expectedTlsMode: "terminate-reoriginate",
    },
    {
      credential: {
        ...common,
        id: "mtls",
        name: "mTLS",
        sourceRef: "source-mtls",
        resolverKind: "static_tls_client_certificate",
        projection: { type: "tls_client_certificate" },
        rule: { ...common.rule, protocol: "tls" },
      },
      expectedProjection: {
        type: "tls_client_certificate",
        tlsClientCertificate: {},
      },
      expectedTlsMode: "terminate-reoriginate",
    },
    {
      credential: {
        ...common,
        id: "password",
        name: "Password",
        sourceRef: "source-password",
        resolverKind: "static_username_password",
        projection: { type: "username_password" },
        rule: {
          ...common.rule,
          protocol: "redis",
          ports: [{ port: 6_379, protocol: "tcp" }],
        },
      },
      expectedProjection: {
        type: "username_password",
        usernamePassword: {},
      },
    },
    {
      credential: {
        ...common,
        id: "ssh",
        name: "SSH",
        sourceRef: "source-ssh",
        resolverKind: "static_ssh_private_key",
        projection: {
          type: "ssh_proxy",
          upstreamUsername: "git",
          sandboxPublicKeys: ["ssh-ed25519 sandbox"],
          knownHosts: ["git.example.com ssh-ed25519 host"],
        },
        rule: {
          ...common.rule,
          protocol: "ssh",
          ports: [{ port: 22, protocol: "tcp" }],
        },
      },
      expectedProjection: {
        type: "ssh_proxy",
        sshProxy: {
          upstreamUsername: "git",
          sandboxPublicKeys: ["ssh-ed25519 sandbox"],
          knownHosts: ["git.example.com ssh-ed25519 host"],
        },
      },
    },
  ];

  for (const credentialCase of cases) {
    const policy = toSandbox0NetworkPolicy(
      { mode: "allow-all", domainExceptions: [] },
      [credentialCase.credential],
    );
    assert.deepEqual(
      policy.credentialBindings?.[0]?.projection,
      credentialCase.expectedProjection,
    );
    assert.equal(
      policy.egress?.credentialRules?.[0]?.protocol,
      credentialCase.credential.rule.protocol,
    );
    assert.equal(
      policy.egress?.credentialRules?.[0]?.tlsMode,
      credentialCase.expectedTlsMode,
    );
  }
});

test("disabled and source-less credentials are not attached to a Sandbox", () => {
  const common = {
    environmentId: "env-one",
    name: "API",
    resolverKind: "static_headers" as const,
    projection: {
      type: "http_headers" as const,
      headers: [{ name: "Authorization", valueTemplate: "{{ .secret }}" }],
    },
    rule: {
      protocol: "https" as const,
      domains: ["api.example.com"],
      ports: [{ port: 443, protocol: "tcp" as const }],
      failurePolicy: "fail-closed" as const,
    },
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  assert.deepEqual(
    toSandbox0NetworkPolicy(
      { mode: "allow-all", domainExceptions: [] },
      [
        {
          ...common,
          id: "disabled",
          sourceRef: "source-disabled",
          enabled: false,
          currentVersion: 1,
        },
        {
          ...common,
          id: "missing",
          sourceRef: "source-missing",
          enabled: true,
        },
      ],
    ),
    { mode: "allow-all", credentialBindings: [] },
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
