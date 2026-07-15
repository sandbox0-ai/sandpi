-- Extend the durable Session-operation fence to runtime repair and native-state
-- migration. A heartbeat delays takeover after a database connection is lost
-- while an uninterruptible Sandbox0 call may still be completing.

ALTER TABLE session_runtime
    DROP CONSTRAINT session_runtime_exclusive_operation_coordinates_check,
    DROP CONSTRAINT session_runtime_exclusive_operation_kind_check,
    ADD COLUMN exclusive_operation_heartbeat_at TIMESTAMPTZ,
    ADD COLUMN native_state_migration_snapshot_id TEXT;

UPDATE session_runtime
SET exclusive_operation_heartbeat_at = exclusive_operation_started_at
WHERE exclusive_operation_id IS NOT NULL;

ALTER TABLE session_runtime
    ADD CONSTRAINT session_runtime_exclusive_operation_kind_check CHECK (
        exclusive_operation_kind IN (
            'session_fork',
            'turn_fork',
            'runtime_recovery',
            'native_state_migration'
        )
    ),
    ADD CONSTRAINT session_runtime_exclusive_operation_coordinates_check CHECK (
        (
            exclusive_operation_id IS NULL
            AND exclusive_operation_kind IS NULL
            AND exclusive_operation_started_at IS NULL
            AND exclusive_operation_heartbeat_at IS NULL
        )
        OR
        (
            exclusive_operation_id IS NOT NULL
            AND exclusive_operation_kind IS NOT NULL
            AND exclusive_operation_started_at IS NOT NULL
            AND exclusive_operation_heartbeat_at IS NOT NULL
        )
    ),
    ADD CONSTRAINT session_runtime_native_migration_snapshot_check CHECK (
        native_state_migration_snapshot_id IS NULL
        OR harness_state_layout = 'migrating'
    );

CREATE INDEX session_runtime_exclusive_operation_heartbeat_idx
    ON session_runtime (exclusive_operation_heartbeat_at)
    WHERE exclusive_operation_id IS NOT NULL;

COMMENT ON COLUMN session_runtime.exclusive_operation_heartbeat_at IS
    'Last point before the owner entered a fenced external Sandbox0 operation; stale takeover waits beyond its maximum completion window.';
COMMENT ON COLUMN session_runtime.native_state_migration_snapshot_id IS
    'Recoverable Volume baseline created while rootfs-backed native state is migrating; never conversation content.';
