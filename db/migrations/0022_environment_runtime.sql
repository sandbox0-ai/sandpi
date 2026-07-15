-- One Environment owns one Sandbox, Workspace Volume, and native harness
-- process. Product Sessions are lightweight references to harness-native
-- Sessions inside that Environment; PostgreSQL never stores their transcript.

DROP TABLE IF EXISTS session_turn_mutations;
DROP TABLE IF EXISTS session_turn_checkpoints;

DROP TRIGGER IF EXISTS session_runtime_prevent_allocation_rebind ON session_runtime;
DROP FUNCTION IF EXISTS prevent_session_allocation_rebind();

ALTER TABLE session_runtime RENAME TO legacy_session_runtime;
-- PostgreSQL keeps index names unchanged when their table is renamed. Release
-- the one name reused by the thin replacement table before creating it.
DROP INDEX IF EXISTS session_runtime_pending_turn_idx;

CREATE TABLE environment_runtime (
    environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
    sandbox_id TEXT,
    supervisor_session_id TEXT,
    terminal_session_id TEXT,
    supervisor_cursor BIGINT NOT NULL DEFAULT 0 CHECK (supervisor_cursor >= 0),
    stdout_tail TEXT NOT NULL DEFAULT '',
    attempt_id TEXT,
    runtime_generation BIGINT NOT NULL DEFAULT 0 CHECK (runtime_generation >= 0),
    desired_state TEXT NOT NULL DEFAULT 'running'
        CHECK (desired_state IN ('running', 'paused', 'terminated')),
    observed_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (observed_state IN (
            'pending', 'provisioning', 'running', 'paused', 'terminated', 'failed'
        )),
    provisioning_error TEXT,
    last_event_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        supervisor_session_id IS NULL
        OR sandbox_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX environment_runtime_sandbox_unique_idx
    ON environment_runtime (sandbox_id)
    WHERE sandbox_id IS NOT NULL;

CREATE INDEX environment_runtime_supervisor_idx
    ON environment_runtime (supervisor_session_id)
    WHERE supervisor_session_id IS NOT NULL;

CREATE TRIGGER environment_runtime_set_updated_at
    BEFORE UPDATE ON environment_runtime
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE session_runtime (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    native_session_id TEXT,
    model_id TEXT,
    history_revision BIGINT NOT NULL DEFAULT 0 CHECK (history_revision >= 0),
    active_native_turn_id TEXT,
    pending_turn_request_id TEXT,
    pending_turn_client_message_id TEXT,
    pending_turn_stable_input_id TEXT,
    pending_turn_phase TEXT
        CHECK (pending_turn_phase IN ('prepared', 'submitted', 'accepted')),
    pending_turn_native_turn_id TEXT,
    pending_turn_started_at TIMESTAMPTZ,
    runtime_error_code TEXT,
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (pending_turn_phase IS NULL
         AND pending_turn_request_id IS NULL
         AND pending_turn_client_message_id IS NULL
         AND pending_turn_stable_input_id IS NULL
         AND pending_turn_native_turn_id IS NULL
         AND pending_turn_started_at IS NULL)
        OR
        (pending_turn_phase IS NOT NULL
         AND pending_turn_request_id IS NOT NULL
         AND pending_turn_stable_input_id IS NOT NULL
         AND pending_turn_started_at IS NOT NULL)
    ),
    CHECK (
        pending_turn_native_turn_id IS NULL
        OR pending_turn_phase = 'accepted'
    )
);

CREATE UNIQUE INDEX session_runtime_native_session_unique_idx
    ON session_runtime (native_session_id)
    WHERE native_session_id IS NOT NULL;

CREATE INDEX session_runtime_pending_turn_idx
    ON session_runtime (pending_turn_started_at)
    WHERE pending_turn_phase IS NOT NULL;

CREATE TRIGGER session_runtime_set_updated_at
    BEFORE UPDATE ON session_runtime
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Existing Sessions were bound to isolated Sandboxes and Volumes. Their
-- native rollouts cannot be silently rebound to a shared Environment runtime,
-- so keep the opaque id for diagnosis and fail them explicitly. New Sessions
-- use the Environment runtime immediately.
INSERT INTO session_runtime (
    session_id, native_session_id, model_id, history_revision,
    runtime_error_code, created_at, updated_at
)
SELECT
    session_id, native_session_id, model_id, history_revision,
    'legacy_isolated_runtime', created_at, updated_at
FROM legacy_session_runtime;

UPDATE sessions
SET status = 'failed',
    metadata = metadata || '{"runtimeMigration":"legacy-isolated-runtime"}'::JSONB
WHERE id IN (SELECT session_id FROM legacy_session_runtime);

DROP TABLE legacy_session_runtime;

DROP TABLE sandbox_credential_bindings;

CREATE TABLE environment_credential_bindings (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL UNIQUE REFERENCES environments(id) ON DELETE CASCADE,
    sandbox_id TEXT NOT NULL,
    credential_source_id TEXT NOT NULL REFERENCES harness_credentials(id) ON DELETE RESTRICT,
    harness TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    native_target_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'stale', 'revoked')),
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX environment_credential_bindings_source_idx
    ON environment_credential_bindings (credential_source_id, status);

CREATE TRIGGER environment_credential_bindings_set_updated_at
    BEFORE UPDATE ON environment_credential_bindings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE sessions DROP COLUMN IF EXISTS rootfs_snapshot_id;
ALTER TABLE sessions DROP COLUMN IF EXISTS hard_expires_at;

DROP INDEX IF EXISTS sessions_hard_expires_idx;

-- A previously ready Environment only had a baseline Volume. Reconciliation
-- claims its one shared Sandbox after this migration.
UPDATE environments
SET status = 'updating', provisioning_error = NULL
WHERE status = 'ready';

COMMENT ON TABLE environment_runtime IS
    'One shared Sandbox and Supervisor per Environment. Workspace, terminal, audit, and metrics are Environment-scoped.';
COMMENT ON COLUMN session_runtime.native_session_id IS
    'Opaque coding-agent native Session id. The native harness is the only conversation store.';
COMMENT ON COLUMN session_runtime.history_revision IS
    'Increments when edit or delete switches the product Session to a native branch.';
