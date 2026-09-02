import { randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import type { EnvironmentAgentId } from "@/lib/types";
import { toUnixTimestamp } from "@/lib/time";
import { notFound } from "@/server/http-error";
import type { EncryptedValue } from "@/server/secrets";

interface AgentCredentialRow extends QueryResultRow {
  id: string;
  environment_id: string;
  harness: EnvironmentAgentId;
  revision: number;
  ciphertext: Buffer;
  initialization_vector: Buffer;
  authentication_tag: Buffer;
  encryption_algorithm: "aes-256-gcm";
  encryption_key_id: string;
  non_secret_metadata: Record<string, unknown>;
  binding_source_id?: string | null;
}

export interface StoredAgentCredential {
  environmentId: string;
  agentId: EnvironmentAgentId;
  sourceId: string;
  revision: number;
  encrypted: EncryptedValue;
  metadata: Record<string, unknown>;
  bindingSourceId?: string;
}

export class AgentCredentialStore {
  constructor(private readonly pool: Pool) {}

  async getCredential(
    userId: string,
    environmentId: string,
    agentId: EnvironmentAgentId,
  ) {
    const result = await this.pool.query<AgentCredentialRow>(
      `SELECT credential.*
       FROM harness_credentials credential
       JOIN environments environment
         ON environment.id = credential.environment_id
       WHERE credential.environment_id = $2
         AND credential.harness = $3
         AND credential.credential_slot = 'account'
         AND credential.revoked_at IS NULL
         AND environment.created_by_user_id = $1
         AND environment.harness = $3
         AND environment.status <> 'archived'
       LIMIT 1`,
      [userId, environmentId, agentId],
    );
    return result.rows[0]
      ? agentCredentialFromRow(result.rows[0])
      : undefined;
  }

  async getCredentialForRuntime(
    environmentId: string,
    agentId: EnvironmentAgentId,
  ) {
    const result = await this.pool.query<AgentCredentialRow>(
      `SELECT credential.*,
              binding.credential_source_id AS binding_source_id
       FROM harness_credentials credential
       JOIN environments environment
         ON environment.id = credential.environment_id
        AND environment.harness = credential.harness
       LEFT JOIN environment_credential_bindings binding
         ON binding.environment_id = credential.environment_id
        AND binding.harness = credential.harness
        AND binding.credential_slot = 'account'
       WHERE credential.environment_id = $1
         AND credential.harness = $2
         AND credential.credential_slot = 'account'
         AND credential.revoked_at IS NULL
         AND environment.status <> 'archived'
       LIMIT 1`,
      [environmentId, agentId],
    );
    return result.rows[0]
      ? agentCredentialFromRow(result.rows[0])
      : undefined;
  }

  async replaceCredentialFromRuntime(input: {
    environmentId: string;
    agentId: EnvironmentAgentId;
    credentialType: string;
    accountLabel: string;
    expectedSourceId?: string;
    encrypted: EncryptedValue;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const environment = await client.query<{
        credential_revision: number;
      }>(
        `SELECT credential_revision
         FROM environments
         WHERE id = $1 AND harness = $2 AND status <> 'archived'
         FOR UPDATE`,
        [input.environmentId, input.agentId],
      );
      const environmentRow = environment.rows[0];
      if (!environmentRow) {
        throw notFound(
          "environment_not_found",
          "Native Agent Environment not found.",
        );
      }
      const current = await client.query<AgentCredentialRow>(
        `SELECT * FROM harness_credentials
         WHERE environment_id = $1 AND harness = $2
           AND credential_slot = 'account' AND revoked_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [input.environmentId, input.agentId],
      );
      const currentRow = current.rows[0];
      if (
        currentRow &&
        (!input.expectedSourceId || currentRow.id !== input.expectedSourceId)
      ) {
        await client.query("COMMIT");
        return {
          replaced: false as const,
          credential: agentCredentialFromRow(currentRow),
        };
      }
      if (!currentRow && input.expectedSourceId) {
        throw new Error("The native Agent credential source was replaced.");
      }

      const revision = Number(environmentRow.credential_revision) + 1;
      const sourceId = `credential_${randomUUID()}`;
      await client.query(
        `UPDATE harness_credentials
         SET revoked_at = NOW(), updated_at = NOW()
         WHERE environment_id = $1 AND harness = $2
           AND credential_slot = 'account' AND revoked_at IS NULL`,
        [input.environmentId, input.agentId],
      );
      const inserted = await client.query<AgentCredentialRow>(
        `INSERT INTO harness_credentials (
           id, environment_id, harness, credential_slot, revision,
           credential_type, ciphertext, initialization_vector,
           authentication_tag, encryption_algorithm, encryption_key_id,
           non_secret_metadata, last_verified_at
         ) VALUES (
           $1, $2, $3, 'account', $4, $5, $6, $7, $8, $9, $10,
           $11::JSONB, NOW()
         )
         RETURNING *`,
        [
          sourceId,
          input.environmentId,
          input.agentId,
          revision,
          input.credentialType,
          input.encrypted.ciphertext,
          input.encrypted.initializationVector,
          input.encrypted.authenticationTag,
          input.encrypted.algorithm,
          input.encrypted.keyId,
          JSON.stringify({ type: "native-agent-file" }),
        ],
      );
      await client.query(
        `UPDATE environment_credential_bindings
         SET status = 'stale', updated_at = NOW()
         WHERE environment_id = $1 AND harness = $2
           AND credential_slot = 'account' AND status <> 'revoked'`,
        [input.environmentId, input.agentId],
      );
      await client.query(
        `UPDATE environments
         SET credential_revision = $3,
             harness_metadata = harness_metadata || $4::JSONB,
             updated_at = NOW()
         WHERE id = $1 AND harness = $2`,
        [
          input.environmentId,
          input.agentId,
          revision,
          JSON.stringify({
            status: "connected",
            account: input.accountLabel,
            lastVerified: toUnixTimestamp(new Date()),
          }),
        ],
      );
      await client.query("COMMIT");
      return {
        replaced: true as const,
        credential: agentCredentialFromRow(inserted.rows[0]!),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markCredentialMaterialized(input: {
    environmentId: string;
    agentId: EnvironmentAgentId;
    sourceId: string;
    sourceRevision: number;
    nativeTargetPath: string;
  }) {
    const result = await this.pool.query(
      `INSERT INTO environment_credential_bindings (
         id, environment_id, sandbox_id, credential_source_id, harness,
         credential_slot, source_revision, native_target_path, status
       )
       SELECT $1, environment.id, runtime.sandbox_id, credential.id, $3,
              'account', credential.revision, $6, 'active'
       FROM environments environment
       JOIN environment_runtime runtime
         ON runtime.environment_id = environment.id
        AND runtime.sandbox_id IS NOT NULL
       JOIN harness_credentials credential
         ON credential.id = $2
        AND credential.environment_id = environment.id
        AND credential.harness = $3
        AND credential.credential_slot = 'account'
        AND credential.revoked_at IS NULL
       WHERE environment.id = $4 AND credential.revision = $5
       ON CONFLICT (environment_id, harness, credential_slot) DO UPDATE
       SET sandbox_id = EXCLUDED.sandbox_id,
           credential_source_id = EXCLUDED.credential_source_id,
           source_revision = EXCLUDED.source_revision,
           native_target_path = EXCLUDED.native_target_path,
           status = 'active', materialized_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [
        `binding_${randomUUID()}`,
        input.sourceId,
        input.agentId,
        input.environmentId,
        input.sourceRevision,
        input.nativeTargetPath,
      ],
    );
    if (!result.rowCount) {
      throw new Error(
        "Native Agent credential cannot be bound to this Environment.",
      );
    }
  }
}

function agentCredentialFromRow(
  row: AgentCredentialRow,
): StoredAgentCredential {
  return {
    environmentId: row.environment_id,
    agentId: row.harness,
    sourceId: row.id,
    revision: Number(row.revision),
    encrypted: encryptedValue(row),
    metadata: row.non_secret_metadata,
    ...(row.binding_source_id
      ? { bindingSourceId: row.binding_source_id }
      : {}),
  };
}

function encryptedValue(row: AgentCredentialRow): EncryptedValue {
  return {
    ciphertext: row.ciphertext,
    initializationVector: row.initialization_vector,
    authenticationTag: row.authentication_tag,
    algorithm: row.encryption_algorithm,
    keyId: row.encryption_key_id,
  };
}
