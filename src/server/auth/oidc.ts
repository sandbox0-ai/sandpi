import { randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import * as oidc from "openid-client";

import type { SandpiConfig } from "@/server/config";
import { HttpError } from "@/server/http-error";
import type { Principal } from "./principal";
import { SecretBox, secretHash } from "@/server/secrets";

const OIDC_STATE_TTL_MS = 10 * 60 * 1_000;
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface OidcLoginResult {
  authorizationUrl: URL;
}

export interface WebSessionResult {
  token: string;
  expiresAt: Date;
  principal: Principal;
}

type DeviceUserInfo = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

export class OidcIdentityService {
  private configuration?: Promise<oidc.Configuration>;
  private deviceConfiguration?: Promise<oidc.Configuration>;
  private deviceJwks?: JWTVerifyGetKey;

  constructor(
    private readonly pool: Pool,
    private readonly config: Extract<SandpiConfig["auth"], { mode: "oidc" }>,
    private readonly publicUrl: URL,
    private readonly secrets: SecretBox,
    private readonly fetchDeviceUserInfo?: (
      accessToken: string,
      idToken: string,
    ) => Promise<DeviceUserInfo>,
  ) {}

  async startLogin(returnTo: string): Promise<OidcLoginResult> {
    const configuration = await this.getConfiguration();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const stateId = `oidc_${randomUUID()}`;
    const redirectUri = new URL("/api/v1/auth/callback", this.publicUrl).toString();
    const encrypted = this.secrets.encrypt(
      JSON.stringify({ verifier, nonce }),
      stateId,
    );
    await this.pool.query(
      `
        INSERT INTO oidc_states (
          id, provider, state_hash, nonce_hash,
          code_verifier_ciphertext, code_verifier_initialization_vector,
          code_verifier_authentication_tag, encryption_algorithm,
          encryption_key_id, redirect_uri, return_to, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        )
      `,
      [
        stateId,
        this.config.issuer.toString(),
        secretHash(state),
        secretHash(nonce),
        encrypted.ciphertext,
        encrypted.initializationVector,
        encrypted.authenticationTag,
        encrypted.algorithm,
        encrypted.keyId,
        redirectUri,
        safeReturnTo(returnTo, this.publicUrl),
        new Date(Date.now() + OIDC_STATE_TTL_MS),
      ],
    );

    return {
      authorizationUrl: oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: this.config.scopes,
        response_type: "code",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    };
  }

  async completeLogin(callbackUrl: URL): Promise<WebSessionResult & { returnTo: string }> {
    const state = callbackUrl.searchParams.get("state");
    if (!state) throw new HttpError(400, "oidc_state_missing", "OIDC state is missing.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const stateResult = await client.query(
        `
          SELECT * FROM oidc_states
          WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
          FOR UPDATE
        `,
        [secretHash(state)],
      );
      const stored = stateResult.rows[0];
      if (!stored) {
        throw new HttpError(400, "oidc_state_invalid", "OIDC state is invalid or expired.");
      }
      await client.query(
        "UPDATE oidc_states SET consumed_at = NOW() WHERE id = $1",
        [stored.id],
      );
      const decrypted = JSON.parse(
        this.secrets.decrypt(
          {
            ciphertext: stored.code_verifier_ciphertext,
            initializationVector: stored.code_verifier_initialization_vector,
            authenticationTag: stored.code_verifier_authentication_tag,
            algorithm: stored.encryption_algorithm,
            keyId: stored.encryption_key_id,
          },
          stored.id,
        ),
      ) as { verifier: string; nonce: string };
      if (!secretHash(decrypted.nonce).equals(stored.nonce_hash)) {
        throw new HttpError(400, "oidc_nonce_invalid", "OIDC nonce is invalid.");
      }

      const configuration = await this.getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: decrypted.verifier,
        expectedState: state,
        expectedNonce: decrypted.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const identity = identityFromClaims(claims ?? {});
      const principal = await upsertOidcUser(
        client,
        {
          issuer: this.config.issuer.toString(),
          ...identity,
        },
        this.config.allowNewUsers,
      );
      const session = await createWebSession(client, principal);
      await client.query("COMMIT");
      return { ...session, returnTo: stored.return_to };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticate(token: string): Promise<Principal | undefined> {
    const result = await this.pool.query(
      `
        SELECT u.id, u.email, u.name, u.identity_provider, u.identity_subject
        FROM auth_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL
          AND s.expires_at > NOW() AND u.status = 'active'
      `,
      [secretHash(token)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      userId: row.id,
      email: row.email,
      name: row.name,
      subject: `${row.identity_provider}:${row.identity_subject}`,
      kind: "oidc-session",
    };
  }

  /** Exchanges provider-issued device tokens for a Sandpi session. */
  async completeDeviceLogin(
    accessToken: string,
    idToken: string,
  ): Promise<WebSessionResult> {
    if (!this.config.deviceClientId) {
      throw new HttpError(
        503,
        "oidc_device_auth_unavailable",
        "OIDC device authorization is not configured.",
      );
    }
    let claims: DeviceUserInfo;
    try {
      claims = this.fetchDeviceUserInfo
        ? await this.fetchDeviceUserInfo(accessToken, idToken)
        : await oidc.fetchUserInfo(
            await this.getDeviceConfiguration(),
            accessToken,
            await this.verifyDeviceIDToken(idToken),
          );
    } catch {
      throw new HttpError(
        401,
        "oidc_device_token_invalid",
        "The OIDC device tokens are invalid or expired.",
      );
    }
    const identity = identityFromClaims(claims);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const principal = await upsertOidcUser(
        client,
        {
          issuer: this.config.issuer.toString(),
          ...identity,
        },
        this.config.allowNewUsers,
      );
      const session = await createWebSession(client, principal);
      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(token: string) {
    await this.pool.query(
      "UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1",
      [secretHash(token)],
    );
  }

  private getConfiguration() {
    const clientAuthentication = oidcClientAuthentication(this.config);
    this.configuration ??= oidc.discovery(
      this.config.issuer,
      this.config.clientId,
      {
        client_secret: this.config.clientSecret,
        token_endpoint_auth_method: this.config.tokenEndpointAuthMethod,
      },
      clientAuthentication,
    );
    return this.configuration;
  }

  private getDeviceConfiguration() {
    this.deviceConfiguration ??= oidc.discovery(
      this.config.issuer,
      this.config.deviceClientId!,
      { token_endpoint_auth_method: "none" },
      oidc.None(),
    );
    return this.deviceConfiguration;
  }

  private async verifyDeviceIDToken(idToken: string) {
    const configuration = await this.getDeviceConfiguration();
    const jwksUri = configuration.serverMetadata().jwks_uri;
    if (!jwksUri) {
      throw new Error("OIDC discovery did not return a JWKS endpoint.");
    }
    this.deviceJwks ??= createRemoteJWKSet(new URL(jwksUri));
    return verifyOidcIDToken(
      idToken,
      this.deviceJwks,
      this.config.issuer.toString(),
      this.config.deviceClientId!,
    );
  }
}

/** Validates that a device ID token belongs to the configured public client. */
export async function verifyOidcIDToken(
  idToken: string,
  jwks: JWTVerifyGetKey,
  issuer: string,
  audience: string,
) {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience,
    algorithms: ["RS256"],
  });
  if (typeof payload.sub !== "string") {
    throw new Error("OIDC ID token did not return a subject.");
  }
  const multipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
  if ((payload.azp !== undefined || multipleAudiences) && payload.azp !== audience) {
    throw new Error("OIDC ID token authorized party does not match the client.");
  }
  return payload.sub;
}

function identityFromClaims(claims: {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}) {
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new HttpError(
      400,
      "oidc_claims_invalid",
      "OIDC must return sub and email claims.",
    );
  }
  if (claims.email_verified !== true) {
    throw new HttpError(
      403,
      "oidc_email_unverified",
      "OIDC email must be verified.",
    );
  }
  return {
    subject: claims.sub,
    email: claims.email,
    name: typeof claims.name === "string" ? claims.name : claims.email,
  };
}

export function oidcClientAuthentication(
  config: Pick<
    Extract<SandpiConfig["auth"], { mode: "oidc" }>,
    "clientSecret" | "tokenEndpointAuthMethod"
  >,
): oidc.ClientAuth {
  switch (config.tokenEndpointAuthMethod) {
    case "client_secret_post":
      return oidc.ClientSecretPost(config.clientSecret);
    case "client_secret_basic":
      return oidc.ClientSecretBasic(config.clientSecret);
    case "none":
      return oidc.None();
  }
}

/** Resolve an OIDC identity without admitting new users when registration is closed. */
export async function upsertOidcUser(
  client: PoolClient,
  identity: { issuer: string; subject: string; email: string; name: string },
  allowNewUsers: boolean,
): Promise<Principal> {
  const existing = await client.query(
    `SELECT * FROM users WHERE identity_provider = $1 AND identity_subject = $2`,
    [identity.issuer, identity.subject],
  );
  let userId = existing.rows[0]?.id as string | undefined;
  if (userId) {
    await client.query(
      "UPDATE users SET email = $2, name = $3 WHERE id = $1",
      [userId, identity.email, identity.name],
    );
  } else {
    if (!allowNewUsers) {
      throw new HttpError(
        403,
        "registration_closed",
        "Sandpi is currently in private beta. New user registration is temporarily closed.",
      );
    }
    userId = `user_${randomUUID()}`;
    const initials = identity.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "U";
    await client.query(
      `
        INSERT INTO users (
          id, email, name, avatar_initials, identity_provider, identity_subject
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [userId, identity.email, identity.name, initials, identity.issuer, identity.subject],
    );
    await createPersonalEnvironment(client, userId);
    await client.query("INSERT INTO user_preferences (user_id) VALUES ($1)", [userId]);
  }
  return {
    userId,
    email: identity.email,
    name: identity.name,
    subject: `${identity.issuer}:${identity.subject}`,
    kind: "oidc-session",
  };
}

async function createPersonalEnvironment(client: PoolClient, userId: string) {
  await client.query(
    `
      INSERT INTO environments (
        id, created_by_user_id, name, description, color, status,
        revision, template_id, harness, harness_metadata, network_policy,
        display_order
      ) VALUES (
        $1, $2, 'Development', '', '#315c4b', 'updating', 1,
        'coding-agent', 'codex',
        '{"label":"Codex","status":"not-connected"}'::JSONB,
        '{"mode":"allow-all","domainExceptions":[]}'::JSONB, 0
      )
    `,
    [`env_${randomUUID()}`, userId],
  );
}

export async function createWebSessionForUser(
  client: PoolClient,
  userId: string,
): Promise<WebSessionResult> {
  const result = await client.query(
    `
      SELECT id, email, name, identity_provider, identity_subject
      FROM users
      WHERE id = $1 AND status = 'active'
    `,
    [userId],
  );
  const user = result.rows[0];
  if (!user || user.identity_provider === "builtin") {
    throw new HttpError(
      400,
      "native_auth_user_invalid",
      "Native authentication user is unavailable.",
    );
  }
  return createWebSession(client, {
    userId: user.id,
    email: user.email,
    name: user.name,
    subject: `${user.identity_provider}:${user.identity_subject}`,
    kind: "oidc-session",
  });
}

async function createWebSession(
  client: PoolClient,
  principal: Principal,
): Promise<WebSessionResult> {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WEB_SESSION_TTL_MS);
  await client.query(
    `
      INSERT INTO auth_sessions (
        id, user_id, authentication_method, token_hash, csrf_token_hash,
        expires_at
      ) VALUES ($1, $2, 'oidc', $3, $4, $5)
    `,
    [
      `auth_${randomUUID()}`,
      principal.userId,
      secretHash(token),
      secretHash(csrf),
      expiresAt,
    ],
  );
  return { token, expiresAt, principal };
}

function safeReturnTo(value: string, publicUrl: URL) {
  try {
    const candidate = new URL(value || "/", publicUrl);
    if (candidate.origin === publicUrl.origin) {
      return `${candidate.pathname}${candidate.search}${candidate.hash}`;
    }
  } catch {
    // Fall through to the workspace root.
  }
  return "/";
}
