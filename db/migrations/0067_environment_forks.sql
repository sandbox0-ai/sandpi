-- Environment forks are external Sandbox0 mutations. Journal the target
-- before calling Sandbox0 so retries can resume the same product resource and
-- the target cannot be picked up by ordinary Environment provisioning.

CREATE TABLE environment_fork_operations (
    target_environment_id TEXT PRIMARY KEY
        REFERENCES environments(id) ON DELETE CASCADE,
    source_environment_id TEXT
        REFERENCES environments(id) ON DELETE SET NULL,
    source_snapshot_id TEXT,
    operation_id TEXT NOT NULL UNIQUE CHECK (
        LENGTH(operation_id) BETWEEN 1 AND 200
        AND operation_id !~ '[[:cntrl:]]'
    ),
    sandbox_id TEXT UNIQUE,
    phase TEXT NOT NULL DEFAULT 'prepared'
        CHECK (phase IN ('prepared', 'forking', 'native-ready', 'completed', 'failed')),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (phase IN ('prepared', 'forking', 'failed'))
        OR sandbox_id IS NOT NULL
    )
);

CREATE INDEX environment_fork_operations_source_idx
    ON environment_fork_operations (source_environment_id, created_at DESC);

CREATE INDEX environment_fork_operations_recovery_idx
    ON environment_fork_operations (phase, updated_at)
    WHERE phase NOT IN ('completed', 'failed');

CREATE TRIGGER environment_fork_operations_set_updated_at
    BEFORE UPDATE ON environment_fork_operations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE environment_fork_operations IS
    'Durable saga joining one Sandpi Environment target to one idempotent Sandbox0 fork operation.';
COMMENT ON COLUMN environment_fork_operations.operation_id IS
    'Stable, non-secret operation identity forwarded as Sandbox0 Idempotency-Key.';
