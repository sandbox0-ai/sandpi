-- Move the native coding-agent state authority into the Session Workspace
-- Volume. Existing Sessions remain rootfs_v1 until the runtime migrator has
-- copied and verified their native state.

ALTER TABLE session_runtime
    RENAME COLUMN native_branch_revision TO history_revision;

ALTER TABLE session_runtime
    ADD COLUMN harness_state_layout TEXT NOT NULL DEFAULT 'rootfs_v1'
        CHECK (harness_state_layout IN ('rootfs_v1', 'workspace_v2', 'migrating')),
    ADD COLUMN head_volume_snapshot_id TEXT;

UPDATE session_runtime runtime
SET head_volume_snapshot_id = (
    SELECT checkpoint.workspace_snapshot_id
    FROM session_turn_checkpoints checkpoint
    WHERE checkpoint.session_id = runtime.session_id
      AND checkpoint.workspace_volume_id = runtime.workspace_volume_id
      AND checkpoint.status = 'ready'
      AND checkpoint.workspace_snapshot_id IS NOT NULL
    ORDER BY checkpoint.ordinal DESC
    LIMIT 1
);

COMMENT ON COLUMN session_runtime.history_revision IS
    'Monotonic native-history revision used to reject stale snapshots even when the native Session id remains unchanged.';
COMMENT ON COLUMN session_runtime.harness_state_layout IS
    'Durable native-state layout. rootfs_v1 Sessions require an online migration before Workspace history restore is safe.';
COMMENT ON COLUMN session_runtime.head_volume_snapshot_id IS
    'Latest committed point-in-time snapshot of this Session immutable Workspace Volume, including native harness state for workspace_v2.';

ALTER TABLE session_turn_checkpoints
    ADD COLUMN includes_native_state BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN session_turn_checkpoints.includes_native_state IS
    'True only when both Workspace files and the native harness state are present in this Volume snapshot boundary.';

ALTER TABLE session_turn_mutations
    ADD COLUMN workspace_volume_id TEXT,
    ADD COLUMN expected_history_revision BIGINT,
    ADD COLUMN result_native_session_id TEXT,
    ADD COLUMN replacement_native_turn_id TEXT,
    ADD COLUMN candidate_terminal_status TEXT
        CHECK (candidate_terminal_status IN ('completed', 'failed', 'interrupted')),
    ADD COLUMN candidate_supervisor_session_id TEXT,
    ADD COLUMN candidate_supervisor_sequence BIGINT
        CHECK (candidate_supervisor_sequence IS NULL OR candidate_supervisor_sequence >= 0);

UPDATE session_turn_mutations mutation
SET workspace_volume_id = runtime.workspace_volume_id,
    expected_history_revision = runtime.history_revision,
    result_native_session_id = COALESCE(
        mutation.replacement_native_session_id,
        mutation.original_native_session_id
    )
FROM session_runtime runtime
WHERE runtime.session_id = mutation.session_id;

ALTER TABLE session_turn_mutations
    ALTER COLUMN workspace_volume_id SET NOT NULL,
    ALTER COLUMN expected_history_revision SET NOT NULL,
    ADD CONSTRAINT session_turn_mutations_expected_history_revision_check
        CHECK (expected_history_revision >= 0);

ALTER TABLE session_turn_mutations
    DROP CONSTRAINT session_turn_mutations_phase_check;

UPDATE session_turn_mutations
SET phase = CASE phase
    WHEN 'restoring' THEN 'restored'
    WHEN 'branched' THEN 'replacement_started'
    ELSE phase
END;

ALTER TABLE session_turn_mutations
    ADD CONSTRAINT session_turn_mutations_phase_check CHECK (
        phase IN (
            'prepared',
            'restore_requested',
            'restored',
            'replacement_started',
            'compensating',
            'failed'
        )
    ),
    DROP COLUMN replacement_native_session_id,
    DROP COLUMN branch_through_native_turn_id;

COMMENT ON TABLE session_turn_mutations IS
    'Crash-recovery journal for same-native-Session history restore. It stores Volume and CAS coordinates, never conversation content.';
COMMENT ON COLUMN session_turn_mutations.workspace_volume_id IS
    'Immutable Session Volume that owns both restore and compensation snapshots.';
COMMENT ON COLUMN session_turn_mutations.expected_history_revision IS
    'History revision captured before the external Volume restore and checked again at commit.';
COMMENT ON COLUMN session_turn_mutations.result_native_session_id IS
    'Native Session verified after restore. Normally unchanged; the unmaterialized first Turn may require native thread/start.';
COMMENT ON COLUMN session_turn_mutations.replacement_native_turn_id IS
    'Native Turn accepted after an edit restore; null for delete and before replacement start.';
COMMENT ON COLUMN session_turn_mutations.candidate_terminal_status IS
    'Terminal replacement status observed before the same-native-Session history rewrite becomes canonical.';
