import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";

import { oidcClientAuthentication, verifyOidcIDToken } from "./oidc";

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

test("verifies device ID token signature, issuer, audience, subject, and authorized party", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "device-signing-key";
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  const issuer = "https://identity.example.com/";
  const audience = "sandpi-cli";
  const sign = (claims: Record<string, unknown>, tokenAudience: string | string[]) =>
    new SignJWT({ sub: "device-user", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
      .setIssuer(issuer)
      .setAudience(tokenAudience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const valid = await sign({}, audience);
  assert.equal(
    await verifyOidcIDToken(valid, jwks, issuer, audience),
    "device-user",
  );

  await assert.rejects(
    verifyOidcIDToken(
      await sign({}, "another-client"),
      jwks,
      issuer,
      audience,
    ),
  );
  await assert.rejects(
    verifyOidcIDToken(
      await sign({ azp: "another-client" }, [audience, "another-audience"]),
      jwks,
      issuer,
      audience,
    ),
    /authorized party/,
  );
});
