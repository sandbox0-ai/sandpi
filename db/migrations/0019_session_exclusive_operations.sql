-- Session and Turn forks read a stable native/Workspace boundary while their
-- child Sandbox is being created. Keep ownership in PostgreSQL so unrelated
-- event reconciliation cannot make the source Session writable mid-fork.

ALTER TABLE session_runtime
    ADD COLUMN exclusive_operation_id TEXT,
    ADD COLUMN exclusive_operation_kind TEXT
        CHECK (exclusive_operation_kind IN ('session_fork', 'turn_fork')),
    ADD COLUMN exclusive_operation_started_at TIMESTAMPTZ,
    ADD CONSTRAINT session_runtime_exclusive_operation_coordinates_check CHECK (
        (
            exclusive_operation_id IS NULL
            AND exclusive_operation_kind IS NULL
            AND exclusive_operation_started_at IS NULL
        )
        OR
        (
            exclusive_operation_id IS NOT NULL
            AND exclusive_operation_kind IS NOT NULL
            AND exclusive_operation_started_at IS NOT NULL
        )
    );

CREATE INDEX session_runtime_exclusive_operation_idx
    ON session_runtime (exclusive_operation_started_at)
    WHERE exclusive_operation_id IS NOT NULL;

COMMENT ON COLUMN session_runtime.exclusive_operation_id IS
    'Opaque owner token for the one source-Session operation that excludes Turn and terminal writes.';
COMMENT ON COLUMN session_runtime.exclusive_operation_kind IS
    'Native/Workspace operation currently holding the source Session stable.';
