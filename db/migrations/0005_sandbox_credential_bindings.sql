COMMENT ON TABLE harness_credentials IS
    'Environment-scoped Credential Sources. Only encrypted native harness artifacts are persisted; plaintext must never enter PostgreSQL.';

CREATE TABLE sandbox_credential_bindings (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sandbox_id TEXT NOT NULL,
    credential_source_id TEXT NOT NULL REFERENCES harness_credentials(id) ON DELETE RESTRICT,
    harness TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    native_target_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'stale', 'revoked')),
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, harness),
    UNIQUE (sandbox_id, harness),
    CHECK (native_target_path LIKE '/%'),
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX sandbox_credential_bindings_source_idx
    ON sandbox_credential_bindings (credential_source_id, status);

COMMENT ON TABLE sandbox_credential_bindings IS
    'Sandbox-scoped materialization of one Environment Credential Source revision. Bindings never contain plaintext credentials.';
COMMENT ON COLUMN sandbox_credential_bindings.native_target_path IS
    'Ephemeral path inside the bound Sandbox; it must stay outside rootfs and Workspace Volume snapshot boundaries.';

-- Backfill runtimes created before explicit bindings were introduced. The
-- active native artifact was already materialized at this path when the
-- Session Sandbox was provisioned.
INSERT INTO sandbox_credential_bindings (
    id, session_id, sandbox_id, credential_source_id, harness,
    source_revision, native_target_path, status, metadata
)
SELECT
    'binding_' || gen_random_uuid()::TEXT,
    s.id,
    r.sandbox_id,
    c.id,
    s.harness,
    c.revision,
    '/dev/shm/sandpi-codex-auth.json',
    'active',
    '{"backfilled":true}'::JSONB
FROM sessions s
JOIN session_runtime r
  ON r.session_id = s.id
 AND r.sandbox_id IS NOT NULL
JOIN LATERAL (
    SELECT source.id, source.revision
    FROM harness_credentials source
    WHERE source.environment_id = s.environment_id
      AND source.harness = s.harness
      AND source.revoked_at IS NULL
    ORDER BY source.revision DESC
    LIMIT 1
) c ON TRUE
ON CONFLICT (session_id, harness) DO NOTHING;

CREATE TRIGGER sandbox_credential_bindings_set_updated_at
BEFORE UPDATE ON sandbox_credential_bindings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
