import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { migrateDatabase } from "@/server/db/migrate";
import { seedCommunityDefaults } from "@/server/db/seed";
import { SecretBox } from "@/server/secrets";
import { NativeAuthService } from "./native";
import { OidcIdentityService } from "./oidc";

test(
  "native auth consumes one PKCE handoff without storing its verifier",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const auth = new NativeAuthService(
      database,
      new URL("https://sandpi.example"),
      false,
    );
    const verifier = "v".repeat(43);
    const attempt = await auth.startAttempt(
      "https://sandpi.example/?new=1",
      verifier,
      "s".repeat(43),
    );
    await auth.assertAttemptStartable(attempt.id);
    const callback = await auth.authorizeAttempt(attempt.id, "user-admin");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    await assert.rejects(
      auth.completeAttempt(attempt.id, code, "x".repeat(43)),
      /invalid or expired/,
    );
    const completion = await auth.completeAttempt(
      attempt.id,
      code,
      verifier,
    );
    assert.equal(completion.returnTo, "/?new=1");
    assert.equal(completion.session, undefined);
    await assert.rejects(
      auth.completeAttempt(attempt.id, code, verifier),
      /invalid or expired/,
    );

    const stored = await database.query(
      `
        SELECT code_challenge, code_hash
        FROM native_auth_attempts
        WHERE id = $1
      `,
      [attempt.id],
    );
    assert.notEqual(stored.rows[0].code_challenge, verifier);
    assert.ok(Buffer.isBuffer(stored.rows[0].code_hash));

    await database.query(
      `
        INSERT INTO users (
          id, email, name, avatar_initials, identity_provider, identity_subject
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        "user-native-oidc",
        "native@example.com",
        "Native User",
        "NU",
        "https://identity.example",
        "native-subject",
      ],
    );
    const oidcAuth = new NativeAuthService(
      database,
      new URL("https://sandpi.example"),
      true,
    );
    const oidcAttempt = await oidcAuth.startAttempt(
      "/sessions/native",
      verifier,
      "o".repeat(43),
    );
    const oidcCallback = await oidcAuth.authorizeAttempt(
      oidcAttempt.id,
      "user-native-oidc",
    );
    const oidcCode = oidcCallback.searchParams.get("code");
    assert.ok(oidcCode);
    const oidcCompletion = await oidcAuth.completeAttempt(
      oidcAttempt.id,
      oidcCode,
      verifier,
    );
    assert.equal(oidcCompletion.returnTo, "/sessions/native");
    assert.equal(
      oidcCompletion.session?.principal.userId,
      "user-native-oidc",
    );
    assert.match(oidcCompletion.session?.token ?? "", /^[A-Za-z0-9_-]+$/);
    const session = await database.query(
      `
        SELECT user_id, revoked_at, expires_at
        FROM auth_sessions
        WHERE user_id = $1
      `,
      ["user-native-oidc"],
    );
    assert.equal(session.rows.length, 1);
    assert.equal(session.rows[0].revoked_at, null);
    assert.ok(session.rows[0].expires_at > new Date());
  },
);

test(
  "OIDC device login exchanges UserInfo for a Sandpi session without retaining the provider token",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const seenTokens: string[] = [];
    const auth = new OidcIdentityService(
      database,
      {
        mode: "oidc",
        cookieSecret: "cookie-secret-with-at-least-32-characters",
        issuer: new URL("https://identity.example/"),
        clientId: "sandpi-web",
        clientSecret: "web-secret",
        deviceClientId: "sandpi-cli",
        tokenEndpointAuthMethod: "client_secret_post",
        scopes: "openid profile email",
      },
      new URL("https://sandpi.example"),
      new SecretBox("deployment-secret-with-at-least-32-characters"),
      async (accessToken, idToken) => {
        seenTokens.push(accessToken);
        assert.equal(idToken, "provider-id-token");
        return {
          sub: "device-user",
          email: "device@example.com",
          email_verified: true,
          name: "Device User",
        };
      },
    );

    const session = await auth.completeDeviceLogin(
      "provider-access-token",
      "provider-id-token",
    );
    assert.deepEqual(seenTokens, ["provider-access-token"]);
    assert.equal(session.principal.email, "device@example.com");
    assert.equal(session.principal.name, "Device User");
    assert.match(session.token, /^[A-Za-z0-9_-]+$/);

    const stored = await database.query(
      `
        SELECT u.identity_provider, u.identity_subject,
               COUNT(DISTINCT e.id)::INTEGER AS environments,
               COUNT(DISTINCT s.id)::INTEGER AS sessions
        FROM users u
        LEFT JOIN environments e ON e.created_by_user_id = u.id
        LEFT JOIN auth_sessions s ON s.user_id = u.id
        WHERE u.id = $1
        GROUP BY u.identity_provider, u.identity_subject
      `,
      [session.principal.userId],
    );
    assert.equal(stored.rows[0].identity_provider, "https://identity.example/");
    assert.equal(stored.rows[0].identity_subject, "device-user");
    assert.equal(stored.rows[0].environments, 1);
    assert.equal(stored.rows[0].sessions, 1);
  },
);

async function isolatedDatabase(context: test.TestContext) {
  const schema = `sandpi_native_auth_test_${randomUUID().replaceAll("-", "")}`;
  const administration = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: "sandpi-native-auth-test-administration",
    max: 1,
  });
  await administration.query(`CREATE SCHEMA "${schema}"`);
  const database = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: "sandpi-native-auth-test",
    options: `-c search_path=${schema}`,
    max: 4,
  });
  context.after(async () => {
    await database.end();
    await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
    await administration.end();
  });
  await migrateDatabase(database);
  await seedCommunityDefaults(database);
  return database;
}
