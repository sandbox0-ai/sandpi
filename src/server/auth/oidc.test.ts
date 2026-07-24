import assert from "node:assert/strict";
import test from "node:test";

import { oidcClientAuthentication } from "./oidc";

const authorizationServer = {
  issuer: "https://identity.example.com/",
};

test("sends client_secret_post credentials in the token request body", () => {
  const body = new URLSearchParams();
  const headers = new Headers();

  oidcClientAuthentication({
    tokenEndpointAuthMethod: "client_secret_post",
    clientSecret: "secret",
  })(
    authorizationServer,
    { client_id: "sandpi" },
    body,
    headers,
  );

  assert.equal(body.get("client_id"), "sandpi");
  assert.equal(body.get("client_secret"), "secret");
  assert.equal(headers.get("authorization"), null);
});

test("sends client_secret_basic credentials in the authorization header", () => {
  const body = new URLSearchParams();
  const headers = new Headers();

  oidcClientAuthentication({
    tokenEndpointAuthMethod: "client_secret_basic",
    clientSecret: "secret",
  })(
    authorizationServer,
    { client_id: "sandpi" },
    body,
    headers,
  );

  assert.equal(
    headers.get("authorization"),
    `Basic ${Buffer.from("sandpi:secret").toString("base64")}`,
  );
  assert.equal(body.get("client_secret"), null);
});

test("sends only the client id for a public OIDC client", () => {
  const body = new URLSearchParams();
  const headers = new Headers();

  oidcClientAuthentication({
    tokenEndpointAuthMethod: "none",
  })(
    authorizationServer,
    { client_id: "sandpi" },
    body,
    headers,
  );

  assert.equal(body.get("client_id"), "sandpi");
  assert.equal(body.get("client_secret"), null);
  assert.equal(headers.get("authorization"), null);
});
