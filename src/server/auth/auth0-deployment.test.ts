import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Auth0DeployConfig {
  AUTH0_ALLOW_DELETE: boolean;
  AUTH0_EXPORT_IDENTIFIERS: boolean;
  AUTH0_INCLUDED_ONLY: string[];
}

interface Auth0Client {
  name: string;
  app_type: string;
  callbacks?: string[];
  grant_types: string[];
  is_first_party: boolean;
  oidc_conformant: boolean;
  token_endpoint_auth_method: string;
  jwt_configuration: { alg: string };
  client_id?: string;
  client_secret?: string;
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8"),
  ) as T;
}

test("Auth0 deployment manages only clients and cannot delete resources", async () => {
  const config = await readJson<Auth0DeployConfig>(
    "../../../auth0/config.json",
  );

  assert.equal(config.AUTH0_ALLOW_DELETE, false);
  assert.equal(config.AUTH0_EXPORT_IDENTIFIERS, false);
  assert.deepEqual(config.AUTH0_INCLUDED_ONLY, ["clients"]);
});

test("Auth0 application matches Sandpi's standard OIDC contract", async () => {
  const client = await readJson<Auth0Client>(
    "../../../auth0/tenant/clients/SandPi%20Cloud.json",
  );

  assert.equal(client.name, "SandPi Cloud");
  assert.equal(client.app_type, "regular_web");
  assert.deepEqual(client.grant_types, ["authorization_code"]);
  assert.equal(client.is_first_party, true);
  assert.equal(client.oidc_conformant, true);
  assert.equal(client.token_endpoint_auth_method, "client_secret_post");
  assert.equal(client.jwt_configuration.alg, "RS256");
  assert.equal(client.client_id, undefined);
  assert.equal(client.client_secret, undefined);

  assert.deepEqual(client.callbacks, [
    "##SANDPI_PUBLIC_URL##/api/v1/auth/callback",
  ]);
  assert.equal(JSON.stringify(client).includes("*"), false);
});

test("Auth0 CLI application is a secretless Device Authorization client", async () => {
  const client = await readJson<Auth0Client>(
    "../../../auth0/tenant/clients/Sandpi%20CLI.json",
  );

  assert.equal(client.name, "Sandpi CLI");
  assert.equal(client.app_type, "native");
  assert.deepEqual(client.grant_types, [
    "urn:ietf:params:oauth:grant-type:device_code",
  ]);
  assert.equal(client.is_first_party, true);
  assert.equal(client.oidc_conformant, true);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.equal(client.jwt_configuration.alg, "RS256");
  assert.equal(client.callbacks, undefined);
  assert.equal(client.client_id, undefined);
  assert.equal(client.client_secret, undefined);
});
