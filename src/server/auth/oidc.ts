import { randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
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

export class OidcIdentityService {
  private configuration?: Promise<oidc.Configuration>;

  constructor(
    private readonly pool: Pool,
    private readonly config: Extract<SandpiConfig["auth"], { mode: "oidc" }>,
    private readonly publicUrl: URL,
    private readonly secrets: SecretBox,
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
      if (!claims?.sub || typeof claims.email !== "string") {
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
      const principal = await upsertOidcUser(client, {
        issuer: this.config.issuer.toString(),
        subject: claims.sub,
        email: claims.email,
        name: typeof claims.name === "string" ? claims.name : claims.email,
      });
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

  async logout(token: string) {
    await this.pool.query(
      "UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1",
      [secretHash(token)],
    );
  }

  private getConfiguration() {
    this.configuration ??= oidc.discovery(
      this.config.issuer,
      this.config.clientId,
      this.config.clientSecret,
    );
    return this.configuration;
  }
}

async function upsertOidcUser(
  client: PoolClient,
  identity: { issuer: string; subject: string; email: string; name: string },
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
    await createPersonalTeam(client, userId, identity.email, identity.name);
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

async function createPersonalTeam(
  client: PoolClient,
  userId: string,
  email: string,
  name: string,
) {
  const teamId = `team_${randomUUID()}`;
  const now = new Date();
  const monthEnd = new Date(now);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const planQuotas = {
    weeklyExecution: {
      used: 0,
      limit: 600,
      unit: "minute",
      window: "weekly",
      resetsAt: weekEnd.toISOString(),
    },
    concurrentSessions: { used: 0, limit: 1, unit: "session" },
    snapshotStorage: { used: 0, limit: 5, unit: "gibibyte" },
  };
  await client.query(
    `
      INSERT INTO teams (
        id, name, slug, color, billing_account_id, billing_status,
        billing_email, billing_period_starts_at, billing_period_ends_at,
        plan_id, plan_status, plan_quotas
      ) VALUES (
        $1, $2, $3, '#315c4b', $4, 'deployment-managed', $5, $6, $7,
        'free', 'active', $8::JSONB
      )
    `,
    [
      teamId,
      `${name}'s Team`,
      `team-${teamId.slice(-12)}`,
      `billing-${teamId}`,
      email,
      now,
      monthEnd,
      JSON.stringify(planQuotas),
    ],
  );
  await client.query(
    `
      INSERT INTO team_memberships (
        id, team_id, user_id, role, status
      ) VALUES ($1, $2, $3, 'owner', 'active')
    `,
    [
      `membership_${randomUUID()}`,
      teamId,
      userId,
    ],
  );
  await client.query(
    `
      INSERT INTO environments (
        id, team_id, created_by_user_id, name, description, color, status,
        revision, template_id, harness, harness_metadata, network_policy
      ) VALUES (
        $1, $2, $3, 'Development', '', '#315c4b', 'updating', 1,
        'coding-agent', 'codex',
        '{"label":"Codex","status":"not-connected"}'::JSONB,
        '{"mode":"allow-all","domainExceptions":[]}'::JSONB
      )
    `,
    [`env_${randomUUID()}`, teamId, userId],
  );
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
