import assert from "node:assert/strict";
import test from "node:test";

import type { EnvironmentEgressCredential } from "./environment-credentials";
import {
  emptyEnvironmentCredentialForm,
  environmentCredentialCreateInput,
  environmentCredentialFormForProjection,
  environmentCredentialRotationForm,
  environmentCredentialRotationMaterial,
} from "./environment-credential-form";

test("builds the simple HTTP header form into a write-only source request", () => {
  const form = {
    ...emptyEnvironmentCredentialForm(),
    name: "GitHub API",
    domains: "api.github.com\napi.github.com",
    ports: "443",
    sourceValues: { value: "github-secret" },
  };

  assert.deepEqual(environmentCredentialCreateInput(form), {
    name: "GitHub API",
    resolverKind: "static_headers",
    projection: {
      type: "http_headers",
      headers: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{ .value }}",
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
    material: {
      type: "static_headers",
      values: { value: "github-secret" },
    },
  });
});

test("changes credential type with compatible protocol and port defaults", () => {
  const initial = {
    ...emptyEnvironmentCredentialForm(),
    name: "Service",
    domains: "service.example.com",
  };

  assert.deepEqual(
    environmentCredentialFormForProjection(initial, "username_password"),
    {
      ...emptyEnvironmentCredentialForm("username_password"),
      name: "Service",
      domains: "service.example.com",
    },
  );
  assert.equal(
    environmentCredentialFormForProjection(initial, "ssh_proxy").protocol,
    "ssh",
  );
  assert.equal(
    environmentCredentialFormForProjection(initial, "ssh_proxy").ports,
    "22",
  );
});

test("asks for every projected static value when replacing a secret", () => {
  const credential: EnvironmentEgressCredential = {
    id: "credential-header",
    environmentId: "env-one",
    name: "Headers",
    resolverKind: "static_headers",
    projection: {
      type: "http_headers",
      headers: [
        { name: "Authorization", valueTemplate: "Bearer {{ .token }}" },
        { name: "X-Account", valueTemplate: "{{ .account }}" },
      ],
    },
    rule: {
      protocol: "https",
      domains: ["api.example.com"],
      ports: [{ port: 443, protocol: "tcp" }],
      failurePolicy: "fail-closed",
    },
    enabled: true,
    status: "active",
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const rotation = environmentCredentialRotationForm(credential);

  assert.deepEqual(rotation.sourceValues, { token: "", account: "" });
  assert.deepEqual(
    environmentCredentialRotationMaterial(credential, {
      ...rotation,
      sourceValues: { token: "next-token", account: "next-account" },
    }),
    {
      type: "static_headers",
      values: { token: "next-token", account: "next-account" },
    },
  );
});

test("rejects malformed ports before sending a credential request", () => {
  assert.throws(
    () =>
      environmentCredentialCreateInput({
        ...emptyEnvironmentCredentialForm(),
        name: "Bad port",
        domains: "api.example.com",
        ports: "443oops",
        sourceValues: { value: "secret" },
      }),
    /TCP ports must be whole numbers/,
  );
});
