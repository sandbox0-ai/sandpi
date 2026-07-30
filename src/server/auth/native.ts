import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  createWebSessionForUser,
  type WebSessionResult,
} from "@/server/auth/oidc";
import { HttpError } from "@/server/http-error";
import { secretHash } from "@/server/secrets";

const NATIVE_AUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const NATIVE_AUTH_CALLBACK = "sandpi://auth/callback";
const ATTEMPT_ID_PATTERN =
  /^native_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface NativeAuthAttemptRow {
  user_id: string | null;
  client_state: string;
  code_challenge: string;
  return_to: string;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface NativeAuthCompletion {
  returnTo: string;
  session?: WebSessionResult;
}

/**
 * Coordinates a short-lived PKCE handoff from the system browser back to a
 * native WebView without sharing either browser's cookie jar.
 */
export class NativeAuthService {
  constructor(
    private readonly pool: Pool,
    private readonly publicUrl: URL,
    private readonly oidcEnabled: boolean,
  ) {}

  async startAttempt(
    returnTo: string,
    verifier: string,
    clientState: string,
  ) {
    validateVerifier(verifier);
    validateClientState(clientState);
    const codeChallenge = createHash("sha256")
      .update(verifier, "utf8")
      .digest("base64url");
    const id = `native_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + NATIVE_AUTH_ATTEMPT_TTL_MS);
    await this.pool.query(
      `
        INSERT INTO native_auth_attempts (
          id, client_state, code_challenge, return_to, expires_at
        ) VALUES ($1, $2, $3, $4, $5)
      `,
      [
        id,
        clientState,
        codeChallenge,
        safeNativeReturnTo(returnTo, this.publicUrl),
        expiresAt,
      ],
    );
    return { id, expiresAt };
  }

  async assertAttemptStartable(attemptId: string) {
    validateAttemptId(attemptId);
    const result = await this.pool.query(
      `
        SELECT 1
        FROM native_auth_attempts
        WHERE id = $1
          AND user_id IS NULL
          AND expires_at > NOW()
          AND consumed_at IS NULL
      `,
      [attemptId],
    );
    if (!result.rowCount) {
      throw invalidNativeAttempt();
    }
  }

  async authorizeAttempt(attemptId: string, userId: string) {
    validateAttemptId(attemptId);
    const code = randomBytes(32).toString("base64url");
    const result = await this.pool.query<{ client_state: string }>(
      `
        UPDATE native_auth_attempts
        SET user_id = $2, code_hash = $3, completed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND expires_at > NOW()
          AND consumed_at IS NULL
          AND (user_id IS NULL OR user_id = $2)
        RETURNING client_state
      `,
      [attemptId, userId, secretHash(code)],
    );
    const attempt = result.rows[0];
    if (!attempt) {
      throw invalidNativeAttempt();
    }
    return nativeAuthCallbackUrl(attemptId, code, attempt.client_state);
  }

  async completeAttempt(
    attemptId: string,
    code: string,
    verifier: string,
  ): Promise<NativeAuthCompletion> {
    validateAttemptId(attemptId);
    validateHandoffCode(code);
    validateVerifier(verifier);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<NativeAuthAttemptRow>(
        `
          SELECT user_id, client_state, code_challenge, return_to,
                 expires_at, consumed_at
          FROM native_auth_attempts
          WHERE id = $1 AND code_hash = $2
          FOR UPDATE
        `,
        [attemptId, secretHash(code)],
      );
      const attempt = result.rows[0];
      if (
        !attempt ||
        !attempt.user_id ||
        attempt.consumed_at ||
        attempt.expires_at.getTime() <= Date.now() ||
        !matchesCodeChallenge(verifier, attempt.code_challenge)
      ) {
        throw invalidNativeAttempt();
      }

      const session = this.oidcEnabled
        ? await createWebSessionForUser(client, attempt.user_id)
        : undefined;
      await client.query(
        `
          UPDATE native_auth_attempts
          SET consumed_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `,
        [attemptId],
      );
      await client.query("COMMIT");
      return { returnTo: attempt.return_to, session };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function nativeAuthCallbackUrl(
  attemptId: string,
  code: string,
  clientState: string,
) {
  const callback = new URL(NATIVE_AUTH_CALLBACK);
  callback.searchParams.set("attempt_id", attemptId);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", clientState);
  return callback;
}

export function safeNativeReturnTo(value: string, publicUrl: URL) {
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

export function matchesCodeChallenge(
  verifier: string,
  expectedChallenge: string,
) {
  const actual = createHash("sha256")
    .update(verifier, "utf8")
    .digest("base64url");
  const actualBytes = Buffer.from(actual, "ascii");
  const expectedBytes = Buffer.from(expectedChallenge, "ascii");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function validateAttemptId(value: string) {
  if (!ATTEMPT_ID_PATTERN.test(value)) {
    throw invalidNativeAttempt();
  }
}

function validateClientState(value: string) {
  if (
    value.length < 32 ||
    value.length > 128 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new HttpError(
      400,
      "native_auth_state_invalid",
      "Native authentication state is invalid.",
    );
  }
}

function validateHandoffCode(value: string) {
  if (value.length !== 43 || !BASE64URL_PATTERN.test(value)) {
    throw invalidNativeAttempt();
  }
}

function validateVerifier(value: string) {
  if (
    value.length < 43 ||
    value.length > 128 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw invalidNativeAttempt();
  }
}

function invalidNativeAttempt() {
  return new HttpError(
    400,
    "native_auth_attempt_invalid",
    "Native authentication attempt is invalid or expired.",
  );
}

async function rollback(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the authentication failure that caused the rollback.
  }
}
